import { experiments as experimentsRepo, type ExperimentRow } from '@xbam/database';
import { createLogger } from '@xbam/shared';
import {
  assignVariant,
  readExperiment,
  type ExperimentDefinition,
  type ExperimentReading,
} from './experiments';
import { engagementRate } from './contentIntelligence';

const log = createLogger('experiments');

/**
 * Running an experiment against what the agent actually posts.
 *
 * `experiments.ts` is the arithmetic and knows nothing about a database. This
 * is the part that decides which arm a post belongs to, writes that down, and
 * reads the answer back out of what was published and measured.
 *
 * Two things it deliberately does not do. It never touches a reply: an
 * experiment about how the agent writes belongs to the posts it chooses to
 * make, and quietly varying the way it answers somebody is an experiment run on
 * a person who did not agree to be in one. And it never fails a job -- an
 * assignment that could not be written means the post goes out unvaried and
 * uncounted, which is a missing data point rather than a missing post.
 */

/** The stored row as the pure code wants to see it. */
function definitionOf(row: ExperimentRow): ExperimentDefinition {
  return {
    id: row.id,
    hypothesis: row.hypothesis,
    variants: [
      { key: row.variant_a_key, label: row.variant_a_label },
      { key: row.variant_b_key, label: row.variant_b_label },
    ],
    minimumPerArm: row.minimum_per_arm,
  };
}

export interface AssignedVariant {
  experimentId: string;
  key: string;
  label: string;
  /** Added to the output rules for this one post. Empty for a control arm. */
  instruction: string;
}

/**
 * Which arm this post is being written for, if the agent is running anything.
 *
 * Keyed on the job's idempotency key rather than on its id, because that key is
 * anchored to the idea and survives a job being recreated -- and a post that
 * moved arms between two attempts would land in both.
 *
 * The stored assignment wins over a fresh hash. `assign` is idempotent per job,
 * so a retry gets back the arm that was chosen the first time even if somebody
 * has edited the experiment in between.
 */
export async function variantForPost(input: {
  agentId: string;
  jobId: string;
  jobIdempotencyKey: string;
}): Promise<AssignedVariant | null> {
  try {
    const row = await experimentsRepo.running(input.agentId);
    if (!row) return null;

    const chosen = assignVariant(definitionOf(row), input.jobIdempotencyKey);
    const stored = await experimentsRepo.assign({
      experimentId: row.id,
      agentId: input.agentId,
      jobId: input.jobId,
      variantKey: chosen.key,
    });

    const isA = stored.variant_key === row.variant_a_key;
    return {
      experimentId: row.id,
      key: stored.variant_key,
      label: isA ? row.variant_a_label : row.variant_b_label,
      instruction: isA ? row.variant_a_instruction : row.variant_b_instruction,
    };
  } catch (error) {
    // Never fails the post. A missing data point is not worth a missing post.
    log.warn('could not assign an experiment variant', {
      agentId: input.agentId,
      jobId: input.jobId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Attaches the published post to whichever arm it was written for.
 *
 * Until this happens the assignment is a post that may never have been sent,
 * and one that was never sent takes no part in any comparison. Called from the
 * execution step after the remote confirmed it, so a draft that was reviewed
 * and discarded never counts.
 */
export async function recordPublished(jobId: string, remotePostId: string): Promise<void> {
  await experimentsRepo.published(jobId, remotePostId).catch((error: unknown) => {
    log.warn('could not attach a published post to its experiment', {
      jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export interface ExperimentView {
  id: string;
  hypothesis: string;
  status: 'RUNNING' | 'STOPPED';
  createdAt: string;
  endedAt: string | null;
  variants: { key: string; label: string; instruction: string }[];
  reading: ExperimentReading;
  /**
   * Published posts in this experiment that nobody has measured yet.
   *
   * Named separately rather than folded into the counts, because "twelve posts
   * and still no verdict" needs an explanation. These are not failures and not
   * zeroes -- they are posts the comparison cannot use.
   */
  unmeasured: number;
}

/** What one experiment has found, or why it has not found anything yet. */
export async function readExperimentRun(row: ExperimentRow): Promise<ExperimentView> {
  const rows = await experimentsRepo.readings(row.id);
  const byArm = new Map<string, number[]>([
    [row.variant_a_key, []],
    [row.variant_b_key, []],
  ]);
  for (const reading of rows) {
    const rate = engagementRate({
      statusId: reading.remote_post_id,
      text: '',
      publishedAt: '',
      ...(reading.impressions === null ? {} : { impressions: reading.impressions }),
      ...(reading.likes === null ? {} : { likes: reading.likes }),
      ...(reading.replies === null ? {} : { replies: reading.replies }),
      ...(reading.reposts === null ? {} : { reposts: reading.reposts }),
    });
    // A published post nobody has measured is left out of the comparison
    // entirely rather than counted as a zero, exactly as content signals do.
    if (rate === undefined) continue;
    byArm.get(reading.variant_key)?.push(rate);
  }

  const definition = definitionOf(row);
  return {
    id: row.id,
    hypothesis: row.hypothesis,
    status: row.status,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    variants: [
      { key: row.variant_a_key, label: row.variant_a_label, instruction: row.variant_a_instruction },
      { key: row.variant_b_key, label: row.variant_b_label, instruction: row.variant_b_instruction },
    ],
    reading: readExperiment(definition, [
      { key: row.variant_a_key, rates: byArm.get(row.variant_a_key) ?? [] },
      { key: row.variant_b_key, rates: byArm.get(row.variant_b_key) ?? [] },
    ]),
    unmeasured: rows.length - [...byArm.values()].reduce((total, rates) => total + rates.length, 0),
  };
}

/** Everything this agent has tried, newest first, each with its answer. */
export async function experimentsFor(agentId: string): Promise<ExperimentView[]> {
  const rows = await experimentsRepo.listForAgent(agentId);
  return Promise.all(rows.map(readExperimentRun));
}
