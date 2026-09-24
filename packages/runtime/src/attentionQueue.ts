/**
 * What an owner is asked to look at, bounded to what a person will actually
 * look at.
 *
 * There is no queue table and there must not be one. A job waiting for a
 * person already *is* the request: `WAITING_FOR_APPROVAL` and
 * `REVIEW_REQUIRED` are the two states that mean it, `approveJob` and
 * `rejectJob` are how they are answered, and every gate that put a job there
 * stays exactly where it is. This is a read model over those rows, in the same
 * sense that the inbox is a read model over events, and for the same reason: a
 * second store of "what needs deciding" would drift from the first, and the
 * first is the one the runtime obeys.
 *
 * What it adds is an order and a ceiling.
 *
 * Measured on a live installation: seventy-one jobs were waiting for the
 * owner. Every one of them was an unprompted approach to a stranger found by
 * a keyword search, and not one was a message from a person. A list like that
 * is not a decision queue, it is a wall, and the thing it is worst at is the
 * thing it exists for -- if somebody had written in and their reply needed a
 * judgement, it would have been item seventy-two.
 *
 * So the visible window is small, ordered by what the decision actually is,
 * and no single repetitive category may fill it. Nothing is deleted: what does
 * not fit is backlog, counted and described, and it comes forward as the
 * visible items are answered.
 */

/** How many decisions an owner is shown at once. */
export const VISIBLE_LIMIT = 15;

/**
 * How much of the window one kind of request may take.
 *
 * Seventy-one identical growth suggestions taught this: a cap on the total is
 * no protection at all when one category can supply every slot. Six leaves
 * more than half the window for everything else, and a seventh suggestion of
 * the same kind is not telling the owner anything the first six did not.
 */
export const PER_CATEGORY_LIMIT = 6;

/**
 * What kind of decision this is, in the order a person should meet them.
 *
 * Deliberately about the *decision*, never about the score. A growth
 * suggestion that scored 94 is still a growth suggestion, and somebody's
 * question is still somebody's question at 40.
 */
export type RequestKind =
  | 'SECURITY'
  | 'DIRECT_INBOUND'
  | 'IRREVERSIBLE'
  | 'AGENT_DECISION'
  | 'GROWTH_OPPORTUNITY'
  | 'ROUTINE_GROWTH';

const RANK: Record<RequestKind, number> = {
  SECURITY: 0,
  DIRECT_INBOUND: 1,
  IRREVERSIBLE: 2,
  AGENT_DECISION: 3,
  GROWTH_OPPORTUNITY: 4,
  ROUTINE_GROWTH: 5,
};

/** Human-readable names, so a grouped row can say what it is a group of. */
export const KIND_LABELS: Record<RequestKind, string> = {
  SECURITY: 'Needs you to sign in or clear a security check',
  DIRECT_INBOUND: 'Somebody wrote to this agent',
  IRREVERSIBLE: 'Something that cannot be taken back',
  AGENT_DECISION: 'A decision the agent made',
  GROWTH_OPPORTUNITY: 'A conversation that looks worth joining',
  ROUTINE_GROWTH: 'Speaking first to somebody who did not ask',
};

/** A request is stale when the thing it was about is no longer live. */
export type Staleness = 'LIVE' | 'EXPIRED' | 'SUPERSEDED';

export interface PendingRequest {
  jobId: string;
  agentId: string;
  /** What produced it: MENTION, REPLY, KEYWORD_MATCH, SCHEDULED_TRIGGER. */
  eventType: string;
  actionType: string;
  /** Who it concerns, for per-person grouping. */
  authorHandle: string | null;
  /** The thread, so one conversation does not produce four questions. */
  conversationRef: string | null;
  createdAt: string;
  /** The engagement score, used only to order within one kind. */
  value: number | null;
  /** Whether the post it is about still exists, when that is known. */
  sourceGone?: boolean;
  /** Set when a later request about the same thing replaced this one. */
  supersededBy?: string | null;
}

export interface RankedRequest extends PendingRequest {
  kind: RequestKind;
  staleness: Staleness;
  /** What makes two requests the same question. */
  fingerprint: string;
}

export interface AttentionWindow {
  visible: RankedRequest[];
  /** Everything ranked below the window, kept and counted, never deleted. */
  backlogCount: number;
  /** How much of the backlog is each kind, so the count means something. */
  backlogByKind: Partial<Record<RequestKind, number>>;
  /** Requests whose subject is gone. They keep their row and lose their slot. */
  staleCount: number;
  /** How many requests were folded into another because they ask the same thing. */
  groupedCount: number;
}

/**
 * How old an unanswered request may be before it stops asking.
 *
 * Seven days because an approach to a stranger about a week-old post is not a
 * decision any more, whatever the owner decides. The row stays; it simply
 * stops competing for a slot with something that is still live.
 */
const EXPIRES_AFTER_MS = 7 * 24 * 60 * 60_000;

/** Somebody wrote to the agent, as opposed to the agent finding a post. */
const DIRECT = new Set(['MENTION', 'REPLY', 'DIRECT_MESSAGE']);

/**
 * Which of the six kinds this request is.
 *
 * Read off what the job is for, never off a field somebody has to remember to
 * set. A kind derived from the event and the action cannot disagree with the
 * job, and there is nothing to keep in step.
 */
export function requestKindOf(request: PendingRequest): RequestKind {
  // An account waiting on a sign-in or a security challenge is not a job and
  // never will be, so it arrives here as a request the caller built. AI17Z
  // never answers a challenge, and the one thing it can do about one is put it
  // at the top of the list.
  if (request.eventType === 'SECURITY_HOLD') return 'SECURITY';
  if (DIRECT.has(request.eventType)) return 'DIRECT_INBOUND';
  // A post has no target and reaches everybody following the account. That is
  // a different weight of decision from a reply under somebody else's post,
  // whatever either of them says.
  if (request.actionType === 'POST' || request.actionType === 'REPOST') return 'IRREVERSIBLE';
  if (request.eventType === 'SCHEDULED_TRIGGER') return 'AGENT_DECISION';
  // An unprompted approach. Worth showing, and the thing there is most of.
  return (request.value ?? 0) >= 80 ? 'GROWTH_OPPORTUNITY' : 'ROUTINE_GROWTH';
}

/**
 * What makes two requests the same question.
 *
 * One root conversation should normally produce one active request. Three
 * suggestions to join the same thread are one decision asked three times, and
 * answering it once should settle it.
 *
 * Grouped only within a kind, and never across a high-impact boundary: two
 * unrelated irreversible actions are two decisions however similar they look,
 * which is why the kind is part of the fingerprint rather than something
 * checked afterwards.
 */
export function requestFingerprint(request: PendingRequest, kind: RequestKind): string {
  const who = request.authorHandle?.replace(/^@+/, '').toLowerCase() ?? '';
  // A person's own message is theirs alone, and two irreversible actions are
  // two decisions however alike they look. Folding either into another one is
  // answering it by accident.
  if (kind === 'DIRECT_INBOUND' || kind === 'IRREVERSIBLE' || kind === 'SECURITY') {
    return `${kind}:${request.jobId}`;
  }
  /*
    An approach is a decision about a person, not about a thread.

    Grouping these on the conversation was the first attempt and it left the
    same stranger holding two of twelve places on the live installation, for
    two posts they happened to have written. There is only one decision there,
    and the policy already knows it: `cooldownDaysPerAuthor` permits one
    unprompted approach per person per week, so approving the second would be
    refused anyway. Asking twice is asking about something that cannot happen.
  */
  return `${kind}:${who || request.conversationRef || request.jobId}`;
}

function stalenessOf(request: PendingRequest, now: number): Staleness {
  if (request.supersededBy) return 'SUPERSEDED';
  if (request.sourceGone) return 'EXPIRED';
  const age = now - new Date(request.createdAt).getTime();
  return Number.isFinite(age) && age > EXPIRES_AFTER_MS ? 'EXPIRED' : 'LIVE';
}

/**
 * Orders the pending requests and takes the top fifteen.
 *
 * Pure, and takes rows rather than reading them, because what is worth pinning
 * is the ordering and the ceiling rather than a query. Everything that does
 * not fit is counted rather than discarded: this is an attention window, not a
 * deletion.
 */
export function attentionWindow(
  requests: PendingRequest[],
  options: { now?: number; limit?: number } = {},
): AttentionWindow {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? VISIBLE_LIMIT;

  const ranked: RankedRequest[] = requests.map((request) => {
    const kind = requestKindOf(request);
    return { ...request, kind, staleness: stalenessOf(request, now), fingerprint: requestFingerprint(request, kind) };
  });

  // One question, asked once. The oldest of a group is kept, because that is
  // the one the owner may already have seen.
  const byFingerprint = new Map<string, RankedRequest>();
  let groupedCount = 0;
  for (const request of [...ranked].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (byFingerprint.has(request.fingerprint)) {
      groupedCount += 1;
      continue;
    }
    byFingerprint.set(request.fingerprint, request);
  }

  const live = [...byFingerprint.values()].filter((r) => r.staleness === 'LIVE');
  const staleCount = ranked.length - groupedCount - live.length;

  live.sort((a, b) => {
    if (RANK[a.kind] !== RANK[b.kind]) return RANK[a.kind] - RANK[b.kind];
    // Within a kind, the stronger candidate first, then the older one: an
    // owner working down the list should meet the best of each sort first.
    if ((b.value ?? 0) !== (a.value ?? 0)) return (b.value ?? 0) - (a.value ?? 0);
    return a.createdAt.localeCompare(b.createdAt);
  });

  const visible: RankedRequest[] = [];
  const taken = new Map<RequestKind, number>();
  /*
    The per-kind cap is absolute, and filling the window is not a goal.

    The first version had a second pass that topped the window up in plain rank
    order whenever the cap left it short. That put the fault straight back: with
    seventy-one growth suggestions and one person, the owner saw the person and
    then fourteen suggestions, which is the wall again with a better first row.

    Six of a kind and a line saying there are sixty-five more is a better
    answer than fifteen rows that are all the same decision. The rest are not
    lost and they are not far away: answering these six brings the next six
    forward.
  */
  for (const request of live) {
    if (visible.length >= limit) break;
    const used = taken.get(request.kind) ?? 0;
    if (used >= PER_CATEGORY_LIMIT) continue;
    taken.set(request.kind, used + 1);
    visible.push(request);
  }

  const backlogByKind: Partial<Record<RequestKind, number>> = {};
  const shown = new Set(visible.map((r) => r.jobId));
  for (const request of live) {
    if (shown.has(request.jobId)) continue;
    backlogByKind[request.kind] = (backlogByKind[request.kind] ?? 0) + 1;
  }

  return { visible, backlogCount: live.length - visible.length, backlogByKind, staleCount, groupedCount };
}
