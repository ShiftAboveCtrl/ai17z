import type { AttentionKind, SalienceFactor } from '@xbam/shared/contracts';
import { SALIENCE_FLOOR } from '@xbam/shared/contracts';

/**
 * Deciding what is worth an agent's attention, and saying why.
 *
 * An agent that reads everything its radar found and treats it all equally has
 * no attention at all -- it has a queue. This is the layer that turns "forty
 * things happened" into "two of them matter, and here is what made them
 * matter".
 *
 * ## Deterministic on purpose
 *
 * Nothing here calls a model. That is not a cost decision, it is an
 * inspectability one: `docs/ENGINEERING.md` says a score without its reasons is
 * not shippable, and "the model thought it was interesting" is not a reason
 * anybody can argue with, correct, or tune. Every point below is attributable
 * to a named factor carrying a sentence.
 *
 * A model still has a place in deliberation -- it writes the summaries, it
 * connects things, it decides what a lesson actually was. It does not get to be
 * the sole judge of what the agent pays attention to, because that judgement is
 * the one an owner most needs to be able to look at.
 *
 * ## The default answer is "not much"
 *
 * Same discipline as `opportunity.ts`: most observations are declined outright
 * rather than scored low, and the decline carries its reason. An agent whose
 * working set fills with everything it saw is an agent with no interests.
 */

/** Something that happened, in the shape this layer needs to see it. */
export interface Observation {
  /** Which existing AI17Z record this came from. */
  source:
    | 'MENTION'
    | 'REPLY'
    | 'DISCOVERY'
    | 'OWN_POST'
    | 'ACTION_RESULT'
    | 'STANCE'
    | 'COMMITMENT'
    | 'RESEARCH'
    | 'REPO_EVENT'
    | 'KNOWLEDGE';
  /** The id of that record, so evidence can point back at it. */
  id: string;
  text: string;
  /** ISO. Absent means nothing said when, which is itself a reason to discount. */
  at?: string | null;
  handle?: string | null;
  authorId?: string | null;
  url?: string | null;
  /** Only counts somebody actually saw. Absent is never zero. */
  metrics?: { replies?: number | null; likes?: number | null; views?: number | null } | null;
}

export interface KnownPerson {
  handle: string;
  inboundCount: number;
  outboundCount: number;
  familiarity: string;
  disposition: string;
}

export interface SalienceContext {
  /** What this agent talks about, from the persona it already has. */
  topics: string[];
  /** What it is currently trying to do. */
  goals: string[];
  /** What is already on its mind, as summaries, for novelty. */
  onItsMind: string[];
  /** People it knows, by lower-cased handle. */
  people: Map<string, KnownPerson>;
  /** What it has said recently, so it does not rediscover its own posts. */
  recentlySaid: string[];
  /** Handles belonging to the agent. */
  selfHandles: string[];
  now: Date;
}

export interface Salience {
  salience: number;
  factors: SalienceFactor[];
  /** Null when this is worth attending to. */
  declined: { reason: string; detail: string } | null;
  /** What kind of thing this would become on the working set. */
  kind: AttentionKind;
  /** The dedupe key. Two sightings of one thing must be one item. */
  fingerprint: string;
}

const HOUR_MS = 60 * 60 * 1000;

/** Below this many characters, nothing was said that can be attended to. */
const MIN_TEXT = 24;

/** Past this, a post is history rather than something happening. */
const STALE_HOURS = 72;

/**
 * Words too common to distinguish anything, for the overlap measures.
 *
 * Deliberately short. A long list starts deciding what an agent is allowed to
 * find interesting, and the overlap thresholds already do most of the work.
 */
const COMMON = new Set([
  'about', 'after', 'again', 'also', 'and', 'any', 'are', 'because', 'been', 'but', 'can', 'could',
  'did', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'here', 'how', 'into', 'its', 'just',
  'like', 'make', 'more', 'most', 'not', 'now', 'one', 'only', 'other', 'our', 'out', 'over', 'own',
  'said', 'same', 'see', 'should', 'some', 'still', 'such', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'time', 'too', 'use', 'very', 'was', 'way',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you',
  'your', 'rt', 'https', 'http',
]);

function words(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}][\p{L}\p{N}'-]{2,}/gu)) {
    const word = match[0]!;
    if (!COMMON.has(word)) found.add(word);
  }
  return found;
}

/** How much two pieces of text are about the same thing, 0 to 1. */
export function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * Which of the agent's subjects this is about.
 *
 * Word-boundary matching rather than `includes`, for exactly the reason
 * `opportunity.ts` gives: "ai" inside "said" and "eth" inside "whether" is how
 * an agent ends up interested in a post about the weather.
 */
export function subjectsIn(text: string, topics: string[]): string[] {
  const found: string[] = [];
  for (const topic of topics) {
    const term = topic.trim().toLowerCase();
    if (term.length < 2) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
    if (pattern.test(text)) found.push(topic.trim());
  }
  return found;
}

/**
 * The dedupe key for an observation.
 *
 * Built from the subject rather than from the text, so the same development
 * reported twice in different words is one item. The distinctive words are
 * sorted and capped: word order is not part of what something is about, and an
 * unbounded key would make every sighting unique, which is the failure this
 * exists to prevent.
 */
export function fingerprintOf(source: string, text: string, anchor?: string | null): string {
  if (anchor) return `${source}:${anchor}`.slice(0, 200);
  const distinctive = [...words(text)].sort().slice(0, 8).join('-');
  return `${source}:${distinctive}`.slice(0, 200) || `${source}:empty`;
}

/**
 * What kind of working-set item an observation would become.
 *
 * A first pass only. Reflection may reclassify -- a question that turns out to
 * be a concern is a concern -- but something has to arrive as something, and
 * guessing from the shape of the text is both cheap and usually right.
 */
export function kindFor(observation: Observation, matchedTopics: string[]): AttentionKind {
  if (observation.source === 'REPO_EVENT') return 'NARRATIVE';
  if (observation.source === 'ACTION_RESULT') return 'LESSON';
  if (observation.source === 'RESEARCH') return 'LESSON';
  if (observation.source === 'COMMITMENT') return 'QUESTION';
  // A question somebody asked that the agent could not answer from what it
  // knows is the clearest curiosity signal there is.
  if (/\?\s*$/.test(observation.text.trim()) || /^(what|why|how|when|who|is|are|does|can)\b/i.test(observation.text.trim())) {
    return 'QUESTION';
  }
  if (matchedTopics.length > 0) return 'INTEREST';
  return 'NARRATIVE';
}

/**
 * Score one observation, or decline it with a reason.
 *
 * The declines come first and are absolute. Scoring something the agent has
 * nothing to do with, low, still puts it on the working set -- and a working
 * set of low-scoring irrelevancies is how attention stops meaning anything.
 */
export function scoreObservation(observation: Observation, context: SalienceContext): Salience {
  const text = observation.text.trim();
  const handle = (observation.handle ?? '').replace(/^@+/, '').toLowerCase();
  const matched = subjectsIn(text, context.topics);
  const kind = kindFor(observation, matched);
  const fingerprint = fingerprintOf(observation.source, text, observation.url ?? observation.id);
  const declineWith = (reason: string, detail: string): Salience => ({
    salience: 0,
    factors: [],
    declined: { reason, detail },
    kind,
    fingerprint,
  });

  if (text.length < MIN_TEXT) {
    return declineWith('nothing_said', 'Too short to have said anything worth thinking about.');
  }

  // Its own posts are not news to it. The agent reading its own timeline and
  // deciding it finds itself interesting is the exact loop to prevent.
  if (handle && context.selfHandles.some((self) => self.replace(/^@+/, '').toLowerCase() === handle)) {
    if (observation.source !== 'OWN_POST' && observation.source !== 'ACTION_RESULT') {
      return declineWith('its_own', 'This is the agent’s own post.');
    }
  }

  const ageHours = observation.at
    ? (context.now.getTime() - new Date(observation.at).getTime()) / HOUR_MS
    : null;
  if (ageHours !== null && Number.isFinite(ageHours) && ageHours > STALE_HOURS) {
    return declineWith('too_old', `${Math.round(ageHours)} hours old; this is history rather than something happening.`);
  }

  // Already said it. An agent rediscovering its own published opinion as a
  // fresh insight is how a working set fills with echoes.
  for (const said of context.recentlySaid) {
    if (overlap(text, said) > 0.6) {
      return declineWith('already_said', 'The agent has already said essentially this.');
    }
  }

  const factors: SalienceFactor[] = [];

  // ── Relevance to who this agent is ────────────────────────────────────────
  if (matched.length > 0) {
    factors.push({
      name: 'subject',
      detail: `About ${matched.slice(0, 3).join(', ')}, which this agent follows.`,
      points: Math.min(35, 18 + matched.length * 6),
    });
  }

  // ── Relevance to what it is trying to do ──────────────────────────────────
  const goalHit = context.goals.find((goal) => overlap(text, goal) > 0.25);
  if (goalHit) {
    factors.push({
      name: 'goal',
      detail: `Bears on something it is working on: ${goalHit.slice(0, 120)}`,
      points: 25,
    });
  }

  // ── Who said it ───────────────────────────────────────────────────────────
  const person = handle ? context.people.get(handle) : undefined;
  if (person) {
    // Somebody who has actually written to the agent is worth more attention
    // than somebody it has only ever talked at.
    const points = person.inboundCount > 0 ? Math.min(20, 8 + person.inboundCount * 3) : 4;
    factors.push({
      name: 'relationship',
      detail:
        person.inboundCount > 0
          ? `@${person.handle} has written to this agent ${person.inboundCount} time${person.inboundCount === 1 ? '' : 's'}.`
          : `@${person.handle} is somebody this agent knows of.`,
      points,
    });
    if (person.disposition === 'BLOCKED') {
      return declineWith('blocked', `You asked this agent not to engage with @${person.handle}.`);
    }
  }

  // ── Whether anything was addressed to it ──────────────────────────────────
  if (observation.source === 'MENTION' || observation.source === 'REPLY') {
    factors.push({
      name: 'addressed',
      detail: 'Somebody said this to the agent rather than near it.',
      points: 15,
    });
  }

  // ── How fresh ─────────────────────────────────────────────────────────────
  if (ageHours === null) {
    factors.push({ name: 'undated', detail: 'Nothing said when this happened.', points: -5 });
  } else {
    const freshness = Math.round(Math.max(0, 1 - ageHours / STALE_HOURS) * 15);
    factors.push({
      name: 'recency',
      detail: ageHours < 1 ? 'Within the hour.' : `${Math.round(ageHours)} hours ago.`,
      points: freshness,
    });
  }

  // ── Whether anybody else thought so ───────────────────────────────────────
  //
  // Only when somebody actually counted. An absent count is not a zero, and
  // treating it as one would make every unmeasured post look ignored.
  const replies = observation.metrics?.replies;
  const likes = observation.metrics?.likes;
  if (typeof replies === 'number' && replies >= 5) {
    factors.push({
      name: 'discussed',
      detail: `${replies} replies; people are actually talking about it.`,
      points: Math.min(15, 5 + Math.floor(replies / 5)),
    });
  }
  if (typeof likes === 'number' && likes >= 50) {
    factors.push({ name: 'noticed', detail: `${likes} likes.`, points: 8 });
  }

  // ── Novelty ───────────────────────────────────────────────────────────────
  //
  // The half that keeps a working set from becoming a list of the same thought
  // in eight wordings. Reinforcement is handled by the fingerprint upsert; this
  // is about a *different* item that says the same thing.
  let closest = 0;
  for (const known of context.onItsMind) closest = Math.max(closest, overlap(text, known));
  if (closest > 0.55) {
    factors.push({
      name: 'familiar',
      detail: 'Close to something already on its mind.',
      points: -Math.round(closest * 25),
    });
  } else if (closest < 0.15 && matched.length > 0) {
    factors.push({ name: 'new-angle', detail: 'Nothing on its mind covers this yet.', points: 10 });
  }

  // ── Whether there is anything to be interested in at all ──────────────────
  if (matched.length === 0 && !goalHit && !person && observation.source !== 'MENTION' && observation.source !== 'REPLY') {
    // Not scored low: declined. Having nothing to do with something is not a
    // weak reason to think about it, it is a reason not to.
    return declineWith('unrelated', 'Nothing here connects to what this agent follows, knows or is doing.');
  }

  const salience = Math.max(0, Math.min(100, factors.reduce((total, factor) => total + factor.points, 0)));
  if (salience < SALIENCE_FLOOR) {
    return declineWith('too_faint', `Scored ${salience}, below the floor of ${SALIENCE_FLOOR}.`);
  }

  return { salience, factors, declined: null, kind, fingerprint };
}

/**
 * What an item is worth now, given that nothing has reinforced it since.
 *
 * Exponential decay on a per-kind half-life. Decay rather than a deletion timer
 * because an item that keeps being reinforced should survive however old it is,
 * and one nothing has pointed at in weeks should fade whatever it scored on the
 * day it arrived. A lesson outlives a narrative because a narrative is about
 * what is happening and a lesson is about what turned out to be true.
 */
export function decayed(
  salience: number,
  lastReinforcedAt: string,
  halfLifeDays: number,
  now: Date = new Date(),
): number {
  const ageDays = (now.getTime() - new Date(lastReinforcedAt).getTime()) / (24 * HOUR_MS);
  if (!Number.isFinite(ageDays) || ageDays <= 0) return salience;
  return Math.round(salience * Math.pow(0.5, ageDays / Math.max(halfLifeDays, 1)));
}
