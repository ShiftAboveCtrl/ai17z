import { createLogger, errorMessage, sha256Hex } from '@xbam/shared';
import {
  accounts as accountsRepo,
  capabilities as capabilitiesRepo,
  crossPosts,
  events as eventsRepo,
  farcasterSigners,
  jobs as jobsRepo,
  withTransaction,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';

const log = createLogger('crossPost');

/**
 * One voice across X and Farcaster.
 *
 * An idea the agent decided to post is posted on the account it posts through.
 * When the owner has also switched Farcaster posting on for a linked Farcaster
 * account, the same idea becomes a second, independent job there. Independent
 * is the point, in three ways:
 *
 *   its own key. The job key is built from the channel, the account and the
 *   event, so a Farcaster retry cannot be mistaken for the X job and the X job
 *   cannot be mistaken for the cast. Nothing is shared that could make one
 *   network's restart repost on the other.
 *
 *   its own gates, on its own final text. The job runs the same ten steps, so
 *   voice, validation and quality run on what this network will carry, and the
 *   publication refusals in `stepExecute` run on that text and not on the X one.
 *
 *   its own failure. The cast job is created after the primary one committed,
 *   inside its own try, and nothing here is read by the primary job again.
 *   A Farcaster node that is down costs a cast, never a post on X.
 *
 * There is no timer in this file. It runs where posting already runs.
 */

/** A Farcaster cast is at most 320 UTF-8 bytes, which is not 320 characters. */
export const FARCASTER_CAST_BYTES = 320;

export interface MirrorMarker {
  /** The account whose evidence and permissions the idea was made under. */
  accountId: string;
  /** The primary job, when there was one. Informational. */
  jobId: string | null;
}

/** Whether this event is a copy of a post made elsewhere, and where from. */
export function mirrorOf(payload: unknown): MirrorMarker | null {
  const marker = (payload as { mirrorOf?: unknown } | null)?.mirrorOf as Partial<MirrorMarker> | undefined;
  if (!marker || typeof marker.accountId !== 'string') return null;
  return { accountId: marker.accountId, jobId: typeof marker.jobId === 'string' ? marker.jobId : null };
}

/**
 * Which accounts the publication gates should be asked about.
 *
 * Signal and receipt evidence belongs to the account that watched the chain, so
 * ownership is checked against that account even when the text is going out on
 * another network. Whether the account that is about to publish may do so right
 * now (cadence, quiet hours, connection) is asked of that account.
 */
export function publicationScope(payload: unknown, jobAccountId: string | null): {
  accountId: string | null;
  postingAccountId: string | null;
} {
  const mirror = mirrorOf(payload);
  return { accountId: mirror?.accountId ?? jobAccountId, postingAccountId: jobAccountId };
}

export interface FarcasterPostingStatus {
  /** The owner's switch. */
  enabled: boolean;
  /** Whether a cast could be sent from this account right now. */
  available: boolean;
  /** Why not, in a sentence an owner can act on. Null when available. */
  reason: string | null;
}

/**
 * What the panel says about posting to one Farcaster account.
 *
 * An account the owner switched on but that has no signer is reported as
 * unavailable with the reason, never as a switch that quietly does nothing.
 */
export async function farcasterPostingStatus(accountId: string, agentId: string | null): Promise<FarcasterPostingStatus> {
  const enabled = await crossPosts.farcasterPostingEnabled(accountId);
  const account = await accountsRepo.getAccount(accountId);
  let reason: string | null = null;
  if (!account || account.channel !== 'farcaster') reason = 'This is not a Farcaster account.';
  else if (!(await farcasterSigners.signerPresence(accountId)).hasSigner) {
    reason = 'No authorized Farcaster app signer is linked. Add one before this account can cast.';
  } else if (!account.enabled || account.status !== 'CONNECTED') {
    reason = 'The Farcaster account is not connected. Reconnect it to cast.';
  } else if (agentId) {
    const link = (await accountsRepo.listAgentAccounts(agentId)).find((l) => l.accountId === accountId);
    if (!link || !link.enabled) reason = 'This account is not linked to the agent.';
    else if (!(await capabilitiesRepo.grantsFor(agentId, accountId)).has('POST')) {
      reason = 'The agent has not been granted permission to post through this account.';
    }
  }
  return { enabled, available: reason === null, reason };
}

/**
 * The same answer for an account that more than one agent may drive: available
 * if any linked agent can cast through it, and otherwise the first reason.
 */
export async function accountPostingStatus(accountId: string): Promise<FarcasterPostingStatus> {
  const linked = await accountsRepo.listAccountAgents(accountId);
  if (linked.length === 0) {
    const enabled = await crossPosts.farcasterPostingEnabled(accountId);
    const base = await farcasterPostingStatus(accountId, null);
    return { enabled, available: false, reason: base.reason ?? 'This account is not linked to an agent.' };
  }
  let first: FarcasterPostingStatus | null = null;
  for (const link of linked) {
    const status = await farcasterPostingStatus(accountId, link.agentId);
    if (status.available) return status;
    first ??= status;
  }
  return first!;
}

export interface FanOutInput {
  agentId: string;
  /** The account the primary post goes out through. */
  originAccount: { id: string; channel: string };
  originJobId: string | null;
  idea: { id: string; summary: string; source: string };
  brief: string;
  remoteEventId: string;
  dryRun: boolean;
  maxAttempts: number;
  versions: {
    personaVersionId: string | null;
    policyVersionId: string | null;
    pipelineVersionId: string | null;
    promptTemplateVersionId: string | null;
  };
}

export interface FanOutResult {
  queued: string[];
  skipped: { accountId: string; reason: string }[];
}

/**
 * Creates the Farcaster copy of a post, for each opted-in account.
 *
 * Idempotent: the job key and `cross_posts (idea, account, dry_run)` both hold,
 * so running it again for the same idea (a restart, the existing-job path in
 * `originatePost`) changes nothing. Never throws: a failure to fan out is
 * recorded and logged, because the post it follows has already been made.
 */
export async function fanOutPost(input: FanOutInput): Promise<FanOutResult> {
  const result: FanOutResult = { queued: [], skipped: [] };
  // Only the primary network fans out. A post that is itself on Farcaster has
  // nothing to copy, and a copy is never copied again.
  if (input.originAccount.channel === 'farcaster') return result;
  let links: Awaited<ReturnType<typeof accountsRepo.listAgentAccounts>>;
  try { links = await accountsRepo.listAgentAccounts(input.agentId); }
  catch (error) {
    log.warn('could not list accounts to copy a post to', { agentId: input.agentId, message: errorMessage(error) });
    return result;
  }
  for (const link of links) {
    if (link.channel !== 'farcaster' || link.accountId === input.originAccount.id) continue;
    try {
      // Off unless asked for, and no record when it was never asked for.
      if (!(await crossPosts.farcasterPostingEnabled(link.accountId))) continue;
      const status = await farcasterPostingStatus(link.accountId, input.agentId);
      if (!status.available) {
        const recorded = await crossPosts.recordCrossPost(null, {
          agentId: input.agentId, ideaId: input.idea.id, originAccountId: input.originAccount.id,
          targetAccountId: link.accountId, channel: 'farcaster', dryRun: input.dryRun, jobId: null,
          status: 'SKIPPED', reason: status.reason ?? 'Unavailable.',
        });
        if (recorded.created) result.skipped.push({ accountId: link.accountId, reason: status.reason ?? 'Unavailable.' });
        continue;
      }
      const idempotencyKey = sha256Hex(`farcaster:${link.accountId}:${input.remoteEventId}:POST:${input.agentId}`);
      const created = await withTransaction(async (tx) => {
        const { event } = await eventsRepo.ingestEvent(tx, link.accountId, {
          channel: 'farcaster',
          type: 'SCHEDULED_TRIGGER',
          remoteEventId: input.remoteEventId,
          remoteMessageId: null,
          remoteAuthorId: null,
          remoteAuthorHandle: null,
          remoteAuthorDisplayName: null,
          remoteConversationId: null,
          parentRemoteMessageId: null,
          remoteUrl: null,
          text: `${input.brief}\n\nThis goes out as a Farcaster cast of at most ${FARCASTER_CAST_BYTES} bytes. Say the same thing in the same voice, shorter if it has to be.`,
          occurredAt: new Date().toISOString(),
          raw: {
            origin: 'self', ideaId: input.idea.id, ideaSummary: input.idea.summary, ideaSource: input.idea.source,
            mirrorOf: { accountId: input.originAccount.id, jobId: input.originJobId },
          },
        });
        const job = await jobsRepo.createJob(tx, {
          eventId: event.id,
          agentId: input.agentId,
          accountId: link.accountId,
          channel: 'farcaster',
          actionType: 'POST',
          idempotencyKey,
          dryRun: input.dryRun,
          maxAttempts: input.maxAttempts,
          ...input.versions,
          conversationId: null,
          requiresBrowser: getChannelAdapter('farcaster').requiresBrowser,
        });
        const recorded = await crossPosts.recordCrossPost(tx, {
          agentId: input.agentId, ideaId: input.idea.id, originAccountId: input.originAccount.id,
          targetAccountId: link.accountId, channel: 'farcaster', dryRun: input.dryRun, jobId: job.job.id,
          status: 'QUEUED', reason: '',
        });
        return job.created && recorded.created ? job.job.id : null;
      });
      if (created) result.queued.push(created);
    } catch (error) {
      // The primary post already exists. This network is allowed to fail alone.
      log.warn('a Farcaster copy of a post could not be queued', {
        agentId: input.agentId, accountId: link.accountId, message: errorMessage(error),
      });
    }
  }
  return result;
}

/**
 * Checked again at send, on the job that is about to publish.
 *
 * The owner may have switched Farcaster posting off since the job was queued,
 * and a switch that only stopped future jobs would not be a kill switch.
 * A rehearsal publishes nothing, so it is not stopped.
 */
export async function crossPostSendRefusal(
  payload: unknown, accountId: string | null, dryRun: boolean, text: string,
): Promise<{ reason: string; message: string } | null> {
  if (!mirrorOf(payload)) return null;
  if (!dryRun && (!accountId || !(await crossPosts.farcasterPostingEnabled(accountId)))) {
    return { reason: 'farcaster_posting_off', message: 'Posting to Farcaster was switched off for this account, so nothing was cast.' };
  }
  if (Buffer.byteLength(text) > FARCASTER_CAST_BYTES) {
    return { reason: 'farcaster_cast_length',
      message: `This cast is ${Buffer.byteLength(text)} bytes and a Farcaster cast holds ${FARCASTER_CAST_BYTES}. It was not shortened for you; the post on the other network is unaffected.` };
  }
  return null;
}
