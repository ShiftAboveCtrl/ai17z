import {
  TRADE_NO_RESIGN_STATUSES,
  type ApprovalMode,
  type TradeIntentStatus,
  type TradeMode,
} from '@xbam/shared';

/**
 * From an approved intent to a transaction that exists exactly once.
 *
 * The question this file answers is the one the local product already asks of
 * every X action: can this send the same thing twice. For a reply the answer
 * costs an embarrassment. For a transfer it costs money, and unlike a reply it
 * cannot be deleted, so the guards are stricter and there is no retry anywhere
 * in here.
 *
 * Three things it refuses, and the third is the one that is easy to get wrong.
 *
 * A signature is produced once. `TRADE_NO_RESIGN_STATUSES` in the contracts is
 * the list, and `maySign` is the only thing that reads it, so there is one
 * answer rather than one per call site.
 *
 * PAPER never signs. The mode is checked here as well as at creation, because
 * a mandate can be read at one moment and acted on at another, and an
 * execution path that trusts an earlier read is an execution path that signs
 * on a mandate somebody has since changed.
 *
 * And **UNKNOWN is never retried**. A broadcast whose outcome nobody saw is
 * the exact case where trying again creates a second real transaction. The
 * only way out of it is asking the network what happened, which is the same
 * reasoning as `wasAlreadyDone` asking X whether a reply landed: a worker that
 * died between sending and recording is indistinguishable from one that died
 * before sending, and the system cannot mark its own homework.
 */

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SignContext {
  status: TradeIntentStatus;
  /** The mandate's mode as read in this moment, not as read earlier. */
  mode: TradeMode;
  approval: ApprovalMode;
  /** Whether a person has approved this exact intent. */
  ownerApproved: boolean;
  /** Any pause in force that covers this intent. */
  paused: boolean;
  /** Whether the quote this was built against is still inside its validity. */
  quoteFresh: boolean;
  /** Whether a signer is actually available. Absent is not a reason to improvise. */
  signerAvailable: boolean;
}

export type SignVerdict = { sign: true } | { sign: false; why: readonly string[] };

/**
 * Whether a signature may be produced for this intent, right now.
 *
 * Every reason rather than the first, because the owner reading a declined
 * trade wants all of why, and because a list makes it obvious when two
 * conditions failed for the same underlying reason.
 */
export function maySign(context: SignContext): SignVerdict {
  const why: string[] = [];

  if (TRADE_NO_RESIGN_STATUSES.includes(context.status)) {
    why.push(
      `This intent is ${context.status}, and a new signature is never produced from there. Signing again is how one decision becomes two transactions.`,
    );
  }
  if (context.status !== 'APPROVED' && context.status !== 'SIMULATED') {
    why.push(`An intent is signed from APPROVED or SIMULATED, not from ${context.status}.`);
  }
  if (context.mode === 'PAPER') {
    why.push('This mandate is in PAPER mode, which never signs anything whatever else it allows.');
  }
  if (context.approval === 'OWNER_APPROVES_EACH' && !context.ownerApproved) {
    why.push('This mandate asks the owner about every trade and this one has not been approved.');
  }
  if (context.paused) {
    why.push('A pause covering this intent is in force.');
  }
  if (!context.quoteFresh) {
    why.push('The quote this was built against has expired. A stale quote is a different trade.');
  }
  if (!context.signerAvailable) {
    why.push('No signer is available. Absent is not a reason to improvise one.');
  }

  return why.length === 0 ? { sign: true } : { sign: false, why };
}

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

export type BroadcastResult =
  /** The network accepted it and named it. */
  | { kind: 'ACCEPTED'; txIdentity: string }
  /** The network refused it, and said so. A refusal is not an unknown. */
  | { kind: 'REFUSED'; why: string }
  /**
   * Nobody saw what happened: a timeout, a dropped connection, a process that
   * died. This is the dangerous one.
   */
  | { kind: 'UNSEEN'; why: string };

export interface BroadcastDecision {
  status: TradeIntentStatus;
  /** Whether anything may be sent again. False for UNSEEN, which is the point. */
  mayRetry: boolean;
  /** What a person or a sweep should do next, in a sentence. */
  next: string;
  txIdentity?: string;
}

/**
 * What a broadcast's outcome means for the intent.
 *
 * `REFUSED` and `UNSEEN` are kept apart deliberately, exactly as the market
 * reader keeps NOT_LISTED and UNAVAILABLE apart. A network that refused a
 * transaction has told us nothing was sent, and that is safe to act on; a
 * connection that dropped has told us nothing at all, and treating the second
 * as the first is a duplicate-transaction machine.
 */
export function afterBroadcast(result: BroadcastResult): BroadcastDecision {
  if (result.kind === 'ACCEPTED') {
    return {
      status: 'SUBMITTED',
      mayRetry: false,
      next: 'Wait for confirmation. The identity is recorded, so nothing needs to be sent again.',
      txIdentity: result.txIdentity,
    };
  }
  if (result.kind === 'REFUSED') {
    return {
      status: 'FAILED',
      // Safe only because the network said so. A refusal is evidence that
      // nothing was sent, and it is the only outcome here that is.
      mayRetry: true,
      next: `The network refused it: ${result.why}. Nothing was sent, so a new intent may be drafted.`,
    };
  }
  return {
    status: 'UNKNOWN',
    mayRetry: false,
    next: `Nobody saw what happened: ${result.why}. Ask the network what exists before anything else is signed. Never send it again to find out.`,
  };
}

// ---------------------------------------------------------------------------
// The only way out of UNKNOWN
// ---------------------------------------------------------------------------

export type RemoteAnswer =
  /** The network has it, under this identity. */
  | { kind: 'FOUND'; txIdentity: string; confirmed: boolean }
  /**
   * The network is authoritatively sure nothing matching exists, which usually
   * means a nonce or a slot has moved past it so it can never land.
   */
  | { kind: 'DEFINITELY_ABSENT'; why: string }
  /** The network could not be asked, or would not say. */
  | { kind: 'STILL_UNKNOWN'; why: string };

export type UnknownResolution =
  | { status: 'CONFIRMED' | 'SUBMITTED'; txIdentity: string; detail: string }
  | { status: 'FAILED'; detail: string }
  | { status: 'UNKNOWN'; detail: string; needsPerson: boolean };

/**
 * Resolves an UNKNOWN by asking the network rather than by assuming.
 *
 * `STILL_UNKNOWN` stays UNKNOWN, and after enough attempts it asks for a
 * person rather than continuing to sweep. That is deliberate: a sweep that
 * never gives up looks like progress and is the state in which somebody
 * eventually resends by hand to make it stop.
 */
export function resolveUnknown(answer: RemoteAnswer, attempts: number): UnknownResolution {
  if (answer.kind === 'FOUND') {
    return answer.confirmed
      ? { status: 'CONFIRMED', txIdentity: answer.txIdentity, detail: 'The network has it and it is confirmed.' }
      : { status: 'SUBMITTED', txIdentity: answer.txIdentity, detail: 'The network has it and has not confirmed it yet.' };
  }
  if (answer.kind === 'DEFINITELY_ABSENT') {
    return {
      status: 'FAILED',
      detail: `Nothing was sent: ${answer.why}. This intent is closed, and a new one may be drafted if the trade still makes sense.`,
    };
  }
  return {
    status: 'UNKNOWN',
    detail: `Still unknown: ${answer.why}.`,
    // Enough tries to cover a network having a bad few minutes, and few
    // enough that a genuinely stuck intent reaches a person the same day.
    needsPerson: attempts >= UNKNOWN_ATTEMPTS_BEFORE_PERSON,
  };
}

export const UNKNOWN_ATTEMPTS_BEFORE_PERSON = 12;

// ---------------------------------------------------------------------------
// What the model may never reach
// ---------------------------------------------------------------------------

/**
 * The verbs that are never exposed as a capability, in the words somebody
 * would use when proposing one.
 *
 * Kept as data so a test can assert the capability registry carries none of
 * them, rather than as a paragraph somebody has to remember. A model proposes
 * a `TradeIntent` against a mandate the owner wrote, and that is the entire
 * surface: every one of these would let a model choose the destination, the
 * amount or the calldata, which is the whole of what a mandate exists to
 * decide instead.
 */
export const NEVER_MODEL_CALLABLE: readonly string[] = [
  'send',
  'transfer',
  'approve',
  'sign',
  'signMessage',
  'signTypedData',
  'contractCall',
  'rawTransaction',
  'calldata',
  'arbitraryDestination',
  'sweep',
  'withdraw',
  'deposit',
  'bridge',
  'setAllowance',
];

export type SurfaceVerdict = { ok: true } | { ok: false; why: string };

/** Whether a proposed capability id would cross that line. */
export function capabilityCrossesTheLine(capabilityId: string): SurfaceVerdict {
  const tail = capabilityId.split('.').pop() ?? capabilityId;
  const squashed = tail.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const verb of NEVER_MODEL_CALLABLE) {
    if (squashed === verb.toLowerCase()) {
      return {
        ok: false,
        why: `${capabilityId} would let a model choose a destination, an amount or calldata. A model proposes a TradeIntent against the owner's mandate, and that is the whole surface.`,
      };
    }
  }
  return { ok: true };
}

export const EXECUTION_CAVEATS: readonly string[] = [
  'No funded transaction has been built, signed or broadcast from this repository, and none is authorised.',
  'UNKNOWN is never retried. The only way out of it is asking the network what exists, because a broadcast nobody saw is exactly where a retry creates a second real transaction.',
  'A refusal from the network is evidence that nothing was sent. A dropped connection is evidence of nothing, and treating the second as the first is a duplicate-transaction machine.',
  'PAPER never signs, and the mode is re-read here rather than trusted from an earlier read, because a mandate can change between the two.',
  'No generic transaction verb is exposed to a model. NEVER_MODEL_CALLABLE is the list, and a test holds the capability registry against it.',
];
