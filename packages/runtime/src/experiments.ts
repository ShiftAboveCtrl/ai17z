import { createHash } from 'node:crypto';

/**
 * Trying one thing against another, and refusing to call it early.
 *
 * An agent posts a few times a day. That is the fact this whole file is
 * arranged around: at that rate a difference between two ways of writing takes
 * weeks to show, and every honest verdict for the first fortnight is "not yet".
 * A tool that instead announces a winner on Thursday is worse than no tool,
 * because the owner will act on it and the agent's voice will drift on the
 * strength of eleven posts.
 *
 * So the verdict has three values and one of them is the usual one. There is no
 * setting to lower the threshold, and the arithmetic that decides is here in
 * one place rather than in a screen.
 *
 * Assignment is deterministic. The same post assigned twice gets the same
 * variant, because a restart between generating and publishing must not change
 * which arm a post belonged to -- that would silently mix the two groups, and
 * nothing downstream would ever notice.
 */

export const EXPERIMENT_VERDICTS = ['TOO_EARLY', 'NO_DIFFERENCE', 'DIFFERENCE'] as const;
export type ExperimentVerdict = (typeof EXPERIMENT_VERDICTS)[number];

export interface ExperimentVariant {
  /** Stable within an experiment; it is what results are recorded against. */
  key: string;
  label: string;
}

export interface ExperimentDefinition {
  id: string;
  /** What is being asked, in a sentence somebody wrote. */
  hypothesis: string;
  variants: [ExperimentVariant, ExperimentVariant];
  /** Posts per arm before a verdict is possible. */
  minimumPerArm?: number;
}

export interface VariantResult {
  key: string;
  /** One entry per post, the measured rate. Absent measurements are not here. */
  rates: number[];
}

export interface ExperimentReading {
  verdict: ExperimentVerdict;
  /** The better arm, only when the verdict is DIFFERENCE. */
  winner?: string;
  detail: string;
  perArm: { key: string; label: string; posts: number; median: number }[];
  /** What is still needed before anything can be said. */
  needed?: number;
}

/**
 * Posts per arm before this will say anything.
 *
 * Twelve, not because twelve is significant -- it is not -- but because it is
 * roughly a fortnight of an agent posting twice a day, and it is the point at
 * which one post that got picked up stops deciding the median on its own.
 */
const DEFAULT_MINIMUM_PER_ARM = 12;

/** How much better one arm has to do before "different" is the right word. */
const MEANINGFUL_LIFT = 1.3;

/**
 * Which arm something belongs to.
 *
 * A hash of the experiment id and the thing's own key, so it is stable across
 * processes and restarts and needs nothing stored. Using a random number, or
 * the time, or a counter would mean the same post could be assigned twice and
 * land in both arms -- and the resulting mixture would look like a real result.
 */
export function assignVariant(experiment: ExperimentDefinition, key: string): ExperimentVariant {
  const digest = createHash('sha256').update(`${experiment.id}:${key}`).digest();
  return experiment.variants[digest[0]! % 2]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function readExperiment(
  experiment: ExperimentDefinition,
  results: VariantResult[],
): ExperimentReading {
  const minimum = experiment.minimumPerArm ?? DEFAULT_MINIMUM_PER_ARM;
  const perArm = experiment.variants.map((variant) => {
    const rates = results.find((result) => result.key === variant.key)?.rates ?? [];
    return { key: variant.key, label: variant.label, posts: rates.length, median: Number(median(rates).toFixed(2)) };
  });

  const short = perArm.filter((arm) => arm.posts < minimum);
  if (short.length > 0) {
    const needed = short.reduce((total, arm) => total + (minimum - arm.posts), 0);
    return {
      verdict: 'TOO_EARLY',
      perArm,
      needed,
      detail: `${needed} more post${needed === 1 ? '' : 's'} needed before this can be answered: ${short
        .map((arm) => `${arm.label} has ${arm.posts} of ${minimum}`)
        .join(', ')}.`,
    };
  }

  const [first, second] = perArm as [(typeof perArm)[number], (typeof perArm)[number]];
  const [high, low] = first.median >= second.median ? [first, second] : [second, first];
  if (low.median <= 0 || high.median / low.median < MEANINGFUL_LIFT) {
    return {
      verdict: 'NO_DIFFERENCE',
      perArm,
      detail: `${first.label} and ${second.label} have performed about the same (${first.median} against ${second.median}).`,
    };
  }

  const lift = Math.round((high.median / low.median - 1) * 100);
  return {
    verdict: 'DIFFERENCE',
    winner: high.key,
    perArm,
    detail: `${high.label} has done ${lift}% better than ${low.label} over ${high.posts} and ${low.posts} posts.`,
  };
}
