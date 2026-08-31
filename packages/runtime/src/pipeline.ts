import type { JobRecord, PipelineNode } from '@xbam/shared/contracts';
import { PipelineError, createLogger, errorMessage } from '@xbam/shared';
import { accountLease, jobs as jobsRepo, observability, pipelines as pipelinesRepo } from '@xbam/database';
import { failPermanently, scheduleRetry, sendToReview } from '@xbam/jobs';
import { loadJobBundle, type JobBundle } from './loadJob';
import { NODE_HANDLERS } from './nodes';
import { buildGraph, nextNode, type Graph } from './graph';
import { defaultPipelineDraft } from './defaultPipeline';

const log = createLogger('pipeline');

/** Guard against a graph that somehow loops despite validation. */
const MAX_NODES_PER_CLAIM = 24;

/** Progress recorded against the job as each kind of node completes. */
const NODE_STATUS: Record<string, JobRecord['status']> = {
  RESOLVE_CONTEXT: 'CONTEXT_RESOLVED',
  RETRIEVE_MEMORY: 'MEMORY_RESOLVED',
  GENERATE: 'GENERATED',
  VALIDATE: 'VALIDATED',
};

async function graphForJob(job: JobRecord): Promise<Graph> {
  const version = job.pipelineVersionId
    ? await pipelinesRepo.getPipelineVersion(job.pipelineVersionId)
    : await pipelinesRepo.getActivePipeline(job.agentId);

  const graph = version ? buildGraph(version.nodes, version.edges) : null;
  if (graph) return graph;

  // An agent created before pipelines existed, or one whose version was removed,
  // still has to run. The default graph is the documented behaviour anyway.
  log.warn('job has no usable pipeline graph; using the default', { jobId: job.id });
  const fallback = defaultPipelineDraft();
  const built = buildGraph(fallback.nodes, fallback.edges);
  if (!built) throw PipelineError.permanent('pipeline_invalid', 'The default pipeline graph is not runnable.');
  return built;
}

/**
 * Advances a claimed job by walking the stored graph.
 *
 * The edges in the database are the edges followed here: what the pipeline view
 * draws is what ran. Each node commits its position before the next one starts,
 * so a crash resumes at the node it was on rather than restarting the job.
 */
export async function runJob(job: JobRecord, workerId: string): Promise<void> {
  if (job.requiresBrowser && job.accountId) {
    const outcome = await accountLease.withAccountLease(
      { accountId: job.accountId, workerId, reason: `job ${job.id}`, ttlMs: 5 * 60_000 },
      () => walk(job, workerId),
    );
    if (!outcome.held) {
      await jobsRepo.updateJob(job.id, {
        runAt: new Date(Date.now() + 15_000).toISOString(),
        releaseLock: true,
        lastError: `Account busy: ${outcome.heldBy?.reason ?? 'another operation'}`,
      });
      log.info('account busy, deferring job', { jobId: job.id, accountId: job.accountId });
    }
    return;
  }
  await walk(job, workerId);
}

async function walk(job: JobRecord, workerId: string): Promise<void> {
  let current = job;
  const graph = await graphForJob(current);

  await observability.emitTrace({
    jobId: current.id,
    agentId: current.agentId,
    type: 'JOB_CLAIMED',
    level: 'debug',
    message: `Claimed at ${current.currentNodeKey ?? graph.startKey}`,
    data: { workerId, attempt: current.attemptCount, node: current.currentNodeKey ?? graph.startKey },
  });

  let nodeKey = current.currentNodeKey ?? graph.startKey;

  for (let step = 0; step < MAX_NODES_PER_CLAIM; step += 1) {
    const node = graph.nodes.get(nodeKey);
    if (!node) {
      await sendToReview(
        current,
        'node_missing',
        `The pipeline has no node "${nodeKey}". The graph changed while this job was running.`,
      );
      return;
    }

    const handler = NODE_HANDLERS[node.kind];
    if (!handler) {
      // Almost always a worker older than the pipeline it just claimed: a node
      // kind was added, the graph was upgraded, and one process in the fleet is
      // still running the previous build. Saying so beats naming the enum,
      // because the fix is a deploy and not a pipeline edit.
      await failPermanently(
        current,
        'node_kind_unknown',
        `This worker has no handler for pipeline node "${node.kind}", which means it is running an older build than the pipeline expects. Update or restart the workers; nothing is wrong with the agent.`,
      );
      return;
    }

    // Position is committed before the work, so a crash re-runs this node rather
    // than skipping it. Every node that touches the outside world is idempotent.
    if (current.currentNodeKey !== nodeKey) {
      current = await jobsRepo.updateJob(current.id, { currentNodeKey: nodeKey });
    }

    const attempt = current.attemptCount + 1;
    let bundle: JobBundle;
    try {
      bundle = await loadJobBundle(current);
    } catch (error) {
      await handleFailure(current, node, attempt, error);
      return;
    }

    let outcome;
    try {
      outcome = await handler({ ...bundle, job: current }, node);
      await jobsRepo.recordAttempt({
        jobId: current.id,
        attempt,
        step: `${node.key}:${node.kind.toLowerCase()}`,
        workerId,
        outcome: 'OK',
      });
    } catch (error) {
      await handleFailure(current, node, attempt, error);
      return;
    }

    const status = outcome.status ?? NODE_STATUS[node.kind];
    current = status
      ? await jobsRepo.updateJob(current.id, { status })
      : ((await jobsRepo.getJob(current.id)) ?? current);

    const following = nextNode(graph, node.key, outcome.branch);

    if (outcome.halt) {
      // Park on the node we would run next, so resuming continues rather than
      // repeating whatever we were waiting for.
      await jobsRepo.updateJob(current.id, { currentNodeKey: following?.key ?? node.key, releaseLock: true });
      return;
    }

    if (!following) {
      log.warn('branch leads nowhere; ending the run', { jobId: current.id, node: node.key, branch: outcome.branch });
      await jobsRepo.updateJob(current.id, { releaseLock: true });
      return;
    }
    nodeKey = following.key;
  }

  // Out of steps for this claim. Release and continue on the next poll.
  await jobsRepo.updateJob(current.id, { currentNodeKey: nodeKey, releaseLock: true });
}

async function handleFailure(job: JobRecord, node: PipelineNode, attempt: number, error: unknown): Promise<void> {
  const pipelineError =
    error instanceof PipelineError ? error : PipelineError.retryable('unclassified', errorMessage(error), {}, error);

  await jobsRepo.recordAttempt({
    jobId: job.id,
    attempt,
    step: `${node.key}:${node.kind.toLowerCase()}`,
    workerId: job.lockedBy,
    outcome: pipelineError.errorClass === 'RETRYABLE' ? 'RETRYABLE' : pipelineError.errorClass,
    errorClass: pipelineError.reason,
    error: pipelineError.message,
  });

  if (pipelineError.errorClass === 'PERMANENT') {
    await failPermanently(job, pipelineError.reason, pipelineError.message);
    return;
  }
  if (pipelineError.errorClass === 'REVIEW_REQUIRED') {
    await sendToReview(job, pipelineError.reason, pipelineError.message);
    return;
  }
  if (attempt >= job.maxAttempts) {
    await sendToReview(
      { ...job, attemptCount: attempt },
      pipelineError.reason,
      `${pipelineError.message} (gave up after ${attempt} attempts)`,
    );
    return;
  }
  // A retry resumes at the same node, which is why position is committed first.
  await scheduleRetry({ ...job, attemptCount: attempt - 1 }, job.status, pipelineError.message);
}
