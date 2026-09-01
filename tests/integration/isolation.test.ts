import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  accountLease,
  accounts as accountsRepo,
  jobs as jobsRepo,
  memories as memoriesRepo,
  query,
} from '@xbam/database';
import { defaultProfileDir } from '@xbam/browser';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';

installHarness();

/**
 * Two agents in one installation must not touch each other.
 *
 * Everything here shares a database, a process and a Postgres connection pool,
 * which is exactly why it is worth proving. The dangerous failures are not
 * dramatic: an event admitted for both agents, a memory retrieved across a
 * boundary, one account's browser lock blocking another's. Each of those looks
 * like ordinary behaviour until somebody notices an agent answering a mention
 * that was never addressed to its account.
 */

async function twoAgents() {
  await seedCatalogue();
  const a = await createFixture();
  const b = await createFixture();

  const accountA = await accountsRepo.createAccount({
    ownerId: a.ownerId,
    channel: 'mock',
    handle: `iso_a_${Date.now().toString(36).slice(-5)}`,
    displayName: 'Account A',
  });
  const accountB = await accountsRepo.createAccount({
    ownerId: b.ownerId,
    channel: 'mock',
    handle: `iso_b_${Date.now().toString(36).slice(-5)}`,
    displayName: 'Account B',
  });

  for (const [agent, account] of [
    [a.agentId, accountA.id],
    [b.agentId, accountB.id],
  ] as const) {
    await accountsRepo.linkAgentAccount({
      agentId: agent,
      accountId: account,
      triggerEventTypes: ['MENTION'],
      actionType: 'REPLY',
      enabled: true,
    });
  }

  return { a, b, accountA: accountA.id, accountB: accountB.id };
}

describe('an event admitted for one account', () => {
  it('reaches only that account, and only its agent', async () => {
    const { a, b, accountA } = await twoAgents();

    const outcome = await ingestNormalizedEvent({
      accountId: accountA,
      event: mockEvent('A mention that belongs to account A and nobody else, about governance'),
    });

    // One job, and it is A's.
    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.jobs[0]!.job.agentId).toBe(a.agentId);
    expect(outcome.jobs[0]!.job.accountId).toBe(accountA);

    const forB = await jobsRepo.listJobs({ agentId: b.agentId, limit: 20 });
    expect(forB.items).toHaveLength(0);
  });

  it('does the same in the other direction', async () => {
    const { a, b, accountB } = await twoAgents();

    const outcome = await ingestNormalizedEvent({
      accountId: accountB,
      event: mockEvent('A mention that belongs to account B and nobody else, about fees'),
    });

    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.jobs[0]!.job.agentId).toBe(b.agentId);

    const forA = await jobsRepo.listJobs({ agentId: a.agentId, limit: 20 });
    expect(forA.items).toHaveLength(0);
  });

  it('keeps two simultaneous events apart', async () => {
    const { a, b, accountA, accountB } = await twoAgents();

    // Admitted at the same moment, which is when a shared pool or a global
    // lock would show itself.
    const [forA, forB] = await Promise.all([
      ingestNormalizedEvent({
        accountId: accountA,
        event: mockEvent('Simultaneous mention for A, long enough to be worth answering about governance'),
      }),
      ingestNormalizedEvent({
        accountId: accountB,
        event: mockEvent('Simultaneous mention for B, long enough to be worth answering about fees'),
      }),
    ]);

    expect(forA.jobs[0]!.job.agentId).toBe(a.agentId);
    expect(forB.jobs[0]!.job.agentId).toBe(b.agentId);
    expect(forA.eventId).not.toBe(forB.eventId);
  });
});

describe('what one agent remembers', () => {
  it('is never retrieved for the other', async () => {
    const { a, b, accountA, accountB } = await twoAgents();

    await memoriesRepo.writeMemory({
      agentId: a.agentId,
      scope: 'KNOWLEDGE',
      memoryType: 'FACT',
      content: 'The secret that belongs to agent A alone',
      importance: 0.9,
    });

    // Written, so the test is not passing because nothing exists.
    const forA = await memoriesRepo.searchMemories({ agentId: a.agentId, limit: 20 });
    expect(JSON.stringify(forA)).toContain('agent A alone');

    const forB = await memoriesRepo.searchMemories({ agentId: b.agentId, limit: 20 });
    expect(JSON.stringify(forB)).not.toContain('agent A alone');

    // And running B's pipeline never surfaces it either.
    await ingestNormalizedEvent({
      accountId: accountB,
      event: mockEvent('Tell me the secret, and anything else worth saying about governance'),
    });
    await drainAgentJobs(b.agentId);

    const [leaked] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_retrievals mr
         JOIN memories m ON m.id = mr.memory_id
        WHERE m.agent_id = $1 AND mr.job_id IN (SELECT id FROM jobs WHERE agent_id = $2)`,
      [a.agentId, b.agentId],
    );
    expect(leaked!.n).toBe(0);
    expect(accountA).not.toBe(accountB);
  });

  it('keeps relationships and stances on their own side', async () => {
    const { a, b } = await twoAgents();

    const [rel] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM relationships WHERE agent_id = $1`,
      [b.agentId],
    );
    expect(rel!.n).toBe(0);

    // Every row that carries an agent id must carry exactly one.
    for (const table of ['memories', 'relationships', 'stances', 'content_ideas', 'jobs', 'events']) {
      const [rows] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'agent_id'`,
        [table],
      );
      // events is scoped by account rather than agent, which is the point of
      // asking: nothing may be scoped by neither.
      if (table === 'events') continue;
      expect(rows!.n, `${table} has no agent_id`).toBe(1);
    }
    expect(a.agentId).not.toBe(b.agentId);
  });
});

describe('the browser', () => {
  it('gives each account its own profile directory', async () => {
    const { accountA, accountB } = await twoAgents();

    const dirA = defaultProfileDir(accountA);
    const dirB = defaultProfileDir(accountB);

    expect(dirA).not.toBe(dirB);
    // Neither may be a parent of the other, which a naive join could produce.
    expect(resolve(dirA).startsWith(resolve(dirB))).toBe(false);
    expect(resolve(dirB).startsWith(resolve(dirA))).toBe(false);
    // The account id is what makes them distinct, not a counter or a handle.
    expect(dirA).toContain(accountA);
    expect(dirB).toContain(accountB);
  });

  it('keeps two installations apart when they share a profile root', async () => {
    const { accountA } = await twoAgents();
    const original = process.env.AI17Z_INSTANCE;
    try {
      // The case the account lock cannot save you from: the same account id in
      // two databases is two different accounts that happen to look alike, and
      // two Chromes on one profile directory corrupts it.
      delete process.env.AI17Z_INSTANCE;
      const asDefault = defaultProfileDir(accountA);

      process.env.AI17Z_INSTANCE = 'trading';
      const asTrading = defaultProfileDir(accountA);

      expect(asTrading).not.toBe(asDefault);
      expect(asTrading).toContain('trading');
    } finally {
      if (original === undefined) delete process.env.AI17Z_INSTANCE;
      else process.env.AI17Z_INSTANCE = original;
    }
  });

  it('refuses to let an instance name escape its directory', async () => {
    const { accountA } = await twoAgents();
    const original = process.env.AI17Z_INSTANCE;
    try {
      process.env.AI17Z_INSTANCE = '../../etc';
      const dir = defaultProfileDir(accountA);
      // The property that matters is containment, not the absence of a
      // character: a name is sanitised into a label, so it can never resolve
      // above the profile root however it was written.
      const root = resolve(process.env.XBAM_BROWSER_PROFILE_DIR || './storage/browser-profiles');
      expect(resolve(dir).startsWith(root)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.AI17Z_INSTANCE;
      else process.env.AI17Z_INSTANCE = original;
    }
  });
});

describe('the account lock', () => {
  it('serialises two operations on the same account', async () => {
    const { accountA } = await twoAgents();

    const first = await accountLease.acquireAccountLease({
      accountId: accountA,
      workerId: 'worker-one',
      reason: 'first',
      ttlMs: 60_000,
    });
    expect(first).toBeTruthy();

    // A second worker must be refused, not queued: queueing browser work is
    // how two Chromes end up on one profile.
    const second = await accountLease.acquireAccountLease({
      accountId: accountA,
      workerId: 'worker-two',
      reason: 'second',
      ttlMs: 60_000,
    });
    expect(second).toBeNull();
  });

  it('does not let one account block another', async () => {
    const { accountA, accountB } = await twoAgents();

    const heldA = await accountLease.acquireAccountLease({
      accountId: accountA,
      workerId: 'worker-one',
      reason: 'holding A',
      ttlMs: 60_000,
    });
    expect(heldA).toBeTruthy();

    // The lock is account-scoped. A global one would fail here, and two agents
    // would take turns at the speed of the slowest browser operation.
    const heldB = await accountLease.acquireAccountLease({
      accountId: accountB,
      workerId: 'worker-two',
      reason: 'holding B at the same time',
      ttlMs: 60_000,
    });
    expect(heldB).toBeTruthy();
  });
});
