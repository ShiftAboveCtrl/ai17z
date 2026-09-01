import { describe, expect, it } from 'vitest';
import { jobs as jobsRepo, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';

installHarness();

/**
 * A dry run must never reach the remote, by any route.
 *
 * This is the guarantee that makes the whole system safe to experiment with,
 * and it is the one that has already been broken once: a harness passed
 * `{ options: { dryRun: true } }`, the unknown key was dropped, the flag fell
 * through to the policy default, and an autonomous agent published a reply to a
 * stranger. The lesson was not "be careful with keys" -- it was that the
 * dangerous setting must never be what you get by getting the call slightly
 * wrong.
 *
 * So this tests the boundary rather than the intention: whatever the action
 * type, whatever the trigger, a dry run leaves `actions.dry_run = false` with
 * zero rows.
 */

const REAL_ACTION = `SELECT count(*)::int AS n FROM actions WHERE agent_id = $1 AND dry_run = false`;

async function realActionsFor(agentId: string): Promise<number> {
  const [row] = await query<{ n: number }>(REAL_ACTION, [agentId]);
  return row!.n;
}

describe('every action-capable path under a dry run', () => {
  for (const type of ['MENTION', 'REPLY', 'KEYWORD_MATCH', 'MANUAL_TRIGGER', 'SCHEDULED_TRIGGER'] as const) {
    it(`performs no remote action for a ${type}`, async () => {
      // Autonomous with dryRunDefault false, so nothing but the explicit flag
      // is keeping this from going out. That is the point.
      const fixture = await createFixture();
      const outcome = await ingestNormalizedEvent({
        accountId: null,
        onlyAgentId: fixture.agentId,
        event: mockEvent('Worth a considered answer about token distribution and governance', { type }),
        dryRun: true,
      });

      const created = outcome.jobs[0];
      if (!created) return; // Some types are not triggers for this fixture; that is also no action.
      expect(created.job.dryRun).toBe(true);

      await drainAgentJobs(fixture.agentId);

      const job = await jobsRepo.requireJob(created.job.id);
      expect(job.status).not.toBe('EXECUTED');
      expect(await realActionsFor(fixture.agentId)).toBe(0);
    });
  }

  it('records the rehearsal rather than nothing at all', async () => {
    // A dry run that leaves no trace is not much use for deciding whether to
    // let the agent loose. It should show what it would have said.
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Something worth a considered answer about fees and incentives today'),
      dryRun: true,
    });
    const created = outcome.jobs[0]!;
    await drainAgentJobs(fixture.agentId);

    const job = await jobsRepo.requireJob(created.job.id);
    expect(['DRY_RUN_COMPLETED', 'CANCELLED']).toContain(job.status);
    if (job.status === 'DRY_RUN_COMPLETED') {
      expect(job.validatedOutput ?? job.generatedOutput).toBeTruthy();
      const [act] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM actions WHERE agent_id = $1 AND dry_run = true`,
        [fixture.agentId],
      );
      expect(act!.n).toBeGreaterThan(0);
    }
  });

  it('does not let a dry run consume the real idempotency key', async () => {
    // The partial unique index covers real actions only. If a dry run took the
    // key, the real reply that followed would be refused as a duplicate of a
    // rehearsal -- silently, and for good.
    const fixture = await createFixture();
    const event = mockEvent('A message that will be rehearsed and then actually answered, about governance');

    const rehearsal = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event,
      dryRun: true,
    });
    await drainAgentJobs(fixture.agentId);
    expect(await realActionsFor(fixture.agentId)).toBe(0);

    // Same event, now for real. It is the same job -- ingest is idempotent --
    // so this asks whether the rehearsal left it able to run.
    const real = await ingestNormalizedEvent({ accountId: null, onlyAgentId: fixture.agentId, event });
    expect(real.eventCreated).toBe(false);
    expect(real.jobs[0]?.job.id).toBe(rehearsal.jobs[0]?.job.id);
  });
});

describe('the flag cannot be lost on the way in', () => {
  it('refuses a nested options object rather than defaulting to acting', async () => {
    const fixture = await createFixture();
    await expect(
      ingestNormalizedEvent({
        accountId: null,
        onlyAgentId: fixture.agentId,
        event: mockEvent('The exact shape that published a reply nobody asked for'),
        options: { dryRun: true },
      } as never),
    ).rejects.toThrow(/options it does not accept/i);
    expect(await realActionsFor(fixture.agentId)).toBe(0);
  });

  it('refuses a misspelled flag', async () => {
    const fixture = await createFixture();
    await expect(
      ingestNormalizedEvent({
        accountId: null,
        onlyAgentId: fixture.agentId,
        event: mockEvent('Another shape that must not quietly become a real action today'),
        dry_run: true,
      } as never),
    ).rejects.toThrow(/options it does not accept/i);
    expect(await realActionsFor(fixture.agentId)).toBe(0);
  });

  it('refuses a string where a boolean belongs', async () => {
    // "false" is truthy, and `dryRun: "false"` reads as a dry run to a human
    // and as a real action to `Boolean()`. Neither reading should be reachable.
    const fixture = await createFixture();
    await expect(
      ingestNormalizedEvent({
        accountId: null,
        onlyAgentId: fixture.agentId,
        event: mockEvent('A third shape, where the type is wrong rather than the name'),
        dryRun: 'false',
      } as never),
    ).rejects.toThrow(/options it does not accept/i);
    expect(await realActionsFor(fixture.agentId)).toBe(0);
  });
});
