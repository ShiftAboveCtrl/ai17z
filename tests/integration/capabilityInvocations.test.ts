import { describe, expect, it } from 'vitest';
import { capabilityInvocations } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The audit row, against a real database.
 *
 * The loop is only safe because it is observable, so the row is part of the
 * guarantee rather than a nice-to-have. Against real Postgres because the
 * CHECK on `outcome` is where an unknown value is actually refused -- a mock
 * would accept anything and prove nothing.
 */
async function makeAgent() {
  const fixture = await createFixture();
  return { id: fixture.agentId };
}

describe('capability invocations are durable', () => {
  it('records what ran, what it was given, and what came back', async () => {
    const agent = await makeAgent();
    const row = await capabilityInvocations.recordInvocation({
      agentId: agent.id,
      jobId: null,
      accountId: null,
      capabilityId: 'time.now',
      step: 1,
      outcome: 'SUCCEEDED',
      detail: 'Current time answered.',
      input: { timezone: 'UTC' },
      output: { ok: true, output: 'Monday' },
      durationMs: 12,
    });

    expect(row.capabilityId).toBe('time.now');
    expect(row.outcome).toBe('SUCCEEDED');
    expect(row.input).toEqual({ timezone: 'UTC' });
    expect(row.output).toEqual({ ok: true, output: 'Monday' });

    const recent = await capabilityInvocations.listForAgent(agent.id);
    expect(recent.map((r) => r.capabilityId)).toContain('time.now');
  });

  it('records a refusal too, which is the one an owner asks about', async () => {
    const agent = await makeAgent();
    const row = await capabilityInvocations.recordInvocation({
      agentId: agent.id,
      jobId: null,
      accountId: null,
      capabilityId: 'x.create_post',
      step: 2,
      outcome: 'REFUSED',
      detail: 'Post is switched off for this agent.',
      input: { text: 'hello' },
      output: null,
      durationMs: 0,
    });
    expect(row.outcome).toBe('REFUSED');
    expect(row.output).toBeNull();
  });

  it('does not count a refusal as use', async () => {
    // A model that keeps asking for something it may not have would otherwise
    // exhaust a limit by being refused, which is the wrong way round.
    const agent = await makeAgent();
    const common = {
      agentId: agent.id,
      jobId: null,
      accountId: null,
      capabilityId: 'memory.search',
      step: 1,
      input: {},
      output: null,
      durationMs: 1,
    };
    await capabilityInvocations.recordInvocation({ ...common, outcome: 'SUCCEEDED', detail: 'ran' });
    await capabilityInvocations.recordInvocation({ ...common, outcome: 'REFUSED', detail: 'off' });
    await capabilityInvocations.recordInvocation({ ...common, outcome: 'FAILED', detail: 'broke' });

    // Succeeded and failed both used it; refused did not.
    const used = await capabilityInvocations.countRecent(agent.id, 'memory.search', 60_000);
    expect(used).toBe(2);
  });

  it('refuses an outcome the vocabulary does not have', async () => {
    const agent = await makeAgent();
    await expect(
      capabilityInvocations.recordInvocation({
        agentId: agent.id,
        jobId: null,
        accountId: null,
        capabilityId: 'time.now',
        step: 1,
        // Growing an enum without widening its constraint fails at the database
        // and passes every unit test. This is the database saying no.
        outcome: 'MAYBE' as never,
        detail: '',
        input: {},
        output: null,
        durationMs: 0,
      }),
    ).rejects.toThrow();
  });
});
