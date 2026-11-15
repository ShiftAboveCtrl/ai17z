/** Where an evidence follow-up stands. The database CHECK on `evidence_followups.status` lists the same four. */
export const EVIDENCE_FOLLOW_UP_STATES = ['pending', 'queued', 'rehearsed', 'skipped'] as const;
export type EvidenceFollowUpState = (typeof EVIDENCE_FOLLOW_UP_STATES)[number];

/** A reading older than this is history, not news, and is never sent as a follow-up. */
export const EVIDENCE_FOLLOW_UP_MAX_AGE_MS = 30 * 60_000;
/** Real follow-ups one agent may send in a UTC day, across every card. */
export const EVIDENCE_FOLLOW_UP_DAILY_CAP = 3;

/** Marks the event a follow-up job was manufactured from. Nothing a stranger writes reaches an event's `raw` this way: ingest builds it from the channel, and this is set only by the sweep. */
export const EVIDENCE_FOLLOW_UP_ORIGIN = 'evidence-follow-up';

export function isEvidenceFollowUpEvent(payload: unknown): boolean {
  return (payload as { origin?: unknown } | null)?.origin === EVIDENCE_FOLLOW_UP_ORIGIN;
}

/** The two sides of a mint comparison, as stored in `evidence_compare_requests.side` (CHECK IN (0, 1)). */
export const EVIDENCE_COMPARE_SIDES = [0, 1] as const;
