/**
 * Who is holding the keyboard: the agent, or the person.
 *
 * A hosted owner watches the same real Chrome their agent uses, and sometimes
 * has to type into it: an X sign-in, a CAPTCHA, a device check. The only thing
 * that must never happen is both of them acting at once, because an agent
 * clicking while somebody is typing a one-time code produces a mess nobody
 * can reconstruct and possibly a locked account.
 *
 * So control is a state machine with one owner at a time, and the interesting
 * state is `OWNER_REQUESTED`. A request does not take the page away: it asks,
 * and the agent gets to finish what it is in the middle of. AI17Z already
 * refuses to interrupt an irreversible browser operation half way through, and
 * handing the page to a person mid-submit is exactly that.
 *
 * Nothing in this file touches a keystroke. Input transport is deliberately
 * elsewhere, and `SENSITIVE_INPUT_RULES` below says what may never happen to
 * one, which a test asserts against the code that does carry them.
 */

export const TAKEOVER_STATES = [
  /** Ordinary running. The agent may read and write the page. */
  'AGENT_CONTROL',
  /** The owner asked. The agent finishes its current step and stops. */
  'OWNER_REQUESTED',
  /** The person has the page. The agent performs no writes at all. */
  'OWNER_CONTROL',
  /**
   * The page is waiting on a human and neither side should act: a CAPTCHA, a
   * second factor, a device confirmation. Reached from either side, and left
   * only by the owner.
   */
  'WAITING_FOR_HUMAN',
  /** The owner let go. The agent is about to resume and has not yet. */
  'RESUME_PENDING',
  /** No browser. Nobody holds anything. */
  'OFFLINE',
] as const;
export type TakeoverState = (typeof TAKEOVER_STATES)[number];

export const TAKEOVER_EVENTS = [
  'OWNER_REQUESTS',
  /** The agent reports it has reached a safe boundary and stopped. */
  'AGENT_YIELDED',
  'OWNER_RELEASES',
  'AGENT_RESUMED',
  /** A challenge was recognised on the page. Never answered by AI17Z. */
  'CHALLENGE_SEEN',
  'BROWSER_LOST',
  'BROWSER_READY',
] as const;
export type TakeoverEvent = (typeof TAKEOVER_EVENTS)[number];

/**
 * States in which the agent may write to the page.
 *
 * One list, because a pause enforced in four places is forgotten in a fifth.
 * Note that `OWNER_REQUESTED` is still here: the agent is finishing, and
 * cutting it off mid-operation is the thing this design exists to avoid. What
 * stops is starting anything new, which is `agentMayBegin`.
 */
const AGENT_MAY_WRITE: readonly TakeoverState[] = ['AGENT_CONTROL', 'OWNER_REQUESTED'];

/** Whether the agent may finish an operation already under way. */
export function agentMayWrite(state: TakeoverState): boolean {
  return AGENT_MAY_WRITE.includes(state);
}

/** Whether the agent may start something new. Narrower on purpose. */
export function agentMayBegin(state: TakeoverState): boolean {
  return state === 'AGENT_CONTROL';
}

/** Whether the owner's input should be delivered to the page. */
export function ownerMayType(state: TakeoverState): boolean {
  return state === 'OWNER_CONTROL' || state === 'WAITING_FOR_HUMAN';
}

/**
 * The transitions, written out rather than computed.
 *
 * An unlisted pair is refused, so a new event cannot quietly become legal
 * everywhere by being added to the enum. `BROWSER_LOST` is accepted from every
 * state because a browser can disappear at any moment and the state machine
 * must not be the thing that argues about it.
 */
const TRANSITIONS: Record<TakeoverState, Partial<Record<TakeoverEvent, TakeoverState>>> = {
  AGENT_CONTROL: {
    OWNER_REQUESTS: 'OWNER_REQUESTED',
    CHALLENGE_SEEN: 'WAITING_FOR_HUMAN',
    BROWSER_LOST: 'OFFLINE',
  },
  OWNER_REQUESTED: {
    // The agent says it has stopped at a safe point. Only then does the page
    // change hands.
    AGENT_YIELDED: 'OWNER_CONTROL',
    CHALLENGE_SEEN: 'WAITING_FOR_HUMAN',
    // Asking and then changing your mind puts it straight back.
    OWNER_RELEASES: 'AGENT_CONTROL',
    BROWSER_LOST: 'OFFLINE',
  },
  OWNER_CONTROL: {
    OWNER_RELEASES: 'RESUME_PENDING',
    CHALLENGE_SEEN: 'WAITING_FOR_HUMAN',
    BROWSER_LOST: 'OFFLINE',
  },
  WAITING_FOR_HUMAN: {
    // Only a person leaves this state. AI17Z never answers a challenge, so
    // there is no event here that an agent can raise.
    OWNER_REQUESTS: 'OWNER_CONTROL',
    OWNER_RELEASES: 'RESUME_PENDING',
    BROWSER_LOST: 'OFFLINE',
  },
  RESUME_PENDING: {
    AGENT_RESUMED: 'AGENT_CONTROL',
    // Changed their mind before the agent picked it up again.
    OWNER_REQUESTS: 'OWNER_CONTROL',
    CHALLENGE_SEEN: 'WAITING_FOR_HUMAN',
    BROWSER_LOST: 'OFFLINE',
  },
  OFFLINE: {
    BROWSER_READY: 'AGENT_CONTROL',
  },
};

export interface TakeoverResult {
  moved: boolean;
  state: TakeoverState;
  detail: string;
}

/**
 * Apply an event, or refuse it and say why.
 *
 * Refusing is not an error condition: two tabs open on the same agent will
 * both send `OWNER_RELEASES`, and the second one is simply already true. The
 * caller gets `moved: false` and the current state rather than an exception.
 */
export function applyTakeover(state: TakeoverState, event: TakeoverEvent): TakeoverResult {
  const next = TRANSITIONS[state][event];
  if (!next) {
    return { moved: false, state, detail: `${event} does not apply while ${state}.` };
  }
  return { moved: true, state: next, detail: `${event} moved ${state} to ${next}.` };
}

/**
 * What must never happen to something the owner typed.
 *
 * Kept as data so a test can assert the input path against it rather than
 * somebody remembering. An owner typing an X password or a one-time code into
 * their agent's browser is the single most sensitive thing this system
 * carries, and the honest position is that it is not logged, not stored, not
 * replayed and not put in telemetry anywhere.
 *
 * Note what this does not claim: the control plane relays the keystrokes, so
 * this is minimisation and discipline, not end-to-end encryption. Saying
 * otherwise would be claiming a guarantee the architecture does not deliver.
 */
export const SENSITIVE_INPUT_RULES: readonly string[] = [
  'Owner input is never written to a log at any level.',
  'Owner input is never persisted, not even transiently, in a database or a file.',
  'Owner input is never replayed, retried or queued after a delivery failure.',
  'Owner input never appears in telemetry, traces, metrics or an audit row.',
  'An audit row records that a takeover happened and for how long, never what was typed.',
  'A CAPTCHA, a second factor and a device confirmation are answered by the person only.',
];

/**
 * How a screencast is bounded.
 *
 * Every number maps to a real parameter of `Page.startScreencast` rather than
 * to an intention: frame rate through `everyNthFrame`, size through
 * `maxWidth` and `maxHeight`, bandwidth through `format` and `quality`. The
 * acknowledgement is the one that actually protects the host, because Chrome
 * waits for it, so a slow owner connection cannot make a host buffer without
 * limit.
 */
export const STREAM_BOUNDS = {
  format: 'jpeg' as const,
  quality: 60,
  maxWidth: 1280,
  maxHeight: 800,
  /** Chrome sends one frame in this many, so roughly a third of the page rate. */
  everyNthFrame: 3,
  /** Frames allowed in flight before the host stops acknowledging. */
  maxUnackedFrames: 2,
  /** A stream with nobody watching is stopped rather than left running. */
  idleStopAfterMs: 30_000,
  /** Recording is off. Frames are relayed and not kept. */
  record: false,
} as const;

/**
 * Whether another frame may be sent, given what has not been acknowledged.
 *
 * This is the backpressure, and it belongs here rather than in the transport
 * so it can be reasoned about without a browser: Chrome will keep producing
 * frames as long as they are acknowledged, so the host declines to acknowledge
 * instead of growing a queue.
 */
export function maySendFrame(unacked: number): boolean {
  return unacked < STREAM_BOUNDS.maxUnackedFrames;
}
