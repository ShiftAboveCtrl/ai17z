import { createHash } from 'node:crypto';
import { createLogger } from '@xbam/shared';
import { introspection as introspectionRepo, learning as learningRepo, type ArmRow, type MeasurableAction } from '@xbam/database';
import { audienceOf } from './engagement';

const log = createLogger('learning');

/**
 * An agent that learns from what happened to what it published, and checks
 * what it learned before it trusts it.
 *
 * Every public reply and post is revisited and measured already; nothing ever
 * connected a reading to the choices behind the action. So an agent changed
 * whom it avoided and never how it chose. This closes that loop in three
 * layers, all deterministic, all per agent, none of them a model call:
 *
 * 1. **Outcomes.** Once an action has had time to be seen, its readings become
 *    a reach score, placed among the agent's own recent scores so a small
 *    account and a large one learn on the same scale.
 * 2. **Evidence.** The score is credited to each choice behind the action: how
 *    the post was found, how long the reply was, whether it asked something,
 *    how large the author's audience was. Evidence halves every fourteen days.
 * 3. **Trials, and trust in its own trials.** When one option looks clearly
 *    better, the agent does not simply switch. It starts a trial: the learned
 *    option most of the time, the old behaviour the rest, as a control. The
 *    trial is kept or reverted on what actually happened, and how much evidence
 *    the agent needs before its next change on that choice moves with its
 *    record: a choice it has been right about is changed on less, one it has
 *    been wrong about needs more. That last step is what makes it recursive.
 *
 * What it can move is narrow on purpose. How discovery divides its sessions,
 * which audience size it prefers among posts that already passed every rule,
 * the length it aims for within the voice, and whether it tends to ask. It can
 * never touch a permission, the identity rules, the pitch rules, do not
 * contact, the owner's outreach limits or the quality gates. Those are rules,
 * and a learner that could relax a rule because relaxing it got more likes is
 * the thing never to build.
 *
 * The objective is reach, at the owner's choice: views, likes, reposts,
 * replies, quotes and bookmarks. Because reach is also what engagement bait
 * optimises for, the rules above stay outside anything this can learn.
 */

/** The choices the agent learns about, and the options for each. */
export const LEARNING_DIMENSIONS = {
  /** How the post it answered was found. Applied to how discovery divides its sessions. */
  mode: ['COMMUNITY', 'CIRCLE', 'TOPIC', 'DIRECT', 'WATCHED', 'POST'],
  /** How long it wrote. Applied to the length it is asked to aim for. */
  length: ['SHORT', 'MEDIUM', 'LONG'],
  /** Whether it asked something. Applied as a lean in the instruction. */
  question: ['ASKS', 'STATES'],
  /** The author's audience. Applied to ranking among posts that passed every rule. */
  audience: ['SMALL', 'MID', 'LARGE'],
} as const;

export type LearningDimension = keyof typeof LEARNING_DIMENSIONS;

/** The options of each choice the agent may actually move towards. Direct messages and posts are observed, not chosen. */
const LEARNABLE: Record<LearningDimension, readonly string[]> = {
  mode: ['COMMUNITY', 'CIRCLE', 'TOPIC'],
  length: ['SHORT', 'MEDIUM', 'LONG'],
  question: ['ASKS', 'STATES'],
  audience: ['SMALL', 'MID', 'LARGE'],
};

/** How long a published action has to be seen before it is judged. */
export const SETTLE_HOURS = 6;
/** Evidence halves in this long. */
export const HALF_LIFE_DAYS = 14;
/** Decayed outcomes an option needs before it can be preferred at all. */
export const MIN_EVIDENCE = 6;
/** How much better than the choice's average an option must look, at full trust. */
export const MIN_LIFT = 0.08;
/** Outcomes each side of a trial needs before it is decided. */
export const TRIAL_APPLIED = 8;
export const TRIAL_CONTROL = 3;
/** A trial that cannot gather its control in this long is decided on what it has. */
export const TRIAL_MAX_DAYS = 10;
/** How often the old behaviour runs as the control: one in this many while testing, one in the second after keeping. */
export const CONTROL_EVERY_WHILE_TESTING = 5;
export const CONTROL_EVERY_AFTER_KEEPING = 10;

const DAY_MS = 24 * 60 * 60_000;

// ── Scoring one outcome ─────────────────────────────────────────────────────

/**
 * Reach, from the readings. Weighted towards the signals a reader chose to
 * give over the ones they could not avoid: a view is somebody scrolling past,
 * a repost is somebody putting it in front of their own followers. Logged, so
 * one post that travelled does not teach an agent that nothing else counts.
 *
 * Null when nothing was read at all, which is not the same as nobody seeing it.
 */
export function reachOf(readings: Pick<MeasurableAction, 'views' | 'likes' | 'reposts' | 'replies' | 'quotes' | 'bookmarks'>): number | null {
  const parts: [number | null, number][] = [
    [readings.views, 1],
    [readings.likes, 3],
    [readings.reposts, 5],
    [readings.replies, 4],
    [readings.quotes, 4],
    [readings.bookmarks, 2],
  ];
  const seen = parts.filter(([value]) => typeof value === 'number' && Number.isFinite(value));
  if (seen.length === 0) return null;
  return seen.reduce((sum, [value, weight]) => sum + Math.log1p(Math.max(0, value as number)) * weight, 0);
}

/**
 * Where a reach score sits among the agent's own recent ones, from 0 to 1.
 * With little history it stays near the middle, so the first few outcomes do
 * not each look like the best or worst thing the agent ever did.
 */
export function rewardOf(reach: number, history: readonly number[]): number {
  const below = history.filter((value) => value < reach).length;
  const equal = history.filter((value) => value === reach).length;
  return (below + equal / 2 + 1) / (history.length + 2);
}

/** The choices behind one action, as the learner files them. */
export function featuresOf(action: Pick<MeasurableAction, 'type' | 'text' | 'executedAt' | 'eventType' | 'eventPayload' | 'learningMeta'>): {
  mode: string;
  length: string;
  question: string;
  audience: string | null;
  hour: number;
  variants: Record<string, string>;
} {
  const community = audienceOf(action.eventPayload).community;
  const mode =
    action.type === 'POST'
      ? 'POST'
      : community
        ? community.kind === 'REPLY'
          ? 'COMMUNITY'
          : 'CIRCLE'
        : action.eventType === 'KEYWORD_MATCH'
          ? 'TOPIC'
          : action.eventType === 'TARGET_ACCOUNT_ACTIVITY'
            ? 'WATCHED'
            : 'DIRECT';
  const text = action.text.trim();
  const length = text.length < 60 ? 'SHORT' : text.length <= 140 ? 'MEDIUM' : 'LONG';
  const followers = audienceOf(action.eventPayload).authorFollowers;
  const audience = followers === null ? null : followers < 1_000 ? 'SMALL' : followers < 10_000 ? 'MID' : 'LARGE';
  const variants: Record<string, string> = {};
  for (const source of [
    (action.eventPayload as { learning?: { variants?: unknown } } | null)?.learning?.variants,
    (action.learningMeta as { variants?: unknown } | null)?.variants,
  ]) {
    if (source && typeof source === 'object') {
      for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
        if (value === 'learned' || value === 'control') variants[key] = value;
      }
    }
  }
  return {
    mode,
    length,
    question: /\?/.test(text) ? 'ASKS' : 'STATES',
    audience,
    hour: new Date(action.executedAt).getUTCHours(),
    variants,
  };
}

// ── Evidence ────────────────────────────────────────────────────────────────

/** An option's evidence, aged to `now`. */
export function aged(arm: Pick<ArmRow, 'trials' | 'reward' | 'updatedAt'>, now: Date): { trials: number; reward: number } {
  const days = Math.max(0, (now.getTime() - new Date(arm.updatedAt).getTime()) / DAY_MS);
  const keep = 0.5 ** (days / HALF_LIFE_DAYS);
  return { trials: arm.trials * keep, reward: arm.reward * keep };
}

/** How good an option looks: its average reward, pulled towards the middle while evidence is thin. */
export function meanOf(arm: { trials: number; reward: number }): number {
  return (arm.reward + 1) / (arm.trials + 2);
}

export interface Preference {
  dimension: LearningDimension;
  arm: string;
  mean: number;
  baseline: number;
  evidence: number;
}

/**
 * The option this choice should move towards, if the evidence says so.
 *
 * `confidence` is the agent's record on this choice: above one it has been
 * right before and needs less lift to change again, below one it has been
 * wrong and needs more.
 */
export function preferenceFrom(
  dimension: LearningDimension,
  arms: readonly { arm: string; trials: number; reward: number }[],
  confidence = 1,
): Preference | null {
  const mine = arms.filter((a) => (LEARNING_DIMENSIONS[dimension] as readonly string[]).includes(a.arm));
  const total = mine.reduce((sum, a) => sum + a.trials, 0);
  if (total <= 0) return null;
  const baseline = (mine.reduce((sum, a) => sum + a.reward, 0) + 1) / (total + 2);
  const candidates = mine
    .filter((a) => LEARNABLE[dimension].includes(a.arm) && a.trials >= MIN_EVIDENCE)
    .map((a) => ({ arm: a.arm, mean: meanOf(a), evidence: a.trials }))
    .sort((a, b) => b.mean - a.mean);
  const best = candidates[0];
  if (!best) return null;
  const needed = MIN_LIFT / Math.max(0.25, confidence);
  if (best.mean - baseline < needed) return null;
  return { dimension, arm: best.arm, mean: best.mean, baseline, evidence: best.evidence };
}

/** Whether a trial is ready to be decided, and which way. */
export function judgeTrial(
  evidence: { applied: readonly number[]; held: readonly number[] },
  startedAt: string,
  now: Date,
): { decided: false } | { decided: true; kept: boolean; verdict: string } {
  const average = (xs: readonly number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const aged = now.getTime() - new Date(startedAt).getTime() >= TRIAL_MAX_DAYS * DAY_MS;
  const enough = evidence.applied.length >= TRIAL_APPLIED && evidence.held.length >= TRIAL_CONTROL;
  if (!enough && !aged) return { decided: false };
  const applied = average(evidence.applied);
  const held = average(evidence.held);
  if (applied === null) {
    return { decided: true, kept: false, verdict: 'Nothing it published under this change has been measured yet, so it was dropped rather than trusted.' };
  }
  if (held === null) {
    // No control ever ran: judge against the middle of its own history.
    const kept = applied >= 0.5;
    return {
      decided: true,
      kept,
      verdict: kept
        ? `Did better than its usual (${pct(applied)} against 50%), with no control to compare against.`
        : `Did worse than its usual (${pct(applied)} against 50%).`,
    };
  }
  // A small margin for noise: a change that did as well is not worth undoing.
  const kept = applied >= held - 0.02;
  return {
    decided: true,
    kept,
    verdict: kept
      ? `With the change it placed at ${pct(applied)} of its own range, against ${pct(held)} without it, over ${evidence.applied.length} and ${evidence.held.length} measured actions.`
      : `With the change it placed at ${pct(applied)} of its own range, against ${pct(held)} without it, so the old behaviour is back.`,
  };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** How trust in its own changes on a choice moves after a verdict. */
export function nextConfidence(confidence: number, kept: boolean): number {
  return kept ? Math.min(2, confidence * 1.25) : Math.max(0.4, confidence * 0.7);
}

// ── Applying what was learned ───────────────────────────────────────────────

/**
 * Whether this decision uses the learned option or runs as the control.
 *
 * Deterministic in its key, so the same decision re-run after a restart makes
 * the same choice, and the split is what it says it is over many decisions.
 */
export function variantFor(key: string, status: 'RUNNING' | 'KEPT'): 'learned' | 'control' {
  const every = status === 'RUNNING' ? CONTROL_EVERY_WHILE_TESTING : CONTROL_EVERY_AFTER_KEEPING;
  const bucket = parseInt(createHash('sha1').update(key).digest('hex').slice(0, 8), 16) % every;
  return bucket === 0 ? 'control' : 'learned';
}

export interface ActivePreference {
  arm: string;
  status: 'RUNNING' | 'KEPT';
}

/**
 * What the agent currently prefers on each choice: the newest trial on each
 * that is running or was kept. A reverted trial prefers nothing, which is the
 * old behaviour.
 */
export async function activePreferences(agentId: string): Promise<Partial<Record<LearningDimension, ActivePreference>>> {
  const out: Partial<Record<LearningDimension, ActivePreference>> = {};
  const settled = new Set<string>();
  const rows = await learningRepo.trials(agentId, 60).catch(() => []);
  for (const trial of rows) {
    const dimension = trial.dimension as LearningDimension;
    if (!(dimension in LEARNING_DIMENSIONS) || settled.has(dimension)) continue;
    settled.add(dimension);
    // The newest word on a choice was "undo": nothing is preferred there.
    if (trial.status === 'REVERTED') continue;
    out[dimension] = { arm: trial.arm, status: trial.status };
  }
  return out;
}

// ── The loop ────────────────────────────────────────────────────────────────

export interface LearningPass {
  measured: number;
  decided: { dimension: string; arm: string; kept: boolean; verdict: string }[];
  started: { dimension: string; arm: string; hypothesis: string }[];
}

const DIMENSION_WORDS: Record<LearningDimension, (arm: string) => string> = {
  mode: (arm) =>
    arm === 'COMMUNITY'
      ? 'answering people in the replies of accounts it follows'
      : arm === 'CIRCLE'
        ? 'talking to the people those accounts talk to'
        : 'searching its own subjects',
  length: (arm) => (arm === 'SHORT' ? 'short replies' : arm === 'MEDIUM' ? 'medium-length replies' : 'longer replies'),
  question: (arm) => (arm === 'ASKS' ? 'asking something' : 'saying something without asking'),
  audience: (arm) =>
    arm === 'SMALL' ? 'authors with under a thousand followers' : arm === 'MID' ? 'authors with thousands of followers' : 'authors with tens of thousands of followers or more',
};

/**
 * One pass of learning for one agent: score what can be scored, decide trials
 * that are ready, and start one where the evidence now says so.
 *
 * Runs from the agent's wake, so it has no timer of its own and stops when
 * thinking stops. Never throws: a failed pass loses a pass, never a reply.
 */
export async function learnFromOutcomes(agentId: string, now = new Date()): Promise<LearningPass> {
  const pass: LearningPass = { measured: 0, decided: [], started: [] };
  try {
    const actions = await learningRepo.measurableActions(agentId, SETTLE_HOURS);
    const history = await learningRepo.recentReach(agentId);
    const armRows = await learningRepo.arms(agentId);
    const armMap = new Map(armRows.map((a) => [`${a.dimension}:${a.arm}`, { ...aged(a, now), dimension: a.dimension, arm: a.arm }]));

    for (const action of actions) {
      const reach = reachOf(action);
      if (reach === null) continue;
      const reward = rewardOf(reach, history);
      const features = featuresOf(action);
      const stored = await learningRepo.recordOutcome({ actionId: action.actionId, agentId, features, reach, reward });
      if (!stored) continue;
      history.unshift(reach);
      pass.measured += 1;
      for (const dimension of Object.keys(LEARNING_DIMENSIONS) as LearningDimension[]) {
        const arm = features[dimension];
        if (typeof arm !== 'string') continue;
        const key = `${dimension}:${arm}`;
        const current = armMap.get(key) ?? { trials: 0, reward: 0, dimension, arm };
        armMap.set(key, { ...current, trials: current.trials + 1, reward: current.reward + reward });
      }
    }
    if (pass.measured > 0) {
      for (const arm of armMap.values()) {
        await learningRepo.saveArm(agentId, { dimension: arm.dimension, arm: arm.arm, trials: arm.trials, reward: arm.reward }, now);
      }
    }

    const trust = new Map((await learningRepo.dimensions(agentId)).map((d) => [d.dimension, d]));
    const trials = await learningRepo.trials(agentId, 60);
    const running = new Map(trials.filter((t) => t.status === 'RUNNING').map((t) => [t.dimension, t]));

    for (const trial of running.values()) {
      const verdict = judgeTrial(await learningRepo.trialEvidence(agentId, trial.dimension, trial.startedAt), trial.startedAt, now);
      if (!verdict.decided) continue;
      await learningRepo.decideTrial(trial.id, verdict.kept ? 'KEPT' : 'REVERTED', verdict.verdict);
      const record = trust.get(trial.dimension) ?? { dimension: trial.dimension, confidence: 1, kept: 0, reverted: 0 };
      const next = {
        ...record,
        confidence: nextConfidence(record.confidence, verdict.kept),
        kept: record.kept + (verdict.kept ? 1 : 0),
        reverted: record.reverted + (verdict.kept ? 0 : 1),
      };
      trust.set(trial.dimension, next);
      await learningRepo.saveDimension(agentId, next);
      if (!verdict.kept) {
        // What was tried and failed counts for less, so the same change does
        // not restart on the very next pass.
        const key = `${trial.dimension}:${trial.arm}`;
        const arm = armMap.get(key);
        if (arm) {
          armMap.set(key, { ...arm, reward: arm.reward * 0.7 });
          await learningRepo.saveArm(agentId, { dimension: arm.dimension, arm: arm.arm, trials: arm.trials, reward: arm.reward * 0.7 }, now);
        }
      }
      running.delete(trial.dimension);
      pass.decided.push({ dimension: trial.dimension, arm: trial.arm, kept: verdict.kept, verdict: verdict.verdict });
    }

    const current = await activePreferences(agentId);
    for (const dimension of Object.keys(LEARNING_DIMENSIONS) as LearningDimension[]) {
      if (running.has(dimension)) continue;
      const preference = preferenceFrom(
        dimension,
        [...armMap.values()].filter((a) => a.dimension === dimension),
        trust.get(dimension)?.confidence ?? 1,
      );
      if (!preference) continue;
      // Already preferred and kept: nothing new to test.
      if (current[dimension]?.arm === preference.arm && current[dimension]?.status === 'KEPT') continue;
      const hypothesis =
        `${DIMENSION_WORDS[dimension](preference.arm)[0]!.toUpperCase()}${DIMENSION_WORDS[dimension](preference.arm).slice(1)} ` +
        `has placed at ${pct(preference.mean)} of its own range against ${pct(preference.baseline)} on average, ` +
        `over about ${Math.round(preference.evidence)} measured actions. Testing whether leaning into it does better.`;
      const started = await learningRepo.startTrial({ agentId, dimension, arm: preference.arm, hypothesis });
      if (started) pass.started.push({ dimension, arm: preference.arm, hypothesis });
    }
  } catch (error) {
    log.warn('learning pass failed', { agentId, message: error instanceof Error ? error.message : String(error) });
  }
  return pass;
}

// ── What the owner is shown ─────────────────────────────────────────────────

export interface LearningView {
  outcomes: number;
  choices: {
    dimension: LearningDimension;
    trust: number;
    kept: number;
    reverted: number;
    options: { arm: string; label: string; placed: number; evidence: number }[];
    current: { arm: string; label: string; status: 'RUNNING' | 'KEPT' } | null;
  }[];
  trials: {
    dimension: string;
    arm: string;
    label: string;
    status: string;
    hypothesis: string;
    verdict: string | null;
    startedAt: string;
    decidedAt: string | null;
    /**
     * For a running trial, how many measured actions it has on each side and
     * how many it needs before it is decided. Null once decided: the verdict
     * already carries the numbers it was decided on.
     */
    samples: { withChange: number; control: number; neededWithChange: number; neededControl: number; decidesBy: string } | null;
  }[];
  /** The rules the learner works under, stated so an owner can read them rather than infer them. */
  rules: {
    controlWhileTesting: string;
    controlAfterKeeping: string;
    measuredAfterHours: number;
    neverTouches: string[];
  };
  /** Owner decisions the learner and outreach take into account. */
  ownerFeedback: { rejectedThisWeek: number; acceptedThisWeek: number };
}

/**
 * What an agent has learned, in words. Read only: showing it changes nothing,
 * and nothing is aged on the way out except for display.
 */
export async function describeLearning(agentId: string, now = new Date()): Promise<LearningView> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const [outcomes, armRows, dims, trialRows, current, signals] = await Promise.all([
    learningRepo.outcomeCount(agentId),
    learningRepo.arms(agentId),
    learningRepo.dimensions(agentId),
    learningRepo.trials(agentId, 20),
    activePreferences(agentId),
    introspectionRepo.ownerDecisions(agentId, weekAgo, 200).catch(() => []),
  ]);
  const samples = new Map<string, LearningView['trials'][number]['samples']>();
  for (const t of trialRows.filter((row) => row.status === 'RUNNING')) {
    const evidence = await learningRepo.trialEvidence(agentId, t.dimension, t.startedAt).catch(() => ({ applied: [], held: [] }));
    samples.set(`${t.dimension}:${t.startedAt}`, {
      withChange: evidence.applied.length,
      control: evidence.held.length,
      neededWithChange: TRIAL_APPLIED,
      neededControl: TRIAL_CONTROL,
      decidesBy: new Date(new Date(t.startedAt).getTime() + TRIAL_MAX_DAYS * DAY_MS).toISOString(),
    });
  }
  const label = (dimension: string, arm: string) =>
    dimension in DIMENSION_WORDS ? DIMENSION_WORDS[dimension as LearningDimension](arm) : arm.toLowerCase();
  return {
    outcomes,
    choices: (Object.keys(LEARNING_DIMENSIONS) as LearningDimension[]).map((dimension) => {
      const record = dims.find((d) => d.dimension === dimension);
      const active = current[dimension];
      return {
        dimension,
        trust: record?.confidence ?? 1,
        kept: record?.kept ?? 0,
        reverted: record?.reverted ?? 0,
        options: armRows
          .filter((a) => a.dimension === dimension)
          .map((a) => ({ arm: a.arm, ...aged(a, now) }))
          .filter((a) => a.trials >= 0.5)
          .map((a) => ({ arm: a.arm, label: label(dimension, a.arm), placed: meanOf(a), evidence: Math.round(a.trials) }))
          .sort((a, b) => b.placed - a.placed),
        current: active ? { arm: active.arm, label: label(dimension, active.arm), status: active.status } : null,
      };
    }),
    trials: trialRows.map((t) => ({
      dimension: t.dimension,
      arm: t.arm,
      label: label(t.dimension, t.arm),
      status: t.status,
      hypothesis: t.hypothesis,
      verdict: t.verdict,
      startedAt: t.startedAt,
      decidedAt: t.decidedAt,
      samples: samples.get(`${t.dimension}:${t.startedAt}`) ?? null,
    })),
    rules: {
      controlWhileTesting: `While a change is being tried, one decision in ${CONTROL_EVERY_WHILE_TESTING} keeps the old behaviour, so the two can be compared.`,
      controlAfterKeeping: `After a change is kept, one decision in ${CONTROL_EVERY_AFTER_KEEPING} still keeps the old behaviour, so a change that stops working is noticed.`,
      measuredAfterHours: SETTLE_HOURS,
      neverTouches: ['identity', 'safety rules', 'permissions', 'do not contact', 'financial policy', 'your limits', 'quality gates'],
    },
    ownerFeedback: {
      rejectedThisWeek: signals.filter((s) => s.decision === 'REJECTED').length,
      acceptedThisWeek: signals.filter((s) => s.decision === 'APPROVED' || s.decision === 'ACCEPTED').length,
    },
  };
}

/** Forgets everything this agent learned, at the owner's request. */
export async function resetLearning(agentId: string): Promise<void> {
  await learningRepo.reset(agentId);
}
