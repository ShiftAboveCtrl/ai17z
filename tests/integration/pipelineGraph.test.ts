import { describe, expect, it } from 'vitest';
import { PipelineDraft } from '@xbam/shared/contracts';
import { jobs as jobsRepo, memories, pipelines as pipelinesRepo } from '@xbam/database';
import { defaultPipelineDraft, ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

const node = (key: string, kind: string, config: Record<string, unknown> = {}) => ({
  key, kind, label: key, config, x: 0, y: 0,
});

/**
 * The graph in the database is the graph that runs. These assert that by
 * changing the graph and observing the runtime take a different path.
 */
describe('the pipeline graph drives execution', () => {
  it('walks the default graph and records the path it took', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('walk the graph'),
    });
    await drainJobs();

    const jobId = outcome.jobs[0]!.job.id;
    expect((await jobsRepo.requireJob(jobId)).status).toBe('EXECUTED');
    const path = (await jobsRepo.listJobAttempts(jobId)).map((a) => a.step.split(':')[0]);
    expect(path).toContain('filter');
    expect(path).toContain('approval');
    expect(path).toContain('remember');
    expect(path.at(-1)).toBe('done');
  });

  it('takes the false branch of a filter and never calls a model', async () => {
    const fixture = await createFixture();
    const draft = defaultPipelineDraft();
    draft.nodes.find((n) => n.key === 'filter')!.config = { requirePhrases: ['urgent'] };
    await pipelinesRepo.savePipelineVersion(fixture.agentId, PipelineDraft.parse(draft), null);

    const outcome = await ingestNormalizedEvent({
      accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('just saying hello'),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('CANCELLED');
    expect(job.lastError).toMatch(/filtered out/i);
    expect(job.generatedOutput).toBeNull();

    const path = (await jobsRepo.listJobAttempts(job.id)).map((a) => a.step.split(':')[0]);
    expect(path).toEqual(['trigger', 'filter', 'skipped']);
  });

  it('takes the true branch when the filter is satisfied', async () => {
    const fixture = await createFixture();
    const draft = defaultPipelineDraft();
    draft.nodes.find((n) => n.key === 'filter')!.config = { requirePhrases: ['urgent'] };
    await pipelinesRepo.savePipelineVersion(fixture.agentId, PipelineDraft.parse(draft), null);

    const outcome = await ingestNormalizedEvent({
      accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('this one is urgent'),
    });
    await drainJobs();
    expect((await jobsRepo.requireJob(outcome.jobs[0]!.job.id)).status).toBe('EXECUTED');
  });

  it('pins a running job to the graph version it started on', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('pinned'),
    });
    const pinned = outcome.jobs[0]!.job.pipelineVersionId;
    expect(pinned).toBeTruthy();

    // Replacing the active graph must not change what this job does.
    await pipelinesRepo.savePipelineVersion(fixture.agentId, defaultPipelineDraft('changed'), null);
    expect((await pipelinesRepo.getActivePipeline(fixture.agentId))?.id).not.toBe(pinned);

    await drainJobs();
    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.pipelineVersionId).toBe(pinned);
    expect(job.status).toBe('EXECUTED');
  });
});

describe('custom graphs change what the runtime does', () => {
  it('routes on a condition node, so a graph edit changes behaviour', async () => {
    const fixture = await createFixture();
    // Anything longer than five characters goes to a dead end instead of acting.
    const draft = PipelineDraft.parse({
      name: 'condition test',
      nodes: [
        node('trigger', 'TRIGGER'),
        node('context', 'RESOLVE_CONTEXT'),
        node('memory', 'RETRIEVE_MEMORY'),
        node('generate', 'GENERATE'),
        node('validate', 'VALIDATE'),
        node('check', 'CONDITION', { subject: 'outputLength', max: 5 }),
        node('execute', 'EXECUTE_ACTION'),
        node('tooLong', 'END', { reason: 'the reply was too long for this pipeline' }),
        node('done', 'END'),
      ],
      edges: [
        { from: 'trigger', to: 'context', branch: 'next' },
        { from: 'context', to: 'memory', branch: 'next' },
        { from: 'memory', to: 'generate', branch: 'next' },
        { from: 'generate', to: 'validate', branch: 'next' },
        { from: 'validate', to: 'check', branch: 'next' },
        { from: 'check', to: 'execute', branch: 'true' },
        { from: 'check', to: 'tooLong', branch: 'false' },
        { from: 'execute', to: 'done', branch: 'next' },
      ],
    });
    await pipelinesRepo.savePipelineVersion(fixture.agentId, draft, null);

    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('produce a reply longer than five characters'),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('CANCELLED');
    expect(job.lastError).toMatch(/too long/i);
    const path = (await jobsRepo.listJobAttempts(job.id)).map((a) => a.step.split(':')[0]);
    expect(path.at(-1)).toBe('tooLong');
    expect(path).not.toContain('execute');
  });

  it('writes memory from its own node, not as a side effect of acting', async () => {
    const fixture = await createFixture();
    // A graph with no MEMORY_WRITE node leaves no memory behind, which proves
    // the write is the node's doing rather than hidden inside the action.
    const draft = PipelineDraft.parse({
      name: 'no memory write',
      nodes: [
        node('trigger', 'TRIGGER'),
        node('context', 'RESOLVE_CONTEXT'),
        node('memory', 'RETRIEVE_MEMORY'),
        node('generate', 'GENERATE'),
        node('validate', 'VALIDATE'),
        node('execute', 'EXECUTE_ACTION'),
        node('done', 'END'),
      ],
      edges: [
        { from: 'trigger', to: 'context', branch: 'next' },
        { from: 'context', to: 'memory', branch: 'next' },
        { from: 'memory', to: 'generate', branch: 'next' },
        { from: 'generate', to: 'validate', branch: 'next' },
        { from: 'validate', to: 'execute', branch: 'next' },
        { from: 'execute', to: 'done', branch: 'next' },
      ],
    });
    await pipelinesRepo.savePipelineVersion(fixture.agentId, draft, null);

    await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('remember that my favourite number is 41'),
    });
    await drainJobs();

    expect((await memories.searchMemories({ agentId: fixture.agentId, limit: 20 })).total).toBe(0);
  });

  it('delays without holding a worker, then resumes where it left off', async () => {
    const fixture = await createFixture();
    const draft = PipelineDraft.parse({
      name: 'delayed',
      nodes: [
        node('trigger', 'TRIGGER'),
        node('wait', 'DELAY', { seconds: 1 }),
        node('context', 'RESOLVE_CONTEXT'),
        node('memory', 'RETRIEVE_MEMORY'),
        node('generate', 'GENERATE'),
        node('validate', 'VALIDATE'),
        node('execute', 'EXECUTE_ACTION'),
        node('done', 'END'),
      ],
      edges: [
        { from: 'trigger', to: 'wait', branch: 'next' },
        { from: 'wait', to: 'context', branch: 'next' },
        { from: 'context', to: 'memory', branch: 'next' },
        { from: 'memory', to: 'generate', branch: 'next' },
        { from: 'generate', to: 'validate', branch: 'next' },
        { from: 'validate', to: 'execute', branch: 'next' },
        { from: 'execute', to: 'done', branch: 'next' },
      ],
    });
    await pipelinesRepo.savePipelineVersion(fixture.agentId, draft, null);

    const outcome = await ingestNormalizedEvent({
      accountId: null, onlyAgentId: fixture.agentId, event: mockEvent('take your time'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    await drainJobs();
    // The delay parked the job on the node after it, due in the future.
    let job = await jobsRepo.requireJob(jobId);
    expect(job.currentNodeKey).toBe('context');
    expect(new Date(job.runAt).getTime()).toBeGreaterThan(Date.now());

    await jobsRepo.updateJob(jobId, { runAt: new Date(Date.now() - 1000).toISOString() });
    await drainJobs();

    job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('EXECUTED');
    // The delay ran once, not again on resume.
    const waits = (await jobsRepo.listJobAttempts(jobId)).filter((a) => a.step.startsWith('wait:'));
    expect(waits).toHaveLength(1);
  });
});
