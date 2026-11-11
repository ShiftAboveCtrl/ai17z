import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Capability, PipelineEdge, PipelineNode } from '@xbam/shared/contracts';
import { PolicyConfig } from '@xbam/shared/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  createLogger,
  randomToken,
  sha256Hex,
} from '@xbam/shared';
import {
  accountLease,
  accounts as accountsRepo,
  actions as actionsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  devUpdates as repo,
  events as eventsRepo,
  isUniqueViolation,
  jobs as jobsRepo,
  observability,
  ops,
  pipelines as pipelinesRepo,
  prompts as promptsRepo,
  withTransaction,
  type DevUpdateProjectRow,
  type DevUpdateRow,
  type DevUpdateStatus,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { approveJob, cancelJob, rejectJob } from './approvals';
import { forgetPostMedia, mediaRefsProblem, storePostMedia, type PostMediaRef } from './postMedia';
import { validateOutput } from './validator';
import {
  DevUpdateSubmissionInput,
  checkFacts,
  checkPostText,
  composePost,
  evidenceKeys,
  factFingerprint,
  textFingerprint,
  type DevUpdateRefusal,
} from './devUpdateSafety';

const log = createLogger('dev-updates');

/**
 * Development updates: a project's own assistant tells the agent what shipped.
 *
 * The flow, end to end:
 *
 * 1. The owner maps a project key to an agent and an account it may post
 *    through, and receives a sender token for that one project.
 * 2. The sender (a coding assistant, through the MCP tool) submits explicit,
 *    public facts: what changed, why it matters, and evidence. Nothing is read
 *    from a repository. Facts that fail a safety rule are refused and not
 *    stored.
 * 3. In DRAFT mode the owner approves or rejects the exact post. In AUTO mode
 *    it is approved on submission.
 * 4. The dispatcher hands approved updates to the agent's ordinary pipeline, at
 *    most `daily_cap` a day and `min_spacing_minutes` apart, as a POST job that
 *    starts at the approval gate with the reviewed text already in place. From
 *    there the capability re-check, the account cadence and quiet hours, the
 *    rate policy, the kill switch, duplicate suppression and the recovery
 *    read-back all apply exactly as they do to any other post.
 * 5. The reconciler reads the job back and records what really happened:
 *    published with a link, rehearsed, skipped as a duplicate, or failed with
 *    the reason the pipeline gave.
 *
 * What is approved is what is published. Nothing regenerates the text after a
 * person has read it.
 */

/** Ten open is a backlog nobody is reading. Past it the sender is told to wait. */
const MAX_OPEN_UPDATES = 10;

const SENDER_TOKEN_PREFIX = 'ai17z_dus_';

/*
  Two switches can make a hand-over a rehearsal, and an owner who turned off
  the one they know about has to be told when the other one held it. A new
  agent's policy rehearses by default, so `--rehearse false` alone leaves a
  fresh mapping rehearsing, and "turn rehearsal off" is no help to somebody who
  just did.
*/
const REHEARSAL_BY_PROJECT = 'Handed to the agent as a rehearsal because this project rehearses: it will be checked end to end and not published.';
const REHEARSAL_BY_AGENT =
  "Handed to the agent as a rehearsal because the agent's own policy runs everything as a dry run by default: it will be checked end to end and not published.";
const REHEARSED_BY_PROJECT =
  'Rehearsed: checked end to end and not published, because this project rehearses. Turn rehearsal off for the project to publish.';
const REHEARSED_BY_AGENT =
  "Rehearsed: checked end to end and not published, because the agent's own policy runs everything as a dry run by default. Turn off dry run by default in the agent's automation settings to publish.";

export const DevUpdateProjectInput = z.object({
  projectKey: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{1,62}$/, 'Use 2 to 63 lower case letters, digits, dots, dashes or underscores.'),
  displayName: z.string().trim().min(1).max(80),
  agentId: z.uuid(),
  accountId: z.uuid(),
  mode: z.enum(['DRAFT', 'AUTO']).default('DRAFT'),
  enabled: z.boolean().default(true),
  dailyCap: z.number().int().min(1).max(6).default(2),
  minSpacingMinutes: z.number().int().min(30).max(1440).default(240),
  rehearse: z.boolean().default(true),
});
export type DevUpdateProjectInput = z.infer<typeof DevUpdateProjectInput>;

export const DevUpdateProjectPatch = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    agentId: z.uuid(),
    accountId: z.uuid(),
    mode: z.enum(['DRAFT', 'AUTO']),
    enabled: z.boolean(),
    dailyCap: z.number().int().min(1).max(6),
    minSpacingMinutes: z.number().int().min(30).max(1440),
    rehearse: z.boolean(),
  })
  .partial()
  .strict();
export type DevUpdateProjectPatch = z.infer<typeof DevUpdateProjectPatch>;

export const DevUpdateDecisionInput = z
  .object({
    editedText: z.string().trim().min(1).max(400).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

// ── Views ───────────────────────────────────────────────────────────────────

export function projectView(row: DevUpdateProjectRow) {
  return {
    id: row.id,
    projectKey: row.projectKey,
    displayName: row.displayName,
    agentId: row.agentId,
    accountId: row.accountId,
    mode: row.mode,
    enabled: row.enabled,
    dailyCap: row.dailyCap,
    minSpacingMinutes: row.minSpacingMinutes,
    rehearse: row.rehearse,
    senderToken: row.senderTokenHash
      ? { active: true, hint: row.senderTokenHint, issuedAt: row.senderTokenIssuedAt }
      : { active: false, hint: null, issuedAt: null },
    lastDispatchReason: row.lastDispatchReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** What the sender may see of its own project: the rules, never the wiring. */
export function senderProjectView(row: DevUpdateProjectRow) {
  return {
    projectKey: row.projectKey,
    displayName: row.displayName,
    mode: row.mode,
    enabled: row.enabled,
    dailyCap: row.dailyCap,
    minSpacingMinutes: row.minSpacingMinutes,
    rehearse: row.rehearse,
    lastDispatchReason: row.lastDispatchReason,
  };
}

export function updateView(row: DevUpdateRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    why: row.why,
    evidence: row.evidence,
    post: row.approvedText ?? row.postText,
    // What goes out with it, for the owner to look at before approving. The
    // address is the artifact route, which needs the owner's own session.
    media: (row.media ?? []).map((m) => ({
      artifactId: m.artifactId,
      kind: m.kind,
      mime: m.mime,
      bytes: m.bytes,
      url: `/api/artifacts/${m.artifactId}`,
    })),
    proposedPost: row.postText,
    edited: row.approvedText !== null && row.approvedText !== row.postText,
    status: row.status,
    reason: row.statusReason,
    url: row.remoteUrl,
    jobId: row.jobId,
    history: row.history,
    decidedAt: row.decidedAt,
    dispatchedAt: row.dispatchedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function senderUpdateView(row: DevUpdateRow) {
  const { jobId: _jobId, ...rest } = updateView(row);
  return rest;
}

// ── Credentials ─────────────────────────────────────────────────────────────

function issueSenderToken(): { token: string; hash: string; hint: string } {
  const token = `${SENDER_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hash: sha256Hex(token), hint: token.slice(-4) };
}

/**
 * Resolves a sender token to the one project it speaks for, or refuses.
 *
 * A session token presented here finds nothing, and a sender token presented
 * to an owner route finds nothing there either: the two are looked up in
 * different tables, so neither can stand in for the other.
 */
export async function authenticateSender(token: string | null): Promise<DevUpdateProjectRow> {
  if (!token || !token.startsWith(SENDER_TOKEN_PREFIX)) {
    throw new UnauthorizedError('A development update sender token is required.');
  }
  const project = await repo.findProjectByTokenHash(sha256Hex(token));
  if (!project) throw new UnauthorizedError('That sender token is not valid. Ask the owner for a new one.');
  return project;
}

// ── The mapping ─────────────────────────────────────────────────────────────

/**
 * Whether an agent may post through an account on this owner's behalf.
 *
 * Checked when a project is created or rewired, and again before every
 * dispatch, because a link removed or a grant revoked in between has to stop
 * the update rather than be discovered by the executor.
 */
async function mappingProblem(ownerId: string, agentId: string, accountId: string): Promise<string | null> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent || agent.ownerId !== ownerId) return 'That agent does not exist or belongs to another owner.';
  const account = await accountsRepo.getAccount(accountId);
  if (!account || account.ownerId !== ownerId) return 'That account does not exist or belongs to another owner.';
  if (!account.enabled) return `@${account.handle} is disabled.`;
  const link = (await accountsRepo.listAgentAccounts(agentId)).find((l) => l.accountId === accountId);
  if (!link) return `${agent.name} is not connected to @${account.handle}. Connect them first.`;
  if (!link.enabled) return `The connection between ${agent.name} and @${account.handle} is switched off.`;
  if (!getChannelAdapter(account.channel).capabilities.includes('POST')) {
    return `The ${account.channel} channel cannot post.`;
  }
  const grants = await capabilitiesRepo.grantsFor(agentId, accountId);
  if (!grants.has('POST' as Capability)) {
    return `${agent.name} is not permitted to POST through @${account.handle}. Grant POST on the account first.`;
  }
  return null;
}

async function ownedProject(ownerId: string, projectId: string): Promise<DevUpdateProjectRow> {
  const project = await repo.getProject(projectId);
  if (!project) throw new NotFoundError('Development update project');
  if (project.ownerUserId !== ownerId) throw new ForbiddenError('That project belongs to another owner.');
  return project;
}

export async function createDevUpdateProject(ownerId: string, raw: unknown) {
  const input = DevUpdateProjectInput.parse(raw);
  const problem = await mappingProblem(ownerId, input.agentId, input.accountId);
  if (problem) throw new ConflictError(problem);
  if (await repo.findProjectByKey(ownerId, input.projectKey)) {
    throw new ConflictError(`A project called "${input.projectKey}" already exists.`);
  }
  const credential = issueSenderToken();
  let row: DevUpdateProjectRow;
  try {
    row = await repo.createProject({
      ownerUserId: ownerId,
      ...input,
      senderTokenHash: credential.hash,
      senderTokenHint: credential.hint,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`A project called "${input.projectKey}" already exists.`);
    throw error;
  }
  await ops.audit({
    actorUserId: ownerId,
    action: 'dev_updates.project_created',
    entityType: 'dev_update_project',
    entityId: row.id,
    data: { projectKey: row.projectKey, mode: row.mode, rehearse: row.rehearse, dailyCap: row.dailyCap },
  });
  // The only time the token exists outside the client that will hold it.
  return { project: projectView(row), senderToken: credential.token };
}

export async function updateDevUpdateProject(ownerId: string, projectId: string, raw: unknown) {
  const patch = DevUpdateProjectPatch.parse(raw);
  const project = await ownedProject(ownerId, projectId);
  if (patch.agentId || patch.accountId) {
    const problem = await mappingProblem(ownerId, patch.agentId ?? project.agentId, patch.accountId ?? project.accountId);
    if (problem) throw new ConflictError(problem);
  }
  const row = await repo.updateProject(project.id, patch);
  await ops.audit({
    actorUserId: ownerId,
    action: 'dev_updates.project_updated',
    entityType: 'dev_update_project',
    entityId: row.id,
    data: { changed: Object.keys(patch), mode: row.mode, rehearse: row.rehearse, enabled: row.enabled },
  });
  return projectView(row);
}

export async function rotateSenderToken(ownerId: string, projectId: string) {
  const project = await ownedProject(ownerId, projectId);
  const credential = issueSenderToken();
  const row = await repo.setSenderToken(project.id, credential.hash, credential.hint);
  await ops.audit({ actorUserId: ownerId, action: 'dev_updates.token_rotated', entityType: 'dev_update_project', entityId: row.id });
  return { project: projectView(row), senderToken: credential.token };
}

export async function revokeSenderToken(ownerId: string, projectId: string) {
  const project = await ownedProject(ownerId, projectId);
  const row = await repo.setSenderToken(project.id, null, null);
  await ops.audit({ actorUserId: ownerId, action: 'dev_updates.token_revoked', entityType: 'dev_update_project', entityId: row.id });
  return projectView(row);
}

// ── Connecting a coding assistant ───────────────────────────────────────────

/** The name the MCP server is registered under, so every copy of the command agrees. */
export const DEV_UPDATES_MCP_NAME = 'ai17z-dev-updates';

/**
 * Where this installation's MCP server file is, for a command an owner can paste.
 *
 * A browser cannot know where AI17Z is installed, and a command with a
 * placeholder in it is a command that fails on first paste. The file ships
 * beside the runtime (`tools/` is in every package), so the path is derived
 * from this module, never stored, and checked to exist. Inside a container it
 * is the container's path, which means nothing on the machine Claude Code runs
 * on, so it is not offered.
 */
export interface ConnectionProbe {
  /** Whether this process runs inside a container. */
  inContainer: () => boolean;
  exists: (path: string) => boolean;
}

const HOST_PROBE: ConnectionProbe = { inContainer: () => existsSync('/.dockerenv'), exists: existsSync };

export function devUpdateConnection(probe: ConnectionProbe = HOST_PROBE): {
  serverName: string;
  mcpServerPath: string | null;
  reason: string | null;
} {
  const path = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'dev-updates-mcp.mjs');
  if (probe.inContainer()) {
    return {
      serverName: DEV_UPDATES_MCP_NAME,
      mcpServerPath: null,
      reason: 'This AI17Z runs in a container, so its copy of the MCP server is not on your machine. Use tools/dev-updates-mcp.mjs from a copy of AI17Z on the machine where your coding assistant runs.',
    };
  }
  if (!probe.exists(path)) {
    return {
      serverName: DEV_UPDATES_MCP_NAME,
      mcpServerPath: null,
      reason: 'The MCP server file is missing from this installation. Reinstall or update AI17Z to restore tools/dev-updates-mcp.mjs.',
    };
  }
  return { serverName: DEV_UPDATES_MCP_NAME, mcpServerPath: path, reason: null };
}

export async function listDevUpdateProjects(ownerId: string) {
  return (await repo.listProjects(ownerId)).map(projectView);
}

export async function getDevUpdateProject(ownerId: string, projectId: string) {
  return projectView(await ownedProject(ownerId, projectId));
}

// ── Submitting ──────────────────────────────────────────────────────────────

/**
 * Thrown when a submission breaks a rule. Carries the rules, never the text.
 */
export class DevUpdateRefusedError extends ValidationError {
  readonly refusals: DevUpdateRefusal[];
  constructor(refusals: DevUpdateRefusal[]) {
    super(
      `This update cannot be shared: ${refusals.map((r) => r.message).join(' ')}`,
      { refusals: refusals.map((r) => ({ code: r.code, field: r.field, message: r.message })) },
    );
    this.refusals = refusals;
  }
}

async function policyFor(agentId: string): Promise<PolicyConfig> {
  const row = await agentsRepo.getActivePolicy(agentId);
  return PolicyConfig.parse(row?.config ?? {});
}

/**
 * The same hard rules the pipeline's validator applies to anything the agent
 * says, plus the development update rules. Soft findings are not refusals:
 * the validator's output is what goes forward, so a stripped dash stays
 * stripped.
 */
interface PublishRules {
  policy: PolicyConfig;
  operatorText: string;
}

async function publishRules(agentId: string): Promise<PublishRules> {
  const persona = await agentsRepo.getActivePersona(agentId);
  return {
    policy: await policyFor(agentId),
    operatorText: [persona?.biography, persona?.customInstructions].filter(Boolean).join('\n'),
  };
}

async function checkPublishable(agentId: string, text: string): Promise<ReturnType<typeof checkAgainst>> {
  return checkAgainst(await publishRules(agentId), text);
}

/** Synchronous, so it can run inside a transaction on rules read before it. */
function checkAgainst(
  rules: PublishRules,
  text: string,
): { output: string; refusals: DevUpdateRefusal[]; reviews: string[] } {
  const refusals = checkPostText(text);
  const reviews: string[] = [];
  const validation = validateOutput(text, rules.policy, null, rules.operatorText);
  for (const violation of validation.violations) {
    if (violation.severity === 'REJECT') {
      refusals.push({ code: 'NOT_MEANINGFUL', field: 'post', message: `The agent's policy refuses this post: ${violation.message}` });
    } else if (violation.severity === 'REVIEW') {
      // Not a refusal: a person may decide it is fine. Never something auto
      // mode decides on the owner's behalf.
      reviews.push(violation.message);
    }
  }
  return { output: validation.output, refusals, reviews };
}

/** Files a sender has uploaded and not yet attached to an update. More than this is a leak. */
const MAX_UNATTACHED_MEDIA = 8;
/** An uploaded file nobody attached is removed after this long. */
const UNATTACHED_MEDIA_HOURS = 24;

/**
 * A sender uploads a picture or a video before it submits the update that
 * carries it. The bytes are identified and capped here (`validateMedia`), held
 * as an artifact scoped to this project, and answered with an id; nothing is
 * public until an owner approves the update that names it.
 */
export async function uploadSenderMedia(project: DevUpdateProjectRow, bytes: unknown) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new ValidationError(
      'Send the file itself as the request body, with its content-type: image/png, image/jpeg, image/gif, image/webp, video/mp4 or video/quicktime.',
    );
  }
  const account = await accountsRepo.getAccount(project.accountId);
  if (!account || !getChannelAdapter(account.channel).supportsMedia) {
    throw new ValidationError('The account this project posts through cannot attach pictures or video.');
  }
  if ((await repo.countUnattachedMedia(project.id)) >= MAX_UNATTACHED_MEDIA) {
    throw new ConflictError(
      `${MAX_UNATTACHED_MEDIA} uploaded files are already waiting for an update. Attach them to one, or wait: unattached files are removed after ${UNATTACHED_MEDIA_HOURS} hours.`,
    );
  }
  // A file that is not what it claims, or too big, is a 400 that says why.
  const ref: PostMediaRef = await storePostMedia({ agentId: project.agentId, bytes, scope: { devUpdateProjectId: project.id } });
  await ops.audit({
    actorUserId: null,
    action: 'dev_updates.media_uploaded',
    entityType: 'dev_update_project',
    entityId: project.id,
    data: { kind: ref.kind, bytes: ref.bytes },
  });
  return { id: ref.artifactId, kind: ref.kind, mime: ref.mime, bytes: ref.bytes };
}

/** Removes uploads that were never attached to an update. Housekeeping on the worker tick. */
export async function sweepUnattachedMedia(): Promise<number> {
  const ids = await repo.staleUnattachedMedia(UNATTACHED_MEDIA_HOURS);
  if (ids.length > 0) await forgetPostMedia(ids);
  return ids.length;
}

export type SubmitOutcome =
  | { outcome: 'ACCEPTED'; update: ReturnType<typeof senderUpdateView> }
  | { outcome: 'DUPLICATE'; reason: string; update: ReturnType<typeof senderUpdateView> | null };

export async function submitDevUpdate(project: DevUpdateProjectRow, raw: unknown): Promise<SubmitOutcome> {
  const input = DevUpdateSubmissionInput.parse(raw);
  if (input.projectKey !== project.projectKey) {
    throw new ForbiddenError('This sender token belongs to a different project.');
  }

  const refusals = checkFacts(input);
  const fact = factFingerprint(input.kind, input.title);
  // Only compose once the facts are known to be safe, so a refused secret is
  // never assembled into anything.
  let postText = '';
  let reviews: string[] = [];
  if (refusals.length === 0) {
    const proposed = input.post ?? composePost(input, project.displayName, fact);
    const checked = await checkPublishable(project.agentId, proposed);
    refusals.push(...checked.refusals);
    postText = checked.output;
    reviews = checked.reviews;
  }
  if (refusals.length > 0) {
    // Codes only. The words that were refused go nowhere.
    const codes = [...new Set(refusals.map((r) => r.code))];
    log.info('development update refused', { projectId: project.id, codes });
    await ops.audit({
      actorUserId: null,
      action: 'dev_updates.refused',
      entityType: 'dev_update_project',
      entityId: project.id,
      data: { codes, fields: [...new Set(refusals.map((r) => r.field))] },
    });
    throw new DevUpdateRefusedError(refusals);
  }

  const mediaIds = [...new Set(input.mediaIds ?? [])];
  if (mediaIds.length > 0) {
    const account = await accountsRepo.getAccount(project.accountId);
    if (!account || !getChannelAdapter(account.channel).supportsMedia) {
      throw new ValidationError('The account this project posts through cannot attach pictures or video, so nothing was stored.');
    }
  }

  const keys = evidenceKeys(input.evidence);
  // Only a hash of the sender's request id is kept: it is free text, and its
  // job is matching a retry, which a hash does as well.
  const requestKey = input.clientRequestId ? sha256Hex(`dev-update-request:${input.clientRequestId}`) : null;

  const outcome = await withTransaction(async (tx): Promise<SubmitOutcome> => {
    // The mode is read under the lock, from the row as it is now. The project
    // the token resolved to was read before, and an owner switching back to
    // draft in between must not be outvoted by that older copy.
    const current = await repo.lockProject(tx, project.id);
    if (!current) throw new NotFoundError('Development update project');
    // Auto mode is standing approval for what the agent's policy would let
    // through unasked, and no further: a finding the validator would send to a
    // person still goes to the owner.
    const status: DevUpdateStatus = current.mode === 'AUTO' && reviews.length === 0 ? 'APPROVED' : 'PENDING_REVIEW';
    const reason =
      status === 'APPROVED'
        ? 'Approved automatically (this project is in auto mode). Waiting for the next posting slot.'
        : current.mode === 'AUTO'
          ? `Needs the owner despite auto mode: ${reviews.join(' ')}`
          : 'Waiting for the owner to approve or reject it.';
    const duplicate = await repo.findDuplicate(tx, {
      projectId: project.id,
      clientRequestId: requestKey,
      factFingerprint: fact,
      textFingerprint: textFingerprint(postText),
    });
    if (duplicate) {
      const why =
        duplicate.match === 'REQUEST'
          ? 'This request was already received.'
          : duplicate.match === 'FACT'
            ? `An update with this title was already submitted (${duplicate.row.status.toLowerCase().replace(/_/g, ' ')}).`
            : `An update with this exact post was already submitted (${duplicate.row.status.toLowerCase().replace(/_/g, ' ')}).`;
      return { outcome: 'DUPLICATE', reason: why, update: senderUpdateView(duplicate.row) };
    }
    if (keys.length > 0) {
      const known = await repo.knownEvidenceKeys(tx, project.id);
      if (keys.every((k) => known.has(k))) {
        return {
          outcome: 'DUPLICATE',
          reason: 'Every commit, pull request, issue or release cited here was already announced in an earlier update.',
          update: null,
        };
      }
    }
    if ((await repo.countOpen(tx, project.id)) >= MAX_OPEN_UPDATES) {
      throw new ConflictError(
        `${MAX_OPEN_UPDATES} updates are already waiting for this project. Let the owner catch up before sending more.`,
      );
    }
    // The project's own uploads that nothing has taken yet, locked so two
    // updates cannot both claim one file.
    const media = mediaIds.length > 0 ? await repo.lockUnattachedMedia(tx, project.id, mediaIds) : [];
    if (media.length !== mediaIds.length) {
      throw new ValidationError('One of the attached files was not uploaded for this project, was already used by another update, or has expired. Upload it again.');
    }
    const mediaProblem = mediaRefsProblem(media);
    if (mediaProblem) throw new ValidationError(mediaProblem);
    const row = await repo.insertUpdate(tx, {
      projectId: project.id,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      why: input.why,
      evidence: input.evidence.map((e) => ({ type: e.type, ref: e.ref ?? null, detail: e.detail })),
      postText,
      factFingerprint: fact,
      textFingerprint: textFingerprint(postText),
      evidenceKeys: keys,
      clientRequestId: requestKey,
      media,
      status,
      statusReason: reason,
      history: [
        { at: new Date().toISOString(), status: 'PENDING_REVIEW', actor: 'sender', reason: 'Submitted.' },
        ...(status === 'APPROVED'
          ? [{ at: new Date().toISOString(), status, actor: 'system' as const, reason }]
          : []),
      ],
    });
    if (media.length > 0) await repo.markMediaAttached(tx, mediaIds, row.id);
    return { outcome: 'ACCEPTED', update: senderUpdateView(row) };
  }).catch(async (error: unknown): Promise<SubmitOutcome> => {
    // The project lock serialises submissions, so this is the index catching
    // what the lock should already have: say it is a duplicate, never a 500.
    if (!isUniqueViolation(error)) throw error;
    return { outcome: 'DUPLICATE', reason: 'An identical update was submitted at the same moment.', update: null };
  });

  if (outcome.outcome === 'ACCEPTED' && outcome.update) {
    await ops.audit({
      actorUserId: null,
      action: 'dev_updates.submitted',
      entityType: 'dev_update',
      entityId: outcome.update.id,
      data: { projectId: project.id, kind: input.kind, status: outcome.update.status },
    });
    log.info('development update accepted', { projectId: project.id, updateId: outcome.update.id, status: outcome.update.status });
  }
  return outcome;
}

/** An approved update is waiting on the dispatcher, whose latest answer is the reason. */
function withWait(project: DevUpdateProjectRow, row: DevUpdateRow) {
  return {
    ...senderUpdateView(row),
    waitingBecause: row.status === 'APPROVED' && project.lastDispatchReason ? project.lastDispatchReason : null,
  };
}

export async function listSenderUpdates(project: DevUpdateProjectRow, limit = 20) {
  const rows = await repo.listUpdates({ projectIds: [project.id], limit });
  return Promise.all(rows.map(async (row) => withWait(project, await reconcileOne(row))));
}

export async function getSenderUpdate(project: DevUpdateProjectRow, updateId: string) {
  const row = await repo.getUpdate(updateId);
  // Another project's update is indistinguishable from one that does not exist.
  if (!row || row.projectId !== project.id) throw new NotFoundError('Development update');
  return withWait(project, await reconcileOne(row));
}

// ── The owner's decisions ───────────────────────────────────────────────────

async function ownedUpdate(ownerId: string, updateId: string): Promise<{ row: DevUpdateRow; project: DevUpdateProjectRow }> {
  const row = await repo.getUpdate(updateId);
  if (!row) throw new NotFoundError('Development update');
  const project = await ownedProject(ownerId, row.projectId);
  return { row, project };
}

export async function listOwnerUpdates(ownerId: string, filter: { projectId?: string; status?: DevUpdateStatus; limit?: number }) {
  const projects = await repo.listProjects(ownerId);
  const ids = projects.map((p) => p.id).filter((id) => !filter.projectId || id === filter.projectId);
  const rows = await repo.listUpdates({
    projectIds: ids,
    statuses: filter.status ? [filter.status] : undefined,
    limit: filter.limit ?? 50,
  });
  return Promise.all(rows.map(async (row) => updateView(await reconcileOne(row))));
}

export async function getOwnerUpdate(ownerId: string, updateId: string) {
  const { row } = await ownedUpdate(ownerId, updateId);
  return updateView(await reconcileOne(row));
}

const AWAITING_PERSON = ['WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED'];

/**
 * Approves exactly the post the owner read, or their edit of it.
 *
 * An approval is never a way around policy: the edited or proposed text goes
 * through every safety rule and the agent's validator again, and the
 * dispatcher's ceiling, spacing and the pipeline's own gates still apply
 * after it.
 */
export async function approveDevUpdate(ownerId: string, updateId: string, raw: unknown) {
  const input = DevUpdateDecisionInput.parse(raw ?? {});
  const { row, project } = await ownedUpdate(ownerId, updateId);

  if (row.status === 'DISPATCHED' && row.jobId) {
    // Already in the pipeline and held at the agent's own approval gate. This
    // is the same approval the review queue makes, through the same function.
    const job = await jobsRepo.getJob(row.jobId);
    if (!job || !AWAITING_PERSON.includes(job.status)) {
      throw new ConflictError('This update is already on its way and is not waiting for anybody.');
    }
    if (input.editedText) {
      const checked = await checkPublishable(project.agentId, input.editedText);
      if (checked.refusals.length) throw new DevUpdateRefusedError(checked.refusals);
    }
    await approveJob({ jobId: job.id, decidedBy: ownerId, editedOutput: input.editedText, note: input.note });
    // The decision and the exact text it approved, on the update itself, so the
    // record of what was reviewed is what goes out, and the send-time check
    // knows a person decided.
    const sending = (await jobsRepo.getJob(job.id))?.validatedOutput ?? null;
    await repo.recordGateDecision({
      id: row.id,
      decidedBy: ownerId,
      approvedText: sending !== null && sending !== row.postText ? sending : row.approvedText,
      reason: input.editedText ? 'Approved with edits at the agent gate. Queued for posting.' : 'Approved at the agent gate. Queued for posting.',
    });
    await ops.audit({ actorUserId: ownerId, action: 'dev_updates.approved', entityType: 'dev_update', entityId: row.id, data: { atGate: true } });
    return updateView((await repo.getUpdate(row.id))!);
  }

  if (row.status !== 'PENDING_REVIEW') {
    throw new ConflictError(`This update is ${row.status.toLowerCase().replace(/_/g, ' ')}, so there is nothing to approve.`);
  }
  const text = input.editedText ?? row.postText;
  const checked = await checkPublishable(project.agentId, text);
  if (checked.refusals.length) throw new DevUpdateRefusedError(checked.refusals);

  const next = await repo.transition({
    id: row.id,
    from: ['PENDING_REVIEW'],
    to: 'APPROVED',
    actor: 'owner',
    reason: input.editedText
      ? 'Approved with edits. Waiting for the next posting slot.'
      : 'Approved. Waiting for the next posting slot.',
    approvedText: checked.output !== row.postText ? checked.output : null,
    decidedBy: ownerId,
  });
  if (!next) throw new ConflictError('This update was decided by somebody else a moment ago.');
  await ops.audit({
    actorUserId: ownerId,
    action: 'dev_updates.approved',
    entityType: 'dev_update',
    entityId: row.id,
    data: { edited: Boolean(input.editedText) },
  });
  return updateView(next);
}

/**
 * Declines an update, and forgets what it said.
 *
 * The fingerprints stay, so the same update offered again is recognised and
 * refused rather than asked about twice. The words go, because an owner who
 * rejects something may be rejecting it for what it reveals.
 */
export async function rejectDevUpdate(ownerId: string, updateId: string, raw: unknown) {
  const input = DevUpdateDecisionInput.parse(raw ?? {});
  const { row, project } = await ownedUpdate(ownerId, updateId);
  const reason = input.note ? `Rejected by the owner: ${input.note}` : 'Rejected by the owner.';
  const done = async (next: DevUpdateRow) => {
    await ops.audit({ actorUserId: ownerId, action: 'dev_updates.rejected', entityType: 'dev_update', entityId: next.id });
    // A rejected update loses its words, and the pictures that went with them.
    await forgetPostMedia((row.media ?? []).map((m) => m.artifactId));
    return updateView(next);
  };

  /*
    Not yet handed over: decided under the project lock the dispatcher takes,
    so a rejection and a hand-over cannot both win. If the dispatcher got there
    first the transition matches nothing and this falls through to the
    dispatched case below.
  */
  if (row.status === 'PENDING_REVIEW' || row.status === 'APPROVED') {
    const early = await withTransaction(async (tx) => {
      await repo.lockProject(tx, project.id);
      return repo.transition(
        { id: row.id, from: ['PENDING_REVIEW', 'APPROVED'], to: 'REJECTED', actor: 'owner', reason, decidedBy: ownerId, finished: true, scrub: true },
        tx,
      );
    });
    if (early) return done(early);
  }

  const current = (await repo.getUpdate(row.id)) ?? row;
  if (current.status !== 'DISPATCHED' || !current.jobId) {
    throw new ConflictError(`This update is ${current.status.toLowerCase().replace(/_/g, ' ')}, so there is nothing to reject.`);
  }
  const jobId = current.jobId;

  /*
    Already in the pipeline: decided under the account lease the executor holds
    while it sends. Either the send already happened, and this says so, or it
    has not started, and the update is marked rejected before the executor's
    own check reads it, which stops the job there even if it is mid-pipeline.
  */
  // The job's own account, which is the lease its executor takes, even if the
  // project has been rewired since.
  const leaseAccount = (await jobsRepo.getJob(jobId))?.accountId ?? project.accountId;
  const held = await accountLease.withAccountLease(
    { accountId: leaseAccount, workerId: `owner-reject:${ownerId}`, reason: 'rejecting a development update', ttlMs: 60_000 },
    async () => {
      const job = await jobsRepo.getJob(jobId);
      if (job && (job.status === 'EXECUTED' || job.status === 'DRY_RUN_COMPLETED')) return null;
      // A send that has begun, finished or failed may have reached the account.
      // Calling that rejected would be a claim nobody can check.
      const attempted = (await actionsRepo.listJobActions(jobId)).some((a) => !a.dryRun);
      if (attempted) return null;
      const next = await repo.transition({
        id: current.id,
        from: ['DISPATCHED'],
        to: 'REJECTED',
        actor: 'owner',
        reason,
        decidedBy: ownerId,
        finished: true,
        scrub: true,
      });
      if (job && next) {
        if (AWAITING_PERSON.includes(job.status)) await rejectJob({ jobId: job.id, decidedBy: ownerId, note: input.note });
        else if (!['CANCELLED', 'PERMANENT_FAILURE'].includes(job.status)) {
          // A job claimed by a worker right now may still write its own status
          // after this; the executor's check refuses a rejected update anyway.
          await cancelJob(job.id).catch(() => undefined);
        }
      }
      return next;
    },
  );
  if (!held.held) throw new ConflictError('This update is being sent right now. Look again in a moment.');
  if (!held.value) throw new ConflictError('Sending this update has already begun, so it can no longer be rejected.');
  return done(held.value);
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Where in the agent's own graph a pre-written post joins it.
 *
 * At the approval gate when there is one, so the agent's own rule about
 * asking first still has its say; otherwise at the action itself. Everything
 * before that point exists to write the text, and the text is already written.
 */
export function entryNodeFor(nodes: PipelineNode[], edges: PipelineEdge[]): string | null {
  const kind = new Map(nodes.map((n) => [n.key, n.kind]));
  const gate = nodes.find(
    (n) => n.kind === 'APPROVAL_GATE' && edges.some((e) => e.from === n.key && e.branch === 'approved' && kind.get(e.to) === 'EXECUTE_ACTION'),
  );
  if (gate) return gate.key;
  return nodes.find((n) => n.kind === 'EXECUTE_ACTION')?.key ?? null;
}

export interface DispatchResult {
  projectId: string;
  updateId: string | null;
  jobId: string | null;
  dispatched: boolean;
  reason: string;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m >= 120 ? `${Math.round(m / 60)} hours` : `${m} minutes`;
}

/** Why an agent cannot post right now, or null when it can. */
async function agentProblem(project: DevUpdateProjectRow): Promise<string | null> {
  const mapping = await mappingProblem(project.ownerUserId, project.agentId, project.accountId);
  if (mapping) return mapping;
  const agent = await agentsRepo.getAgent(project.agentId);
  if (!agent || agent.state !== 'ACTIVE') return `The agent is ${agent?.state.toLowerCase() ?? 'missing'}, so nothing is posted.`;
  const mode = (await policyFor(project.agentId)).automation.mode;
  if (mode === 'OFF' || mode === 'MONITOR_ONLY') {
    return `The agent's automation is ${mode.toLowerCase().replace(/_/g, ' ')}, so nothing is posted.`;
  }
  return null;
}

async function dispatchProject(projectId: string): Promise<DispatchResult | null> {
  const preflight = await repo.getProject(projectId);
  if (!preflight) return null;
  // Read outside the transaction: these are the same reads the executor will
  // make again at the moment of sending, so a stale answer here costs a wait,
  // never a post that should not have happened.
  const blocked = await agentProblem(preflight);

  // Everything the hand-over needs that is not this project's own rows, read
  // before the transaction: inside it only `tx` may be used, and these are not
  // what the lock protects.
  const agent = await agentsRepo.getAgent(preflight.agentId);
  const account = await accountsRepo.getAccount(preflight.accountId);
  const rules = await publishRules(preflight.agentId);
  const policy = rules.policy;
  const version = agent?.pipelineVersionId
    ? await pipelinesRepo.getPipelineVersion(agent.pipelineVersionId)
    : await pipelinesRepo.getActivePipeline(preflight.agentId);
  const entry = version ? entryNodeFor(version.nodes, version.edges) : null;
  const template = await promptsRepo.getActiveTemplate('reply.default').catch(() => null);

  type Pending = { result: DispatchResult; trace?: { jobId: string; agentId: string; message: string } };
  const pending = await withTransaction(async (tx): Promise<Pending | null> => {
    const project = await repo.lockProject(tx, projectId, true);
    // Another worker has this project; it will do the same work.
    if (!project) return null;
    await repo.markConsidered(tx, project.id);
    const base = { projectId, updateId: null, jobId: null, dispatched: false };

    if (!project.enabled) return { result: { ...base, reason: 'Paused by the owner.' } };
    if (blocked) {
      await repo.setDispatchReason(project.id, blocked, tx);
      return { result: { ...base, reason: blocked } };
    }

    // One at a time. A held job (at a gate, behind a limit) would otherwise let
    // the next hand-over line up behind it, and both go out together once it
    // clears. The executor enforces the ceiling and spacing on real sends; this
    // keeps the queue from bunching in the first place.
    if ((await repo.countInFlight(tx, project.id)) > 0) {
      const reason = 'An earlier update is still on its way; the next one waits for it to finish.';
      await repo.setDispatchReason(project.id, reason, tx);
      return { result: { ...base, reason } };
    }

    const window = await repo.dispatchWindow(tx, project.id);
    if (window.lastDay >= project.dailyCap) {
      const reason = `Daily ceiling reached (${window.lastDay} of ${project.dailyCap} in the last 24 hours).`;
      await repo.setDispatchReason(project.id, reason, tx);
      return { result: { ...base, reason } };
    }
    if (window.lastDispatchedAt) {
      const waited = Date.now() - new Date(window.lastDispatchedAt).getTime();
      const spacing = project.minSpacingMinutes * 60_000;
      if (waited < spacing) {
        const reason = `Spacing updates out: the next may go in ${minutes(spacing - waited)}.`;
        await repo.setDispatchReason(project.id, reason, tx);
        return { result: { ...base, reason } };
      }
    }

    const update = await repo.oldestApproved(tx, project.id);
    if (!update) return { result: { ...base, reason: 'Nothing approved is waiting.' } };

    // Safety at the moment of sending, against the rules as they are now.
    const text = update.approvedText ?? update.postText;
    const checked = checkAgainst(rules, text);
    if (checked.refusals.length > 0 || !checked.output) {
      const reason = `Stopped before posting: ${checked.refusals.map((r) => r.message).join(' ') || 'there was no text.'}`;
      await repo.transition({ id: update.id, from: ['APPROVED'], to: 'FAILED', actor: 'system', reason, finished: true }, tx);
      return { result: { ...base, updateId: update.id, reason } };
    }
    if (checked.reviews.length > 0 && update.decidedBy === null) {
      const reason = `Needs the owner before posting: ${checked.reviews.join(' ')}`;
      await repo.transition({ id: update.id, from: ['APPROVED'], to: 'PENDING_REVIEW', actor: 'system', reason }, tx);
      return { result: { ...base, updateId: update.id, reason } };
    }

    // The mapping was read before the lock; if it moved since, wait a tick.
    if (!agent || !account || agent.id !== project.agentId || account.id !== project.accountId) {
      return { result: { ...base, updateId: update.id, reason: 'The project mapping changed a moment ago; trying again shortly.' } };
    }
    if (!entry || !version) {
      const reason = 'The agent has no pipeline step that can post. Check its pipeline.';
      await repo.setDispatchReason(project.id, reason, tx);
      return { result: { ...base, updateId: update.id, reason } };
    }

    const dryRun = project.rehearse || policy.automation.dryRunDefault;
    // Anchored to the update, so a dispatcher that dies after committing and
    // runs again finds the same job rather than making a second one.
    const remoteEventId = `devupdate:${update.id}`;
    const idempotencyKey = sha256Hex(`${account.channel}:${account.id}:${remoteEventId}:POST:${agent.id}`);
    const { event } = await eventsRepo.ingestEvent(tx, account.id, {
      channel: account.channel,
      type: 'SCHEDULED_TRIGGER',
      remoteEventId,
      remoteMessageId: null,
      remoteAuthorId: null,
      remoteAuthorHandle: null,
      remoteAuthorDisplayName: null,
      remoteConversationId: null,
      parentRemoteMessageId: null,
      remoteUrl: null,
      // The post itself, which is public by now. The summary and evidence stay
      // with the update.
      text: checked.output,
      occurredAt: new Date().toISOString(),
      raw: {
        origin: 'dev_update',
        devUpdateId: update.id,
        projectId: project.id,
        // References, which the executor resolves and re-checks at send time.
        ...((update.media ?? []).length > 0 ? { media: update.media } : {}),
      },
    });
    const created = await jobsRepo.createJob(tx, {
      eventId: event.id,
      agentId: agent.id,
      accountId: account.id,
      channel: account.channel,
      actionType: 'POST',
      idempotencyKey,
      dryRun,
      maxAttempts: policy.safety.maxAttempts,
      personaVersionId: agent.personaVersionId,
      policyVersionId: agent.policyVersionId,
      pipelineVersionId: version!.id,
      promptTemplateVersionId: template?.id ?? null,
      conversationId: null,
      requiresBrowser: getChannelAdapter(account.channel).requiresBrowser,
    });

    /*
      Approved, or left for the agent's own gate.

      An owner who approved this exact text has made the decision the gate
      exists to ask for. Auto mode is the owner's standing approval, but only
      as far as the agent's policy allows: an agent that asks before acting
      still asks, and the update waits at its gate where the ordinary review
      queue and this module's approve both reach it.
    */
    const approved = update.decidedBy !== null || policy.automation.mode === 'AUTONOMOUS';
    if (created.created) {
      await jobsRepo.updateJob(
        created.job.id,
        {
          status: 'VALIDATED',
          currentNodeKey: entry,
          generatedOutput: checked.output,
          validatedOutput: checked.output,
          runNow: true,
          touch: approved ? ['generatedAt', 'validatedAt', 'approvedAt'] : ['generatedAt', 'validatedAt'],
        },
        tx,
      );
    }
    const reason = dryRun
      ? project.rehearse
        ? REHEARSAL_BY_PROJECT
        : REHEARSAL_BY_AGENT
      : approved
        ? 'Handed to the agent to post.'
        : "Handed to the agent, which asks before posting. Waiting at the agent's approval gate.";
    await repo.transition(
      { id: update.id, from: ['APPROVED'], to: 'DISPATCHED', actor: 'system', reason, jobId: created.job.id, dispatched: true },
      tx,
    );
    await repo.setDispatchReason(project.id, `Dispatched "${update.title.slice(0, 80)}".`, tx);
    return {
      result: { projectId, updateId: update.id, jobId: created.job.id, dispatched: true, reason },
      trace: created.created
        ? { jobId: created.job.id, agentId: agent.id, message: `Development update: ${update.title.slice(0, 120)}` }
        : undefined,
    };
  });

  // Traces use their own connection, so only after the job row is committed.
  if (pending?.trace) {
    await observability
      .emitTrace({
        jobId: pending.trace.jobId,
        agentId: pending.trace.agentId,
        type: 'JOB_CREATED',
        message: pending.trace.message,
        data: { origin: 'dev_update', devUpdateId: pending.result.updateId },
      })
      .catch(() => undefined);
  }
  return pending?.result ?? null;
}

export async function dispatchDevUpdates(limit: number): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  for (const projectId of await repo.projectsWithApproved(limit)) {
    const result = await dispatchProject(projectId);
    if (result) results.push(result);
  }
  return results;
}

// ── Reading back what happened ──────────────────────────────────────────────

/**
 * Brings one update's status in line with its job.
 *
 * "Dispatched" is a claim about AI17Z; "published" is a claim about the
 * account, and is only made with the remote link the executor recorded.
 */
export async function reconcileOne(row: DevUpdateRow): Promise<DevUpdateRow> {
  if (row.status !== 'DISPATCHED') return row;
  if (!row.jobId) {
    return (
      (await repo.transition({
        id: row.id,
        from: ['DISPATCHED'],
        to: 'FAILED',
        actor: 'system',
        reason: 'The job carrying this update was removed before it finished.',
        finished: true,
      })) ?? row
    );
  }
  const job = await jobsRepo.getJob(row.jobId);
  if (!job) return row;

  const settle = async (to: DevUpdateStatus, reason: string, extra: { remoteUrl?: string | null; scrub?: boolean; approvedText?: string | null } = {}) =>
    (await repo.transition({ id: row.id, from: ['DISPATCHED'], to, actor: 'system', reason, finished: true, ...extra })) ?? row;

  switch (job.status) {
    case 'EXECUTED': {
      const sent = (await actionsRepo.listJobActions(job.id)).find((a) => a.status === 'EXECUTED' && !a.dryRun);
      if (sent) {
        // What went out, whichever review path last touched it.
        const text = typeof sent.payload.text === 'string' ? sent.payload.text : null;
        return settle('PUBLISHED', 'Published.', {
          remoteUrl: sent.remoteActionUrl ?? null,
          // Null when it was the original proposal, so an edit that never went
          // out (a recovered earlier attempt) is not shown as published.
          ...(text !== null ? { approvedText: text !== row.postText ? text : null } : {}),
        });
      }
      return settle('SKIPPED', 'Nothing new was posted: this exact text had already gone out from this account.');
    }
    case 'DRY_RUN_COMPLETED': {
      // Said at hand-over, because the project's flag may have moved since and
      // the owner needs to be told the switch that actually held this one.
      const handedOver = [...row.history].reverse().find((entry) => entry.status === 'DISPATCHED');
      return settle('REHEARSED', handedOver?.reason === REHEARSAL_BY_AGENT ? REHEARSED_BY_AGENT : REHEARSED_BY_PROJECT);
    }
    case 'PERMANENT_FAILURE':
      return settle('FAILED', `The post failed and will not be retried: ${job.lastError ?? 'no reason was recorded.'}`);
    case 'CANCELLED': {
      const approval = await actionsRepo.getApproval(job.id);
      if (approval?.status === 'REJECTED') return settle('REJECTED', 'Rejected at the agent gate.', { scrub: true });
      return settle('CANCELLED', `Stopped before posting: ${job.lastError ?? 'cancelled.'}`);
    }
    case 'WAITING_FOR_APPROVAL':
      await repo.noteReason(row.id, 'DISPATCHED', "Waiting at the agent's approval gate. Approve or reject it to continue.");
      break;
    case 'REVIEW_REQUIRED':
      await repo.noteReason(row.id, 'DISPATCHED', `Needs the owner: ${job.lastError ?? 'the pipeline asked for a person.'}`);
      break;
    default:
      await repo.noteReason(
        row.id,
        'DISPATCHED',
        `In the agent's queue (${job.status.toLowerCase().replace(/_/g, ' ')})${job.lastError ? `: ${job.lastError}` : '.'}`,
      );
  }
  return (await repo.getUpdate(row.id)) ?? row;
}

export async function reconcileDevUpdates(limit: number): Promise<number> {
  let settled = 0;
  for (const row of await repo.listDispatched(limit)) {
    const after = await reconcileOne(row);
    if (after.status !== 'DISPATCHED') settled += 1;
  }
  return settled;
}

/** One worker tick: read back what finished, then hand on what is due. */
export async function runDevUpdates(limit: number): Promise<{ settled: number; dispatched: DispatchResult[] }> {
  const settled = await reconcileDevUpdates(limit * 4);
  const dispatched = await dispatchDevUpdates(limit);
  await sweepUnattachedMedia().catch((error: unknown) => log.warn('unattached media sweep failed', { message: String(error) }));
  return { settled, dispatched };
}
