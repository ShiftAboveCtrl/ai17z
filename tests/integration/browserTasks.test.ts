import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, browserTasks, workers } from '@xbam/database';
import { query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function account(ownerId: string) {
  return accountsRepo.createAccount({ ownerId, channel: 'x', handle: `bt_${uniqueSuffix()}` });
}

/** Ages a task so the recovery paths can be tested without waiting. */
async function age(taskId: string, minutes: number) {
  await query(
    `UPDATE browser_tasks
        SET created_at = created_at - ($2::int * interval '1 minute'),
            started_at = CASE WHEN started_at IS NULL THEN NULL
                              ELSE started_at - ($2::int * interval '1 minute') END
      WHERE id = $1`,
    [taskId, minutes],
  );
}

describe('a task nobody has started does not block the account', () => {
  it('supersedes the earlier request instead of refusing the new one', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    const first = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'OPEN_AUTH',
      requestedBy: null,
    });

    // This is the exact thing that used to throw "already running for this
    // account" and never recover.
    const second = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'OPEN_AUTH',
      requestedBy: null,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('PENDING');

    const settled = await browserTasks.getBrowserTask(first.id);
    expect(settled?.status).toBe('SUPERSEDED');
  });

  it('supersedes across kinds too, since neither has started', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    await browserTasks.enqueueBrowserTask({ accountId: acct.id, kind: 'OPEN_AUTH', requestedBy: null });
    const health = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'HEALTH_CHECK',
      requestedBy: null,
    });
    expect(health.status).toBe('PENDING');
  });
});

describe('a task that is genuinely running still blocks', () => {
  it('refuses a second task while a worker holds a live one', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    await browserTasks.enqueueBrowserTask({ accountId: acct.id, kind: 'OPEN_AUTH', requestedBy: null });
    const claimed = await browserTasks.claimBrowserTask('worker-1');
    expect(claimed?.status).toBe('RUNNING');

    await expect(
      browserTasks.enqueueBrowserTask({ accountId: acct.id, kind: 'HEALTH_CHECK', requestedBy: null }),
    ).rejects.toThrow(/running on this account right now/i);
  });

  it('takes over once the running task has outlived its lease', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    await browserTasks.enqueueBrowserTask({ accountId: acct.id, kind: 'OPEN_AUTH', requestedBy: null });
    const claimed = await browserTasks.claimBrowserTask('worker-that-dies');
    await age(claimed!.id, browserTasks.RUNNING_LEASE_MINUTES + 1);

    const next = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'OPEN_AUTH',
      requestedBy: null,
    });
    expect(next.status).toBe('PENDING');
    expect((await browserTasks.getBrowserTask(claimed!.id))?.status).toBe('FAILED');
  });
});

describe('the sweep frees what nothing will finish', () => {
  it('fails an unclaimed task and says why, rather than leaving it pending', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    const task = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'OPEN_AUTH',
      requestedBy: null,
    });
    await age(task.id, 10);

    const freed = await browserTasks.recoverStaleBrowserTasks();
    expect(freed.unclaimed).toBe(1);

    const settled = await browserTasks.getBrowserTask(task.id);
    expect(settled?.status).toBe('FAILED');
    // The message has to point at the actual cause, which is a missing worker.
    expect(settled?.error).toMatch(/no worker able to open a browser/i);
  });

  it('distinguishes an abandoned task from one never picked up', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    const task = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'OPEN_AUTH',
      requestedBy: null,
    });
    const claimed = await browserTasks.claimBrowserTask('worker-1');
    await age(claimed!.id, browserTasks.RUNNING_LEASE_MINUTES + 1);

    const freed = await browserTasks.recoverStaleBrowserTasks();
    expect(freed.abandoned).toBe(1);
    expect(freed.unclaimed).toBe(0);
    expect((await browserTasks.getBrowserTask(task.id))?.error).toMatch(/stopped without finishing/i);
  });

  it('leaves a fresh pending task alone', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    const task = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'OPEN_AUTH',
      requestedBy: null,
    });

    await browserTasks.recoverStaleBrowserTasks();
    expect((await browserTasks.getBrowserTask(task.id))?.status).toBe('PENDING');
  });
});

describe('the owner can always get unstuck', () => {
  it('cancels everything on the account and lets the next request through', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);
    await browserTasks.enqueueBrowserTask({ accountId: acct.id, kind: 'OPEN_AUTH', requestedBy: null });
    await browserTasks.claimBrowserTask('worker-1');

    expect(await browserTasks.cancelAccountTasks(acct.id, 'Cancelled by the account owner.')).toBe(1);

    const next = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'OPEN_AUTH',
      requestedBy: null,
    });
    expect(next.status).toBe('PENDING');
  });
});

describe('worker presence', () => {
  it('knows whether anything can open a browser', async () => {
    expect(await workers.browserWorkerPresent()).toBe(false);

    await workers.heartbeat({ id: 'jobs-1', role: 'jobs', browserCapable: false, jobsCapable: true });
    expect(await workers.browserWorkerPresent()).toBe(false);

    await workers.heartbeat({ id: 'native-1', role: 'browser', browserCapable: true, jobsCapable: false });
    expect(await workers.browserWorkerPresent()).toBe(true);
  });

  it('forgets a worker that stopped announcing itself', async () => {
    await workers.heartbeat({ id: 'native-1', role: 'browser', browserCapable: true, jobsCapable: false });
    await query(
      `UPDATE workers SET last_seen_at = now() - ($1::int * interval '1 second') WHERE id = 'native-1'`,
      [workers.WORKER_PRESENT_SECONDS + 30],
    );
    expect(await workers.browserWorkerPresent()).toBe(false);
  });

  it('forgets a worker that shut down cleanly, without waiting for it to lapse', async () => {
    await workers.heartbeat({ id: 'native-1', role: 'browser', browserCapable: true, jobsCapable: false });
    await workers.goodbye('native-1');
    expect(await workers.browserWorkerPresent()).toBe(false);
  });
});

/**
 * Two reads of two people are two requests.
 *
 * `browser_tasks_active_key` allows one PENDING or RUNNING task per account,
 * because a Chrome profile is held by one process. The index is right. What was
 * wrong is that a collision superseded the pending task, which is correct for
 * CONNECT and OPEN_AUTH -- pressing Connect twice means "do it now" -- and
 * wrong for a read, where the second request names somebody else.
 *
 * Measured on a real installation before the fix: two READ_X_ACCOUNT requests
 * for different handles produced one observation. The first ended SUPERSEDED
 * with "Replaced by a newer request for the same account." and that person was
 * never read.
 */
describe('a request that names a target waits rather than deleting the one before it', () => {
  it('keeps both reads, and the second one waits', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    const alice = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'READ_X_ACCOUNT',
      requestedBy: null,
      params: { handle: 'alice' },
    });
    const bob = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'READ_X_ACCOUNT',
      requestedBy: null,
      params: { handle: 'bob' },
    });

    expect(bob.id).not.toBe(alice.id);
    // Neither is lost, and which one waits is explicit rather than implied.
    expect(alice.status).toBe('PENDING');
    expect(bob.status).toBe('QUEUED');

    const still = await browserTasks.getBrowserTask(alice.id);
    expect(still?.status, 'the first read was superseded again').toBe('PENDING');
  });

  it('serves them one at a time, oldest first, and both eventually run', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    for (const handle of ['alice', 'bob', 'carol']) {
      await browserTasks.enqueueBrowserTask({
        accountId: acct.id,
        kind: 'READ_X_ACCOUNT',
        requestedBy: null,
        params: { handle },
      });
    }

    const served: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const claimed = await browserTasks.claimBrowserTask('w-1');
      expect(claimed, `nothing claimable on round ${i + 1}`).not.toBeNull();
      served.push(String(claimed!.params.handle));
      // Only one may be running on an account at a time, which is the whole
      // reason the others waited.
      expect(await browserTasks.claimBrowserTask('w-2')).toBeNull();
      await browserTasks.finishBrowserTask(claimed!.id, 'COMPLETED', {});
    }

    expect(served).toEqual(['alice', 'bob', 'carol']);
  });

  it('treats a second request for the same person as the same request', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    const first = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'READ_X_ACCOUNT',
      requestedBy: null,
      params: { handle: 'alice' },
    });
    // Different capitalisation and surrounding space is the same person.
    const again = await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'READ_X_ACCOUNT',
      requestedBy: null,
      params: { handle: ' Alice ' },
    });

    expect(again.id, 'asking twice for one person queued it twice').toBe(first.id);
  });

  it('refuses rather than silently dropping once the queue is full', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    // One takes the lane; the rest wait.
    for (let i = 0; i <= browserTasks.MAX_QUEUED_BROWSER_TASKS; i += 1) {
      await browserTasks.enqueueBrowserTask({
        accountId: acct.id,
        kind: 'READ_X_ACCOUNT',
        requestedBy: null,
        params: { handle: `person-${i}` },
      });
    }

    await expect(
      browserTasks.enqueueBrowserTask({
        accountId: acct.id,
        kind: 'READ_X_ACCOUNT',
        requestedBy: null,
        params: { handle: 'one-too-many' },
      }),
    ).rejects.toThrow(/already waiting/i);
  });

  it('leaves sign-in supersession alone, because a newer sign-in really does replace an older one', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    const first = await browserTasks.enqueueBrowserTask({ accountId: acct.id, kind: 'OPEN_AUTH', requestedBy: null });
    const second = await browserTasks.enqueueBrowserTask({ accountId: acct.id, kind: 'OPEN_AUTH', requestedBy: null });

    expect(second.status).toBe('PENDING');
    expect((await browserTasks.getBrowserTask(first.id))?.status).toBe('SUPERSEDED');
  });

  it('does not let a queued read overtake a running task on the same account', async () => {
    const fixture = await createFixture();
    const acct = await account(fixture.ownerId);

    await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'READ_X_ACCOUNT',
      requestedBy: null,
      params: { handle: 'alice' },
    });
    await browserTasks.enqueueBrowserTask({
      accountId: acct.id,
      kind: 'READ_X_ACCOUNT',
      requestedBy: null,
      params: { handle: 'bob' },
    });

    const running = await browserTasks.claimBrowserTask('w-1');
    expect(running).not.toBeNull();
    // Bob is queued and alice is running: nothing else may take this profile.
    expect(await browserTasks.claimBrowserTask('w-2')).toBeNull();
  });
});
