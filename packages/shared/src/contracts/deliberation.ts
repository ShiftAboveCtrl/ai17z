import { z } from 'zod';

/**
 * Persistent autonomous deliberation: the vocabulary.
 *
 * An AI17Z agent already has identity, persona, voice, six memory scopes,
 * relationships, stances and commitments. What it has never had is a present
 * tense -- what it is interested in now, what it is unsure about, what it is
 * trying to find out, what it recently learned. Without that it is reactive:
 * it answers what it is asked, and when nobody asks it has nothing to say, so
 * a posting schedule either goes quiet or produces filler.
 *
 * ## What this is, said carefully
 *
 * This is **not** a mind, a consciousness, or a stream of thought, and nothing
 * in AI17Z may describe it as one. It is a bounded working set of structured
 * conclusions, each carrying the evidence it rests on and how sure the agent
 * is. The useful engineering claim is that an agent which accumulates context,
 * researches its own uncertainty, keeps goals and learns from what happened has
 * worthwhile things to say -- not that it experiences anything.
 *
 * ## The rule that shapes every type here
 *
 * **No raw chain-of-thought, ever.** Every artifact is a conclusion, its
 * evidence, its confidence and what to do next. Model reasoning tokens are not
 * stored, not shown to an owner, and not sent anywhere. A reflection is a
 * durable summarised artifact; it is not a transcript.
 */

/**
 * What kind of thing is on an agent's mind.
 *
 * Separate values rather than one "thought", because they behave differently
 * and want different things done about them: a curiosity wants researching, a
 * concern wants watching, a lesson wants promoting into durable memory, and a
 * question is either answered or it is not.
 */
export const ATTENTION_KINDS = [
  /** A subject this agent keeps returning to. */
  'INTEREST',
  /** Something it wants to understand better before it says anything. */
  'CURIOSITY',
  /** Something that might be going wrong. */
  'CONCERN',
  /** A claim it holds provisionally, which evidence can confirm or break. */
  'HYPOTHESIS',
  /** An open question it cannot yet answer. */
  'QUESTION',
  /** Something it learned from what actually happened. */
  'LESSON',
  /** A conversation in its world that it is following. */
  'NARRATIVE',
  /** Something it might want to say, once. */
  'IDEA',
] as const;
export const AttentionKind = z.enum(ATTENTION_KINDS);
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_STATES = ['ACTIVE', 'RESOLVED', 'SUPERSEDED', 'RETIRED'] as const;
export const AttentionState = z.enum(ATTENTION_STATES);
export type AttentionState = (typeof ATTENTION_STATES)[number];

export const GOAL_ORIGINS = ['AGENT', 'OWNER'] as const;
export const GoalOrigin = z.enum(GOAL_ORIGINS);
export type GoalOrigin = (typeof GOAL_ORIGINS)[number];

export const GOAL_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED'] as const;
export const GoalStatus = z.enum(GOAL_STATUSES);
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * The three depths of reflection, and why there are three.
 *
 * One would be wrong in both directions: cheap enough to run on every event is
 * too shallow to connect anything, and thorough enough to consolidate a day is
 * far too expensive to run when somebody replies.
 */
export const REFLECTION_KINDS = [
  /** Triggered by something happening. Does this matter, and is it new? */
  'LIGHT',
  /** On the wake schedule. What has been accumulating, and what connects? */
  'PERIODIC',
  /** Occasional. Consolidate, merge, retire, promote, and look at its own behaviour. */
  'DEEP',
] as const;
export const ReflectionKind = z.enum(REFLECTION_KINDS);
export type ReflectionKind = (typeof REFLECTION_KINDS)[number];

/**
 * How much an agent may do on its own.
 *
 * A ladder rather than a switch, because "autonomous" is four separate
 * decisions an owner makes at different times, and an all-or-nothing control
 * forces the most cautious of them onto all four.
 *
 * **ACT is not a bypass.** Everything deliberation produces still passes the
 * engagement heuristic, the policy gates, cadence, rate limits, idempotency and
 * exact-target verification, exactly as anything else does. The ladder decides
 * whether a candidate is *offered* to those gates, never whether they run.
 */
export const AUTONOMY_LEVELS = [
  /** Gather evidence and score it. Change nothing, say nothing. */
  'OBSERVE',
  /** Also reflect, research, and update its own working set. */
  'THINK',
  /** Also put action candidates where the owner can see them. */
  'SUGGEST',
  /** Also let candidates reach the gates that were always going to decide. */
  'ACT',
] as const;
export const AutonomyLevel = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Whether this level is at least that one. The ladder, as a comparison. */
export function autonomyAtLeast(level: AutonomyLevel, required: AutonomyLevel): boolean {
  return AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(required);
}

/**
 * One reason something scored the way it did.
 *
 * `docs/ENGINEERING.md`: the reasons matter more than the scores, and a score
 * without them is not shippable. A single opaque model judgement cannot be
 * inspected or argued with, so salience is the sum of named factors and the
 * factors are what get stored.
 */
export const SalienceFactor = z.object({
  name: z.string(),
  /** A sentence somebody could read on its own. */
  detail: z.string(),
  points: z.number().int(),
});
export type SalienceFactor = z.infer<typeof SalienceFactor>;

/**
 * What an item rests on: a reference, never a copy.
 *
 * `kind` names what sort of thing it is inside AI17Z -- an event, an action, a
 * memory, a stance, a repository event -- and `ref` identifies it. A URL is
 * used only for something actually read off the open web. An item with no
 * evidence is an assertion, which is the same rule persona traits live under.
 */
export const EvidenceRef = z.object({
  kind: z.string().max(40),
  ref: z.string().max(400),
  /** What it was, in a few words, so a screen need not fetch it to show it. */
  note: z.string().max(400).default(''),
  at: z.string().nullable().default(null),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/**
 * Bounds, in one place.
 *
 * A working set is only useful because it is small. Every one of these is a
 * ceiling on something that would otherwise grow without limit, and the reason
 * they live here rather than in the code that enforces them is that "how much
 * is this agent allowed to be thinking about" is one decision.
 */
export const DELIBERATION_LIMITS = {
  /** Items in the working set before the weakest are retired. */
  workingSet: 60,
  /** Items handed to a prompt. Past this a prompt is a journal dump. */
  inPrompt: 8,
  /** Goals an agent may hold at once. More than this is not a set of goals. */
  goals: 12,
  /** Evidence references kept on one item. */
  evidencePerItem: 12,
  /** Characters in a summary. One sentence, not an essay. */
  summary: 300,
  /** How many observations one wake considers. */
  observationsPerWake: 120,
  /**
   * Posts one wake may decide are worth acknowledging.
   *
   * A wake reads up to `observationsPerWake`, so without a bound here a single
   * catch-up can queue dozens of likes: the worker's cadence and the account
   * ceiling still pace them out, so nothing arrives on X at once, but a backlog
   * of forty pending acknowledgements is not a judgement anybody made. An agent
   * that finds forty things worth acknowledging in one wake has not been
   * reading, it has been catching up, and `engagementWorth.ts` is written for
   * the first of those.
   *
   * Five is the number of things a person might plausibly like in half an hour
   * of scrolling. It bites only on a wake that had a lot to look at, which is
   * exactly the case it exists for.
   */
  engagementsPerWake: 5,
} as const;

/** Salience below which an item is not worth keeping in the working set. */
export const SALIENCE_FLOOR = 15;

/**
 * How long an untouched item survives, by kind, in days.
 *
 * Decay rather than deletion on a timer: an item that keeps being reinforced
 * stays however old it is, and one nothing has pointed at in weeks goes. A
 * lesson outlives a narrative because a narrative is about what is happening
 * and a lesson is about what is true.
 */
export const ATTENTION_HALF_LIFE_DAYS: Record<AttentionKind, number> = {
  INTEREST: 45,
  CURIOSITY: 14,
  CONCERN: 21,
  HYPOTHESIS: 30,
  QUESTION: 21,
  LESSON: 120,
  NARRATIVE: 7,
  IDEA: 10,
};
