import { describe, expect, it } from 'vitest';
import { jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';

installHarness();

/**
 * What the owner is shown about how fast an agent has been answering.
 *
 * Read from the agent's own jobs, and only the ones that reached a checked
 * draft: a declined post is not a fast answer, and nothing finished is not
 * zero seconds.
 */
describe('how fast an agent has been answering', () => {
  it('says nothing was drafted rather than reporting zero', async () => {
    const fixture = await createFixture();
    expect(await jobsRepo.responseSummary(fixture.agentId, 24)).toEqual({
      answered: 0,
      p50Seconds: null,
      p90Seconds: null,
      modelCallsPerAnswer: null,
    });
  });

  it('measures arrival to a checked draft, per agent', async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    for (const text of ['what do you think about pools?', 'how do fees work here?']) {
      await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event: mockEvent(text) });
    }
    await drainAgentJobs(fixture.agentId);
    // Pin the timings so the percentiles are exact.
    const ids = (await query<{ id: string }>(`SELECT id FROM jobs WHERE agent_id = $1 ORDER BY created_at`, [fixture.agentId])).map((r) => r.id);
    await query(`UPDATE jobs SET validated_at = created_at + interval '4 seconds' WHERE id = $1`, [ids[0]]);
    await query(`UPDATE jobs SET validated_at = created_at + interval '10 seconds' WHERE id = $1`, [ids[1]]);

    const summary = await jobsRepo.responseSummary(fixture.agentId, 24);
    expect(summary.answered).toBe(2);
    expect(summary.p50Seconds).toBe(7);
    expect(summary.p90Seconds).toBe(9.4);
    expect(summary.modelCallsPerAnswer).toBeGreaterThan(0);
    // Another agent's work is not this one's.
    expect((await jobsRepo.responseSummary(other.agentId, 24)).answered).toBe(0);
  });
});
