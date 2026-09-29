import { describe, expect, it } from 'vitest';
import { EngagementPolicy } from '@xbam/shared/contracts';
import { actions as actionsRepo, jobs as jobsRepo, observability } from '@xbam/database';
import { rehearse, startTestSuite, testSuiteView } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

describe('a message typed into the lab', () => {
  it('is addressed to the agent, as a mention on X would be', async () => {
    const fixture = await createFixture({ policy: { engagement: EngagementPolicy.parse({ strategy: 'SELECTIVE' }) } });
    const run = await rehearse({ agentId: fixture.agentId, subject: { channel: 'mock', authorHandle: 'tester', text: 'are you a bot or a real person?' } });
    await drainJobs();
    const decided = (await observability.listTrace(run.jobId)).find((t) => t.type === 'ENGAGEMENT_DECIDED')!;
    const factors = (decided.data as { factors: { label: string }[] }).factors.map((f) => f.label);
    expect(factors).toContain('addressed to this account');
    expect(factors).not.toContain('nothing to do with what this agent follows');
  });
});

describe('Test this agent', () => {
  it('runs every case as a rehearsal, publishes nothing, and judges each one', async () => {
    const fixture = await createFixture();
    const suite = await startTestSuite({ agentId: fixture.agentId, requestedBy: fixture.ownerId });
    expect(suite.cases.length).toBeGreaterThanOrEqual(10);
    expect(suite.cases.every((c) => c.jobId)).toBe(true);

    // Every case is a dry run, and each came from its own author so no case trips another's per-person limit.
    for (const c of suite.cases) expect((await jobsRepo.requireJob(c.jobId!)).dryRun).toBe(true);

    await drainJobs();
    const view = (await testSuiteView(suite.id))!;
    expect(view.finished).toBe(true);
    expect(view.cases.every((c) => c.verdict !== 'RUNNING')).toBe(true);
    expect(view.cases.every((c) => c.reason.length > 10)).toBe(true);
    const total = Object.values(view.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(view.cases.length);

    // Nothing reached a remote.
    for (const c of suite.cases) {
      const actions = await actionsRepo.listJobActions(c.jobId!);
      expect(actions.every((a) => a.dryRun)).toBe(true);
    }
  });
});
