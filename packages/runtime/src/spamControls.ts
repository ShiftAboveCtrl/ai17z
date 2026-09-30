/**
 * The owner's hand on the spam defense: mark one post spam or not spam, keep
 * an account out of the agent's attention, and see what was filtered.
 *
 * "Spam" labels that one post, counts once toward its text and its author, and
 * does nothing else: it never blocks the author for ever and never touches
 * anybody the post mentioned. "Not spam" is the strong correction. It clears
 * the post, marks its text as fine for the future, and offers the post to the
 * agent now if it was filtered, the way a manual trigger does.
 */
import { NotFoundError, ForbiddenError } from '@xbam/shared';
import type { NormalizedEvent } from '@xbam/shared/contracts';
import { accounts as accountsRepo, events as eventsRepo, ops, spam as spamRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from './ingest';

async function ownedEvent(eventId: string, ownerUserId: string) {
  const event = await eventsRepo.getEvent(eventId);
  if (!event || !event.accountId) throw new NotFoundError('Post');
  const account = await accountsRepo.getAccount(event.accountId);
  if (!account || account.ownerId !== ownerUserId) throw new ForbiddenError('That post arrived on somebody else’s account.');
  return { event, account };
}

export async function labelInbound(input: { eventId: string; ownerUserId: string; label: 'SPAM' | 'NOT_SPAM' }) {
  const { event, account } = await ownedEvent(input.eventId, input.ownerUserId);
  if (!(await spamRepo.verdictFor(event.id))) {
    // A post from before the screen existed has no verdict to correct yet.
    await query(
      `INSERT INTO inbound_spam (event_id, account_id, verdict, score, reasons, decided_by, classifier_verdict)
       VALUES ($1, $2, 'CLEAN', 0, '[]'::jsonb, 'CLASSIFIER', 'CLEAN') ON CONFLICT (event_id) DO NOTHING`,
      [event.id, account.id],
    );
  }
  const verdict = await spamRepo.ownerLabel(event.id, input.label);
  await ops.audit({
    actorUserId: input.ownerUserId,
    action: input.label === 'SPAM' ? 'inbound.marked_spam' : 'inbound.marked_not_spam',
    entityType: 'account',
    entityId: account.id,
    data: { eventId: event.id, author: event.remoteAuthorHandle },
  });

  // Offered to the agent now, if the filter had kept it from being considered.
  let requeued = 0;
  if (input.label === 'NOT_SPAM') {
    const links = await accountsRepo.listAccountAgents(account.id);
    for (const link of links) {
      const existing = await query(`SELECT 1 FROM jobs WHERE agent_id = $1 AND event_id = $2 LIMIT 1`, [link.agentId, event.id]);
      if (existing.length > 0) continue;
      const outcome = await ingestNormalizedEvent({ accountId: account.id, event: asNormalized(event), onlyAgentId: link.agentId });
      requeued += outcome.jobs.filter((j) => j.created).length;
    }
  }
  return { verdict, requeued };
}

export async function muteActor(input: { accountId: string; ownerUserId: string; handle: string; muted: boolean }) {
  const account = await accountsRepo.getAccount(input.accountId);
  if (!account || account.ownerId !== input.ownerUserId) throw new NotFoundError('Account');
  await spamRepo.setMuted(account.id, input.handle, input.muted);
  await ops.audit({
    actorUserId: input.ownerUserId,
    action: input.muted ? 'inbound.actor_muted' : 'inbound.actor_unmuted',
    entityType: 'account',
    entityId: account.id,
    data: { handle: spamRepo.handleKey(input.handle) },
  });
}

/** What the defense did, and what it is holding back, across the owner's accounts. */
export async function spamOverview(ownerUserId: string, days = 7) {
  const accounts = (await accountsRepo.listAccounts(ownerUserId)).map((a) => a.id);
  if (accounts.length === 0) return { metrics: null, quarantined: [] };
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [metrics, quarantined] = await Promise.all([spamRepo.metrics(accounts, since), spamRepo.quarantined(accounts, 50)]);
  return { metrics: { ...metrics, modelCallsAvoided: metrics.filtered * AVERAGE_MODEL_CALLS_PER_REPLY }, quarantined };
}

/**
 * Roughly what a reply costs in model calls: the draft, and on a normal
 * installation a voice pass, sometimes a plan. Stated as an estimate on the
 * screen, because the calls that did not happen cannot be counted.
 */
const AVERAGE_MODEL_CALLS_PER_REPLY = 2;

function asNormalized(event: Awaited<ReturnType<typeof eventsRepo.getEvent>> & object): NormalizedEvent {
  return {
    channel: event.channel,
    type: event.type as NormalizedEvent['type'],
    remoteEventId: event.remoteEventId,
    remoteMessageId: event.remoteMessageId ?? event.remoteEventId,
    remoteAuthorId: event.remoteAuthorId ?? null,
    remoteAuthorHandle: event.remoteAuthorHandle ?? null,
    remoteAuthorDisplayName: event.remoteAuthorDisplay ?? null,
    remoteConversationId: event.remoteConversationId ?? null,
    parentRemoteMessageId: event.parentRemoteMessageId ?? null,
    remoteUrl: event.remoteUrl ?? null,
    text: event.text,
    occurredAt: event.occurredAt ?? null,
    raw: event.payload ?? {},
  } as NormalizedEvent;
}
