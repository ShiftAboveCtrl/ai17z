import { describe, expect, it } from 'vitest';
import { capabilityInvocations, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';

installHarness();

/**
 * A capability's path from the menu to use, counted from what was recorded:
 * offered from the capability loop's trace, chosen and run and returned from
 * the invocation rows, and used only when a successful result fed a job that
 * went on to publish. Registered is not working, and neither is any single
 * step short of the last.
 */

async function jobs(agentId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const outcome = await ingestNormalizedEvent({ accountId: null, onlyAgentId: agentId, event: mockEvent(`A question worth an answer, number ${i} of ${n}`) });
    const job = outcome.jobs[0]?.job;
    if (!job) throw new Error('the fixture produced no job');
    ids.push(job.id);
  }
  return ids;
}

const run = (agentId: string, jobId: string | null, capabilityId: string, outcome: 'SUCCEEDED' | 'FAILED' | 'REFUSED' | 'TIMED_OUT') =>
  capabilityInvocations.recordInvocation({ agentId, jobId, accountId: null, capabilityId, step: 1, outcome, detail: '', input: {}, output: null, durationMs: 1 });

describe('a capability lifecycle', () => {
  it('separates offered, chosen, ran, returned and used', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const agentId = fixture.agentId;
    const [published, unpublished] = await jobs(agentId, 2);

    // Offered three times; the clock once.
    for (const offered of [['web.read_page', 'time.now'], ['web.read_page'], ['web.read_page']]) {
      await query(`INSERT INTO trace_events (agent_id, type, data) VALUES ($1, 'CAPABILITY_OFFERED', $2::jsonb)`, [agentId, JSON.stringify({ offered })]);
    }
    await run(agentId, published!, 'web.read_page', 'SUCCEEDED');
    await run(agentId, unpublished!, 'web.read_page', 'SUCCEEDED');
    await run(agentId, unpublished!, 'web.read_page', 'FAILED');
    await run(agentId, unpublished!, 'web.read_page', 'REFUSED');
    await query(`UPDATE jobs SET status = 'EXECUTED' WHERE id = $1`, [published]);

    const rows = await capabilityInvocations.lifecycleForAgent(agentId, 30);
    const page = rows.find((r) => r.capabilityId === 'web.read_page');
    expect(page).toMatchObject({ offered: 3, selected: 4, executed: 3, returned: 2, used: 1 });
    expect(rows.find((r) => r.capabilityId === 'time.now')).toMatchObject({ offered: 1, selected: 0, used: 0 });
  });

  it('counts nothing from another agent, and nothing outside the window', async () => {
    await seedCatalogue();
    const mine = await createFixture();
    const other = await createFixture();
    await run(other.agentId, null, 'web.read_page', 'SUCCEEDED');
    await run(mine.agentId, null, 'web.read_page', 'SUCCEEDED');
    await query(`UPDATE capability_invocations SET created_at = now() - interval '40 days' WHERE agent_id = $1`, [mine.agentId]);
    expect(await capabilityInvocations.lifecycleForAgent(mine.agentId, 30)).toEqual([]);
  });
});
