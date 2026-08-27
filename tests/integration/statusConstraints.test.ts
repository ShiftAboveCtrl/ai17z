import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATUSES, PIPELINE_NODE_KINDS, TRACE_EVENT_TYPES } from '@xbam/shared/contracts';
import { accounts as accountsRepo, observability, pipelines } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The enum and the CHECK constraint have to agree.
 *
 * They did not: migration 0020 added seven account states and taught the code to
 * write them while the constraint still listed the old five. Every sign-in died
 * at the database with a constraint error, and no test noticed because the unit
 * tests never touched Postgres and the integration tests only wrote old values.
 */
describe('every account status the code can produce is one the database accepts', () => {
  it('writes each status in the contract without violating the constraint', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `status_${uniqueSuffix()}`,
    });

    for (const status of ACCOUNT_STATUSES) {
      const updated = await accountsRepo.updateAccount(account.id, { status });
      expect(updated.status).toBe(status);
    }
  });

  it('still refuses a status that is not in the contract', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `status_${uniqueSuffix()}`,
    });

    await expect(
      accountsRepo.updateAccount(account.id, { status: 'DEFINITELY_NOT_A_STATUS' as never }),
    ).rejects.toThrow();
  });
});

describe('every trace type the code can emit is one the database accepts', () => {
  it('writes each type in the contract', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('trace constraint check'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    for (const type of TRACE_EVENT_TYPES) {
      await observability.emitTrace({ jobId, agentId: fixture.agentId, type, message: type });
    }
    const trace = await observability.listTrace(jobId);
    for (const type of TRACE_EVENT_TYPES) {
      expect(trace.map((t) => t.type)).toContain(type);
    }
  });
});

describe('every pipeline node kind the code can produce is one the database accepts', () => {
  it('saves a pipeline containing every node kind', async () => {
    const fixture = await createFixture();

    // A trigger and an end are structurally required; the rest hang off the
    // trigger so the graph stays valid while covering every kind.
    const nodes = PIPELINE_NODE_KINDS.map((kind, index) => ({
      key: `n${index}`,
      kind,
      label: kind,
      config: {},
      x: 0,
      y: index,
    }));

    const saved = await pipelines.savePipelineVersion(
      fixture.agentId,
      { name: 'every kind', nodes, edges: [], changeNote: 'constraint coverage' },
      null,
    );
    expect(saved.nodes.map((n) => n.kind).sort()).toEqual([...PIPELINE_NODE_KINDS].sort());
  });
});
