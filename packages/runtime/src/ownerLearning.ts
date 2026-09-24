/**
 * What the owner keeps saying yes and no to.
 *
 * Bounded, decaying, deterministic, and strictly about **order**. There is
 * nothing in this file that can grant a permission, skip an approval, widen
 * what a Plugin may do, or turn a proposal into an action. Permission is
 * `agent_capability_permissions` and the approval gate, and both are elsewhere
 * and untouched. This decides what an owner is shown first, and what they are
 * not shown again for a while.
 *
 * That boundary is the whole design. A preference system that can quietly
 * become an authority system is the thing to never build, and the way to not
 * build it is to have no path from here to a permission at all.
 *
 * No model is involved. "The owner rejected four of these" is a count, and a
 * count is a fact somebody can check; asking a model to characterise a pattern
 * of approvals would cost a call to produce an opinion nobody could audit.
 */

/** How long a signal takes to lose half its weight. */
const HALF_LIFE_DAYS = 21;

/**
 * How far this may move a proposal, in either direction.
 *
 * Small on purpose. The ordering is meant to be decided by what the decision
 * *is* -- a person who wrote in outranks a growth suggestion whatever either
 * scored -- and this is a nudge inside that, not a second ranking that can
 * overturn it. Twelve points cannot move a routine growth suggestion above a
 * mention, and it is not supposed to be able to.
 */
export const MAX_ADJUSTMENT = 12;

/**
 * How many decisions it takes to reach full weight.
 *
 * One rejection is somebody having an off day. Four is a preference. Without
 * this a single no would carry as much as a settled pattern, which is how a
 * learning system ends up overreacting to its first data point.
 */
const CONFIDENCE_AT = 4;

export interface Signal {
  accepted: number;
  rejected: number;
  lastDecisionAt: string;
  lastRejectedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60_000;

/** What a signal is worth now, given how long ago it was last touched. */
function decayed(count: number, lastAt: string, now: number): number {
  const age = now - new Date(lastAt).getTime();
  if (!Number.isFinite(age) || age <= 0) return count;
  return count * 2 ** (-(age / DAY_MS) / HALF_LIFE_DAYS);
}

/**
 * How far up or down this kind of proposal should move.
 *
 * Positive means the owner has been accepting these; negative means they have
 * been refusing them. Zero for anything with no history, which is most things.
 */
export function rankingAdjustment(signal: Signal | null, now = Date.now()): number {
  if (!signal) return 0;
  const accepted = decayed(signal.accepted, signal.lastDecisionAt, now);
  const rejected = decayed(signal.rejected, signal.lastDecisionAt, now);
  const total = accepted + rejected;
  if (total <= 0) return 0;

  // Between -1 and 1, scaled by how much has actually been decided so a thin
  // history moves things less than a settled one.
  const lean = (accepted - rejected) / total;
  const confidence = Math.min(total / CONFIDENCE_AT, 1);
  return Math.round(lean * confidence * MAX_ADJUSTMENT);
}

/**
 * How long a rejected proposal stays out of the way.
 *
 * Seven days because the point is that answering a question should settle it
 * for a while, and a proposal that comes back the same afternoon has not been
 * answered, it has been ignored. Material change is what brings it back early,
 * and a few minutes passing is not material change.
 */
export const REJECTION_COOLDOWN_DAYS = 7;

export interface SuppressionInput {
  signal: Signal | null;
  /**
   * Whether something real has changed about this proposal since it was
   * refused: a new message from the person, a different target, different
   * content, an owner setting that bears on it. Not the clock.
   */
  materiallyChanged?: boolean;
}

export interface Suppression {
  suppressed: boolean;
  /** A sentence, because "why am I not being asked about this" is a fair question. */
  reason: string;
  /** When it may be offered again, when it is being held. */
  until: string | null;
}

/**
 * Whether a substantially identical proposal should be offered again yet.
 *
 * Only ever about *asking*. A suppressed proposal is not refused and not
 * deleted: the work simply is not put in front of anybody, which is the
 * difference between a queue that respects an answer and one that keeps asking
 * until it gets a different one.
 */
export function suppressedByRejection(input: SuppressionInput, now = Date.now()): Suppression {
  const rejectedAt = input.signal?.lastRejectedAt;
  if (!rejectedAt || (input.signal?.rejected ?? 0) <= 0) {
    return { suppressed: false, reason: 'Nothing like this has been turned down.', until: null };
  }

  const until = new Date(rejectedAt).getTime() + REJECTION_COOLDOWN_DAYS * DAY_MS;
  if (now >= until) {
    return { suppressed: false, reason: 'The last refusal of this has worn off.', until: null };
  }

  if (input.materiallyChanged) {
    /*
      The escape hatch, and it has to be a real one. Without it a person who
      wrote in after being declined once would be silently ignored for a week,
      which is a worse fault than the repetition this exists to stop.
    */
    return {
      suppressed: false,
      reason: 'This was turned down before, but something real about it has changed since.',
      until: null,
    };
  }

  const days = Math.max(1, Math.ceil((until - now) / DAY_MS));
  return {
    suppressed: true,
    reason: `You turned down something substantially the same. Not asking again for ${days} ${days === 1 ? 'day' : 'days'}.`,
    until: new Date(until).toISOString(),
  };
}

/**
 * What makes two owner decisions about the same thing.
 *
 * Coarser than the attention window's own fingerprint on purpose: that one
 * decides whether two requests are the same *request*, and this decides
 * whether they are the same *kind of request*, which is what can be learned
 * from. Built only from structural facts, never from wording, so rephrasing a
 * draft does not make it a new question.
 */
export function decisionFingerprint(input: {
  kind: string;
  actionType: string;
  /** Who it concerns, where that is part of the decision. */
  handle?: string | null;
}): { fingerprint: string; family: string } {
  const family = `${input.kind}:${input.actionType}`.toLowerCase();
  const who = input.handle?.replace(/^@+/, '').toLowerCase() ?? '';
  return { fingerprint: who ? `${family}:${who}` : family, family };
}
