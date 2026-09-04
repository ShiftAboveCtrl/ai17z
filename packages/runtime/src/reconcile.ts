import type { EventType, NormalizedEvent, RadarCandidate, RadarSourceKind } from '@xbam/shared/contracts';
import { EVENT_TYPES } from '@xbam/shared/contracts';
import { createLogger } from '@xbam/shared';
import { radar as radarRepo } from '@xbam/database';
import { ingestNormalizedEvent, type IngestOutcome } from './ingest';

const log = createLogger('reconcile');

/**
 * Turns what several monitors saw into events.
 *
 * The whole point of the radar is that the same post can arrive through
 * notifications, a mention search, and a thread walk within the same minute.
 * That is one post and must be one job, or an agent replies to the same person
 * three times.
 *
 * Identity comes from the post itself — its status id — not from where it was
 * found. Everything else about a candidate is corroborating detail, and where
 * two sources disagree the more specific one wins.
 */

export interface ReconcileInput {
  accountId: string;
  sourceId: string | null;
  sourceKind: RadarSourceKind;
  candidates: RadarCandidate[];
  /**
   * False for a source that only informs context, such as a watched account.
   * Watching somebody is not permission to reply to them.
   */
  mayTrigger: boolean;
}

export interface ReconcileResult {
  /** Candidates that produced a job. */
  created: number;
  /** Candidates already known from any source. */
  corroborated: number;
  /** Candidates skipped because this source may not trigger work. */
  contextOnly: number;
  /** Events created, for the caller's log. */
  outcomes: IngestOutcome[];
}

/** Candidates carry a loose event type; only real ones survive. */
/**
 * What the monitors call a thing, translated into what the runtime calls it.
 *
 * The tracked_account and tracked_keyword monitors both call
 * `harvest(ctx, 'POST', ...)`, and 'POST' is not one of EVENT_TYPES. The old
 * fallback turned every one of them into a MENTION -- an event claiming
 * somebody had addressed the agent when nobody had. MENTION is in the default
 * trigger set, so watching an account quietly meant replying to everything it
 * posted, and the inbox, which selects mentions by type, filled with strangers.
 */
const MONITOR_WORDS: Record<string, EventType> = {
  // Found by watching rather than by being addressed. The enum's word for it.
  POST: 'KEYWORD_MATCH',
  QUOTE: 'KEYWORD_MATCH',
};

function eventType(candidate: RadarCandidate): EventType {
  const claimed = candidate.eventType.toUpperCase();
  if ((EVENT_TYPES as readonly string[]).includes(claimed)) return claimed as EventType;

  const translated = MONITOR_WORDS[claimed];
  if (translated) return translated;

  // Anything else is a monitor this build does not know about. Recorded, so it
  // is not lost, but as a discovery rather than as a mention: an unrecognised
  // word must never be able to claim the agent was addressed, because that is
  // the one type that acts on its own.
  log.warn('monitor reported an event type this build does not know', { claimed });
  return 'KEYWORD_MATCH';
}

function toEvent(candidate: RadarCandidate): NormalizedEvent {
  return {
    channel: 'x',
    type: eventType(candidate),
    // The post's own id. This is the reconciliation key, and it is also the
    // idempotency key the events table already enforces, so two sources
    // reporting the same post cannot produce two events even if this function
    // is called twice concurrently.
    remoteEventId: candidate.remoteId,
    remoteMessageId: candidate.remoteId,
    remoteAuthorId: candidate.authorId,
    remoteAuthorHandle: candidate.authorHandle,
    remoteAuthorDisplayName: candidate.authorDisplayName,
    remoteConversationId: candidate.conversationRemoteId ?? candidate.remoteId,
    parentRemoteMessageId: candidate.parentRemoteId,
    remoteUrl: candidate.remoteUrl,
    text: candidate.text,
    occurredAt: candidate.occurredAt,
    raw: candidate.raw,
  };
}

/**
 * Reconciles one poll's candidates into events.
 *
 * Deduplication within the batch happens first: a single timeline can show the
 * same post twice, and there is no reason to pay for that downstream.
 */
export async function reconcileCandidates(input: ReconcileInput): Promise<ReconcileResult> {
  const result: ReconcileResult = { created: 0, corroborated: 0, contextOnly: 0, outcomes: [] };

  const unique = new Map<string, RadarCandidate>();
  for (const candidate of input.candidates) {
    const existing = unique.get(candidate.remoteId);
    // Prefer whichever sighting knows more: a thread walk knows the parent, a
    // notification often does not.
    if (!existing || (!existing.parentRemoteId && candidate.parentRemoteId)) {
      unique.set(candidate.remoteId, candidate);
    }
  }

  for (const candidate of unique.values()) {
    // A source the owner is watching for context rather than to act on. The
    // post is still recorded -- it happened, and the agent may need it later to
    // know what a conversation is about -- but no agent is considered.
    //
    // This used to `continue` here, discarding the candidate outright while
    // counting it as "context only". Watching an account for context produced
    // no context, no event, and no record that anything had been seen.
    const recordOnly = !input.mayTrigger;
    const outcome = await ingestNormalizedEvent({
      accountId: input.accountId,
      event: toEvent(candidate),
      recordOnly,
    });

    // Recorded whether or not the event is new: knowing that a source keeps
    // finding things another source already found is how you tell which
    // monitors are earning their place.
    await radarRepo.recordDiscovery({
      eventId: outcome.eventId,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
    });

    if (recordOnly) result.contextOnly += 1;
    else if (outcome.eventCreated) result.created += 1;
    else result.corroborated += 1;
    result.outcomes.push(outcome);
  }

  if (result.created > 0 || result.corroborated > 0 || result.contextOnly > 0) {
    log.info('reconciled radar candidates', {
      source: input.sourceKind,
      created: result.created,
      corroborated: result.corroborated,
      contextOnly: result.contextOnly,
    });
  }
  return result;
}

/**
 * The default set of monitors for a new X account.
 *
 * Notifications alone was the old behaviour and the reason a missed
 * notification meant a missed mention. Search runs alongside it precisely so
 * one surface being incomplete is no longer silence.
 */
/**
 * How often each surface is read, and why they differ.
 *
 * The interval is the floor on how long somebody waits to be noticed, and it
 * was three minutes on every source. For an account whose whole point is
 * answering people, three minutes of silence before the agent has even *seen*
 * the message is most of the delay a person experiences.
 *
 * Notifications is the fastest and cheapest surface -- X has already decided
 * something is addressed to you -- and it has a tab to itself, so it can be read
 * often without queueing behind anything.
 *
 * The other three share the MENTIONS tab and therefore each other's time. A page
 * load and a scroll is ten to twenty seconds, so putting all three on the same
 * short interval just makes them wait for one another. They are staggered
 * instead: the one most likely to catch what notifications dropped runs most
 * often, and the thread walk, which is the slowest and least urgent, runs least.
 */
export const DEFAULT_X_RADAR: { kind: RadarSourceKind; label: string; intervalSeconds: number }[] = [
  { kind: 'notifications', label: 'Notifications', intervalSeconds: 30 },
  { kind: 'mention_search', label: 'Mention search', intervalSeconds: 60 },
  { kind: 'reply_search', label: 'Reply search', intervalSeconds: 90 },
  { kind: 'own_threads', label: 'Replies to own posts', intervalSeconds: 180 },
];
