import type { BridgeScore } from './bridge';

/**
 * Which conversations are worth starting, and -- more often -- which are not.
 *
 * Everything else in the runtime answers "somebody said something to us, what
 * now". This answers the other one: nobody has said anything, the agent is
 * looking at a timeline, and the question is whether any of it is worth
 * speaking into.
 *
 * The default answer is no, and that is the design rather than a limitation.
 * An agent that finds an opportunity in every post is an agent that replies to
 * strangers about things it knows nothing about, and the fastest way to build
 * one is to score everything and take the top ten. So the first thing this does
 * is decline, with a reason, and only what survives is scored.
 *
 * `docs/ENGINEERING.md`: silence is a branch, not an error, and the reasons
 * matter more than the scores. A decline here is a first-class result carrying
 * the sentence that produced it, because "we looked at 40 posts and found
 * nothing" is a useful thing for an owner to be able to read.
 */

/** A post as this engine needs to see it. Deliberately not the whole `XPost`. */
export interface OpportunityCandidate {
  statusId: string;
  handle: string;
  text: string;
  /** ISO. Absent means the timeline did not say, which is itself a reason. */
  postedAt?: string;
  replyCount?: number;
  likeCount?: number;
  viewCount?: number;
}

export interface OpportunityContext {
  /** Handles belonging to the agent. Its own posts are never opportunities. */
  selfHandles: string[];
  /** What this agent actually talks about, lower-cased by the caller or not. */
  topics: string[];
  /** Handles already engaged inside the current window. */
  recentlyEngaged: string[];
  /** Bridge scores by handle, where any are known. */
  bridges?: Record<string, BridgeScore>;
  /** How old a post may be before the conversation has moved on. */
  maxAgeHours?: number;
  now?: Date;
}

export interface OpportunityReason {
  name: string;
  detail: string;
  points: number;
}

export interface Opportunity {
  statusId: string;
  handle: string;
  value: number;
  reasons: OpportunityReason[];
}

export interface DeclinedOpportunity {
  statusId: string;
  handle: string;
  /** A machine name, so a screen can group them. */
  reason: string;
  /** A sentence an owner can read. */
  detail: string;
}

export interface OpportunityVerdict {
  opportunities: Opportunity[];
  declined: DeclinedOpportunity[];
}

/** Past this, the conversation has moved on and a reply arrives at nobody. */
const DEFAULT_MAX_AGE_HOURS = 12;

/**
 * Past this many replies, one more is invisible.
 *
 * Not a hard decline: a busy thread under an account the agent has a real
 * relationship with is still worth answering. It is a cost, and the bridge and
 * topic factors can outweigh it.
 */
const CROWDED_REPLIES = 150;

/** The shortest post this will treat as having said something. */
const MIN_TEXT_LENGTH = 24;

/**
 * Which of the agent's topics the post is about.
 *
 * Word-boundary matching rather than `includes`, because "ai" inside "said" and
 * "eth" inside "whether" are how an agent ends up replying to a post about the
 * weather with an opinion about Ethereum.
 */
export function topicsIn(text: string, topics: string[]): string[] {
  const hay = text.toLowerCase();
  const found: string[] = [];
  for (const topic of topics) {
    const term = topic.trim().toLowerCase();
    if (term.length < 2) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A multi-word topic is matched as a phrase; a single word is matched whole.
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
    if (pattern.test(hay)) found.push(topic.trim());
  }
  return found;
}

const HOUR_MS = 60 * 60 * 1000;

export function findOpportunities(
  candidates: OpportunityCandidate[],
  context: OpportunityContext,
): OpportunityVerdict {
  const now = context.now ?? new Date();
  const maxAgeHours = context.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const selves = new Set(context.selfHandles.map((h) => h.replace(/^@+/, '').toLowerCase()));
  const engaged = new Set(context.recentlyEngaged.map((h) => h.replace(/^@+/, '').toLowerCase()));

  const opportunities: Opportunity[] = [];
  const declined: DeclinedOpportunity[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const handle = candidate.handle.replace(/^@+/, '');
    const key = candidate.statusId;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const decline = (reason: string, detail: string) => declined.push({ statusId: key, handle, reason, detail });

    if (selves.has(handle.toLowerCase())) {
      decline('own_post', 'This is one of the agent’s own posts.');
      continue;
    }
    const bridge = context.bridges?.[handle.toLowerCase()] ?? context.bridges?.[handle];
    if (bridge?.blocked) {
      decline('blocked', `You asked this agent not to engage with @${handle}.`);
      continue;
    }
    if (engaged.has(handle.toLowerCase())) {
      // Turning up under three of somebody's posts in an afternoon reads as
      // being followed around, whatever each individual reply says.
      decline('already_engaged', `The agent has already spoken to @${handle} recently.`);
      continue;
    }
    if (candidate.text.trim().length < MIN_TEXT_LENGTH) {
      decline('nothing_said', 'The post is too short to have said anything to answer.');
      continue;
    }

    if (!candidate.postedAt) {
      decline('age_unknown', 'The timeline did not say when this was posted, so it may be days old.');
      continue;
    }
    const ageHours = (now.getTime() - new Date(candidate.postedAt).getTime()) / HOUR_MS;
    if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) {
      decline('too_old', `Posted ${Math.round(ageHours)} hours ago; the conversation has moved on.`);
      continue;
    }

    const matched = topicsIn(candidate.text, context.topics);
    if (matched.length === 0) {
      // The rule that keeps this from being a stranger-engagement machine.
      // Having nothing to say about something is not a low score, it is a no.
      decline('off_topic', 'Nothing in this post is something the agent has anything to say about.');
      continue;
    }

    const reasons: OpportunityReason[] = [];
    reasons.push({
      name: 'topic',
      detail: `About ${matched.slice(0, 3).join(', ')}, which this agent talks about.`,
      points: Math.min(40, 20 + matched.length * 8),
    });

    // Fresh beats stale, sharply. A two-hour-old post is a live conversation.
    const freshness = Math.round(Math.max(0, 1 - ageHours / maxAgeHours) * 20);
    reasons.push({
      name: 'freshness',
      detail: ageHours < 1 ? 'Posted within the hour.' : `Posted ${Math.round(ageHours)} hours ago.`,
      points: freshness,
    });

    if (candidate.replyCount !== undefined && candidate.replyCount > CROWDED_REPLIES) {
      reasons.push({
        name: 'crowded',
        detail: `${candidate.replyCount.toLocaleString()} replies already; one more is unlikely to be seen.`,
        points: -20,
      });
    } else if (candidate.replyCount !== undefined && candidate.replyCount <= 3) {
      reasons.push({
        name: 'early',
        detail:
          candidate.replyCount === 0
            ? 'Nobody has replied yet.'
            : `Only ${candidate.replyCount} repl${candidate.replyCount === 1 ? 'y' : 'ies'} so far.`,
        points: 12,
      });
    }

    if (bridge) {
      // A quarter of the bridge score, so who they are informs the decision
      // without deciding it. What was said is the larger half on purpose.
      const points = Math.round(bridge.value / 4);
      reasons.push({
        name: 'bridge',
        detail: `@${handle}: ${bridge.factors[0]?.detail ?? 'no reasons recorded'}`,
        points,
      });
    }

    const value = Math.max(0, Math.min(100, reasons.reduce((total, reason) => total + reason.points, 0)));
    opportunities.push({ statusId: key, handle, value, reasons });
  }

  opportunities.sort((a, b) => b.value - a.value || a.statusId.localeCompare(b.statusId));
  return { opportunities, declined };
}
