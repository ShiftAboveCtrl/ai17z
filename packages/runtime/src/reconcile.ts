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
function eventType(candidate: RadarCandidate): EventType {
  const claimed = candidate.eventType.toUpperCase();
  return (EVENT_TYPES as readonly string[]).includes(claimed) ? (claimed as EventType) : 'MENTION';
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
    if (!input.mayTrigger) {
      result.contextOnly += 1;
      continue;
    }

    const outcome = await ingestNormalizedEvent({ accountId: input.accountId, event: toEvent(candidate) });

    // Recorded whether or not the event is new: knowing that a source keeps
    // finding things another source already found is how you tell which
    // monitors are earning their place.
    await radarRepo.recordDiscovery({
      eventId: outcome.eventId,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
    });

    if (outcome.eventCreated) result.created += 1;
    else result.corroborated += 1;
    result.outcomes.push(outcome);
  }

  if (result.created > 0 || result.corroborated > 0) {
    log.info('reconciled radar candidates', {
      source: input.sourceKind,
      created: result.created,
      corroborated: result.corroborated,
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
export const DEFAULT_X_RADAR: { kind: RadarSourceKind; label: string; intervalSeconds: number }[] = [
  { kind: 'notifications', label: 'Notifications', intervalSeconds: 120 },
  { kind: 'mention_search', label: 'Mention search', intervalSeconds: 180 },
  { kind: 'reply_search', label: 'Reply search', intervalSeconds: 240 },
  { kind: 'own_threads', label: 'Replies to own posts', intervalSeconds: 300 },
];
