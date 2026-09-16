import type { SalienceFactor } from '@xbam/shared/contracts';
import { unpromptedSubject } from './reticence';

/**
 * Whether a post is worth acknowledging, and whether it is worth passing on.
 *
 * ## Two decisions, not one
 *
 * A **like** says "I read this and it was worth reading". It costs the agent
 * very little and it costs the reader nothing, so the bar is moderate.
 *
 * A **repost** says "my audience should read this". It spends the attention of
 * everybody following the agent, on somebody else's words, with the agent's
 * name on it. The bar is much higher, and most things that clear the first bar
 * do not come near the second.
 *
 * Treating them as one decision with a threshold is how accounts end up
 * reposting anything they liked enough.
 *
 * ## Deterministic, for the reason `salience.ts` gives
 *
 * No model call. "The model thought it was worth liking" is not a reason an
 * owner can inspect, correct or tune, and this is a judgement that shows up in
 * public under their name. Every point carries a named factor and a sentence.
 *
 * ## The declines are the product
 *
 * Most posts are declined outright rather than scored low. An agent that likes
 * everything it scored above zero is an engagement-farming bot, and that is the
 * single easiest way to make an account worthless.
 */

export interface EngagementCandidate {
  /** X's own id for the post. The action is anchored to this, never the URL. */
  remoteId: string;
  url: string;
  authorHandle: string;
  text: string;
  /** Null where nobody counted. Absent is never zero. */
  metrics?: { replies?: number | null; likes?: number | null; views?: number | null } | null;
  /** How old, in hours, where it is known. */
  ageHours?: number | null;
}

export interface EngagementContext {
  /** What this agent follows, from the persona it already has. */
  topics: string[];
  /** Handles belonging to the agent, so it never engages with itself. */
  selfHandles: string[];
  /** People it knows, lower-cased handle to how well. */
  people: Map<string, { inboundCount: number; disposition: string }>;
  /** Posts it has already acted on, by remote id. */
  alreadyEngaged: Set<string>;
}

export interface Worth {
  kind: 'LIKE' | 'REPOST' | null;
  score: number;
  factors: SalienceFactor[];
  confidence: number;
  declined: { reason: string; detail: string } | null;
}

/** Below this a like is not worth the agent's name on it. */
export const LIKE_FLOOR = 45;
/**
 * Where a repost begins to be arguable.
 *
 * Far above the like floor and deliberately so: a repost is the agent telling
 * everybody following it to go and read something.
 */
export const REPOST_FLOOR = 78;

/** Too short to be worth acknowledging, whatever it says. */
const MIN_TEXT = 40;
/** Past this, engaging reads as the agent trawling old timelines. */
const STALE_HOURS = 48;

/**
 * The shapes engagement bait takes.
 *
 * Short and deliberately so. This is not a spam classifier; it is the handful
 * of things that are *asking* to be amplified, where amplifying them is the
 * whole point of the post rather than a side effect of it being good.
 */
const BAIT =
  /(\b(rt|retweet|repost|like)\s*(and|\+|&)\s*(follow|rt|retweet|comment)|\bdrop\s+(your|a)\s+\w+\s+below|\bwho\s+wants\b|\bgiveaway\b|\bairdrop\b|\btag\s+\d|\bfirst\s+\d+\s+(people|repl)|\bcomment\s+["']?\w+["']?\s+(and|to)\b)/i;

/** Word-boundary matching, the same discipline `subjectsIn` uses. */
function mentions(haystack: string, term: string): boolean {
  const escaped = term.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(haystack);
}

/**
 * What this post is worth, and why.
 *
 * Returns `kind: null` with a decline whenever the answer is "nothing", which
 * is most of the time.
 */
export function worthEngaging(post: EngagementCandidate, context: EngagementContext): Worth {
  const text = (post.text ?? '').trim();
  const handle = (post.authorHandle ?? '').replace(/^@+/, '').toLowerCase();

  const no = (reason: string, detail: string): Worth => ({
    kind: null,
    score: 0,
    factors: [],
    confidence: 0,
    declined: { reason, detail },
  });

  // ── The outright declines, before anything is scored ──────────────────────

  if (!post.remoteId) return no('no_target', 'There is no post id to act on.');
  if (context.alreadyEngaged.has(post.remoteId)) {
    return no('already_engaged', 'This agent has already acted on this post.');
  }
  if (handle && context.selfHandles.some((self) => self.replace(/^@+/, '').toLowerCase() === handle)) {
    // An account liking itself is the loop that makes every metric meaningless.
    return no('its_own', 'This is the agent’s own post.');
  }
  if (text.length < MIN_TEXT) {
    return no('nothing_said', 'Too short to be worth acknowledging.');
  }
  if (BAIT.test(text)) {
    // Not scored low: declined. Amplifying a post whose purpose is to be
    // amplified is the definition of engagement farming.
    return no('bait', 'This post is asking to be amplified, which is a reason not to.');
  }
  if (post.ageHours !== null && post.ageHours !== undefined && post.ageHours > STALE_HOURS) {
    return no('too_old', `${Math.round(post.ageHours)} hours old; engaging now reads as trawling.`);
  }

  const person = handle ? context.people.get(handle) : undefined;
  if (person?.disposition === 'BLOCKED') {
    return no('blocked', `You asked this agent not to engage with @${handle}.`);
  }

  /*
    A high-stakes subject is not something to put the agent's name on.

    A like is a public position, and a repost more so. Reticence exists for
    exactly this: the agent does not raise these subjects, and quietly
    endorsing somebody else's post about one is raising it with extra steps.
  */
  const reticent = unpromptedSubject(text);
  if (reticent) {
    return no('not_ours_to_amplify', `Not amplified: ${reticent.subject}.`);
  }

  // ── What makes it worth something ─────────────────────────────────────────

  const factors: SalienceFactor[] = [];

  const matched = context.topics.filter((topic) => mentions(text, topic));
  if (matched.length > 0) {
    factors.push({
      name: 'subject',
      detail: `About ${matched.slice(0, 3).join(', ')}, which this agent follows.`,
      points: Math.min(38, 20 + matched.length * 6),
    });
  }

  if (person) {
    const points = person.inboundCount > 0 ? Math.min(22, 10 + person.inboundCount * 3) : 6;
    factors.push({
      name: 'relationship',
      detail:
        person.inboundCount > 0
          ? `@${handle} has written to this agent ${person.inboundCount} time${person.inboundCount === 1 ? '' : 's'}.`
          : `@${handle} is somebody this agent knows of.`,
      points,
    });
  }

  // Substance. A post long enough to have made an argument is worth more than
  // one long enough to have made a remark.
  if (text.length >= 180) {
    factors.push({ name: 'substance', detail: 'Long enough to have actually said something.', points: 12 });
  }

  if (post.ageHours !== null && post.ageHours !== undefined) {
    const freshness = Math.round(Math.max(0, 1 - post.ageHours / STALE_HOURS) * 14);
    factors.push({
      name: 'recency',
      detail: post.ageHours < 1 ? 'Within the hour.' : `${Math.round(post.ageHours)} hours ago.`,
      points: freshness,
    });
  }

  /*
    What other people thought, and only where somebody counted.

    Deliberately modest. Weighting this heavily is how an agent ends up
    amplifying whatever is already loud, which is both useless to its audience
    and the exact behaviour that makes an automated account obvious.
  */
  const replies = post.metrics?.replies;
  if (typeof replies === 'number' && replies >= 5) {
    factors.push({
      name: 'discussed',
      detail: `${replies} replies; people are actually talking about it.`,
      points: Math.min(10, 4 + Math.floor(replies / 8)),
    });
  }

  const score = Math.max(0, Math.min(100, factors.reduce((total, factor) => total + factor.points, 0)));

  if (score < LIKE_FLOOR) {
    return no('too_faint', `Scored ${score}, below the floor of ${LIKE_FLOOR}.`);
  }

  /*
    A repost needs the subject *and* the substance, not merely a high total.

    Without this a post by somebody the agent talks to a lot, arriving within
    the hour, could be reposted on relationship and freshness alone -- which is
    how an account becomes somebody's amplifier rather than a reader.
  */
  const onSubject = factors.some((factor) => factor.name === 'subject');
  const hasSubstance = factors.some((factor) => factor.name === 'substance');
  const kind = score >= REPOST_FLOOR && onSubject && hasSubstance ? 'REPOST' : 'LIKE';

  return {
    kind,
    score,
    factors,
    // Confidence tracks the score rather than being a second opinion about it.
    confidence: Math.min(0.95, 0.4 + score / 200),
    declined: null,
  };
}
