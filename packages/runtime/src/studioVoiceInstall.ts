/**
 * Installing a published voice: a new agent with that voice, and nothing else.
 *
 * ## What "nothing else" means, enforced
 *
 * The agent this creates is built from `createAgent` directly, with a persona
 * and a policy made by `voiceDocument.ts` from the platform's defaults. It does
 * not go through the one route that creates an agent and then calls
 * `applyCoreRecommended`, so no capability permission row is written; it is in
 * the `DRAFT` state, so it is not running; its deliberation row is written
 * with `autonomy: OBSERVE` and `enabled: false`, so it gathers nothing and
 * says nothing; it has no account, no model role, no tool, no knowledge, no
 * schedule, no plugin and no picture, because the voice has nowhere to name
 * one. A person adds each of those, one decision at a time, the way they would
 * for any agent they made by hand.
 *
 * ## The owner is the installer
 *
 * The agent belongs to whoever installs it. A voice names no owner and no id,
 * and the agent's display name is the installer's choice, so nothing in a
 * stranger's file decides who the new agent is or who it answers to.
 *
 * ## Inspect, then install
 *
 * `inspectVoice` never throws and creates nothing. Every number it returns is
 * counted from the parsed document. A voice whose text was flagged installs
 * only when the caller says it saw the flags, so the flags cannot be a thing
 * only a screen read.
 */
import { BadRequestError, slugify } from '@xbam/shared';
import { hasForbiddenCharacters, type VoiceCounts, type VoiceDocument } from '@xbam/shared/contracts';
import { agents as agentsRepo, deliberation, ops } from '@xbam/database';
import { ensureAgentPipeline } from './bootstrap';
import { fetchPublishedVoice } from './studioVoice';
import {
  countsOf,
  parseVoice,
  personaFromVoice,
  policyFromVoice,
  scanVoice,
  type VoiceFinding,
} from './voiceDocument';

export interface VoiceInspection {
  valid: boolean;
  /** Why not, in a sentence, when it is not. */
  problem: string | null;
  title: string | null;
  summary: string | null;
  digest: string | null;
  /** Counted from the parsed document. */
  counts: VoiceCounts | null;
  findings: VoiceFinding[];
  /** Things worth saying before somebody presses install. */
  notes: string[];
}

const WHAT_INSTALLING_DOES = [
  'Installing creates one new agent, owned by you, with this voice: the character, the style examples and the output settings.',
  'It is created switched off and in observe-only mode, with no account, no permissions, no approvals, no tools, no plugins, no memory and no models. You add those yourself.',
  'You choose its name. The voice does not name it, and it does not say who it is.',
];

export function inspectVoice(raw: unknown): VoiceInspection {
  const parsed = parseVoice(raw);
  if (!parsed.ok) {
    return { valid: false, problem: parsed.problem, title: null, summary: null, digest: null, counts: null, findings: [], notes: [] };
  }
  const findings = scanVoice(parsed.document);
  const notes = [...WHAT_INSTALLING_DOES];
  if (findings.length > 0) {
    notes.unshift(
      `${findings.length} passage${findings.length === 1 ? '' : 's'} in the text read like an instruction to the model, a denial of being an AI, or a request for something secret. They are stored as the agent's words and nothing more, and the platform's identity and output rules apply to it as to any agent, but read them before you install.`,
    );
  }
  return {
    valid: true,
    problem: null,
    title: parsed.document.title,
    summary: parsed.document.summary,
    digest: parsed.digest,
    counts: countsOf(parsed.document),
    findings,
    notes,
  };
}

export interface VoiceInstallProvenance {
  source: 'FILE' | 'STUDIO';
  listingId: string | null;
  version: number | null;
}

export interface VoiceInstallResult {
  agentId: string;
  name: string;
  counts: VoiceCounts;
  findings: VoiceFinding[];
  notes: string[];
}

/** The name a new agent gets: the installer's, else the listing's. */
function agentName(chosen: string | undefined, document: VoiceDocument): string {
  const name = (chosen ?? '').trim() || document.title;
  if (name.length > 120) throw new BadRequestError('An agent name is at most 120 characters.');
  if (/[\r\n]/.test(name)) throw new BadRequestError('An agent name is a single line.');
  // The installer's own typing is held to what a stranger's file is: a
  // direction override or a control character reads differently from how it is
  // stored, and this name is shown in lists and becomes part of a slug.
  if (hasForbiddenCharacters(name)) {
    throw new BadRequestError('An agent name cannot contain control or direction-override characters.');
  }
  return name;
}

export async function installVoice(input: {
  ownerId: string;
  createdBy?: string | null;
  /** Text of a voice file, or an already parsed document. */
  document: unknown;
  name?: string;
  provenance?: VoiceInstallProvenance;
  /** Say the flagged passages were seen. Required when there are any. */
  acknowledgeFindings?: boolean;
}): Promise<VoiceInstallResult> {
  const parsed = parseVoice(input.document);
  if (!parsed.ok) throw new BadRequestError(parsed.problem);
  const { document } = parsed;

  const findings = scanVoice(document);
  if (findings.length > 0 && !input.acknowledgeFindings) {
    throw new BadRequestError(
      `This voice has ${findings.length} flagged passage${findings.length === 1 ? '' : 's'} (${[...new Set(findings.map((f) => f.kind))].join(', ')}). Inspect it, read them, and install again to confirm.`,
    );
  }

  const name = agentName(input.name, document);
  const provenance = input.provenance ?? { source: 'FILE', listingId: null, version: null };
  const origin =
    provenance.listingId && provenance.version
      ? `Installed from published voice ${provenance.listingId} version ${provenance.version}.`
      : 'Installed from a voice file.';

  const agent = await agentsRepo.createAgent({
    ownerId: input.ownerId,
    name,
    slug: `${slugify(name) || 'voice'}-${Date.now().toString(36)}`,
    description: document.summary,
    persona: personaFromVoice(document, name, origin),
    policy: policyFromVoice(document),
    createdBy: input.createdBy ?? null,
  });

  // Stock pipeline, as every created agent has. Without it the agent arrives
  // complete in every other way and can never be started.
  await ensureAgentPipeline(agent.id);
  // Written explicitly rather than left to the table default, so the guarantee
  // is in this file and a changed default cannot quietly loosen it.
  await deliberation.setWake(agent.id, { enabled: false, autonomy: 'OBSERVE' });

  await ops.setSetting(`studio.voice.installed.${agent.id}`, {
    source: provenance.source,
    listingId: provenance.listingId,
    version: provenance.version,
    digest: parsed.digest,
    installedAt: new Date().toISOString(),
  });
  await ops
    .audit({
      actorUserId: input.createdBy ?? input.ownerId,
      action: 'studio.voice.install',
      entityType: 'agent',
      entityId: agent.id,
      data: { source: provenance.source, listingId: provenance.listingId, version: provenance.version, digest: parsed.digest, flagged: findings.length },
    })
    .catch(() => undefined);

  return {
    agentId: agent.id,
    name,
    counts: countsOf(document),
    findings,
    notes: [
      ...WHAT_INSTALLING_DOES,
      'No account, session or browser profile exists for it. Connect an account when you are ready.',
    ],
  };
}

/**
 * Installs a version of a published voice from the linked Studio's public
 * pages. Fetches, verifies the digest, and installs the parsed document, so
 * what is created is what was verified and not a second download.
 */
export async function installPublishedVoice(input: {
  ownerId: string;
  createdBy?: string | null;
  listingId: string;
  version?: number;
  name?: string;
  acknowledgeFindings?: boolean;
}): Promise<VoiceInstallResult> {
  const fetched = await fetchPublishedVoice(input.listingId, input.version);
  if (!fetched.ok) throw new BadRequestError(fetched.why);
  return installVoice({
    ownerId: input.ownerId,
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    document: fetched.voice.document,
    ...(input.name === undefined ? {} : { name: input.name }),
    provenance: { source: 'STUDIO', listingId: fetched.voice.listingId, version: fetched.voice.version },
    ...(input.acknowledgeFindings === undefined ? {} : { acknowledgeFindings: input.acknowledgeFindings }),
  });
}
