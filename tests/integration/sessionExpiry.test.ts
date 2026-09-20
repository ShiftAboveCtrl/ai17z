import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, query, workers as workersRepo } from '@xbam/database';
import { thisWorkerId } from '@xbam/shared';
import { canonicalOrPage as canonical, noteSignedOut } from '@xbam/channels';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Nobody was told the session had gone.
 *
 * The reading layer already names this: a 401 or 403 from X is NEEDS_SIGN_IN,
 * it is in STOP_ASKING, and the read stops rather than hammering. What it did
 * not do was tell anything else. So the account went on saying CONNECTED, the
 * health row went on saying "X is read through the signed-in browser", and the
 * only thing that could correct either was an owner pressing a health check by
 * hand, because nothing schedules one.
 *
 * Measured on ai17z-test: `x.read_profile` and `x.search` both refused with
 * "X wants you to sign in again", while the account said CONNECTED and health
 * said Reading X was healthy. An installation in that state looks fine and its
 * radar monitors quietly find nothing.
 *
 * `SESSION_EXPIRED` already existed for this and already drives the owner
 * notification. It just had one writer, a browser task nothing runs on a timer.
 */
const readResult = (outcome: string) =>
  ({
    outcome,
    detail: 'X wants you to sign in again in the AI17Z browser window.',
    data: null,
    provenance: { backend: 'test', gaps: [], readAt: new Date().toISOString() },
  }) as never;

async function connectedAccount(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `sess_${Date.now().toString(36).slice(-6)}`,
    displayName: 'Session',
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED' });
  return (await accountsRepo.getAccount(account.id))!;
}

const ctxFor = (account: Awaited<ReturnType<typeof connectedAccount>>) =>
  ({ account, session: null, storageDir: '.', logger: console, jobId: null }) as never;

/*
  Which process the test is pretending to be, because that is now half the rule.

  A NEEDS_SIGN_IN says the profile that was read has no session in it, and that
  is only evidence about the account when the profile read is the one the
  account's session lives in. So the downgrade is allowed only from a live
  registered browser worker, and these two helpers are how a case says which
  side of that line it is on.
*/
async function asTheBrowserWorker(): Promise<void> {
  await workersRepo.heartbeat({
    id: thisWorkerId(),
    role: 'browser',
    browserCapable: true,
    jobsCapable: false,
    hostname: 'test',
    version: 'test',
  });
}

async function asSomethingElse(): Promise<void> {
  await workersRepo.goodbye(thisWorkerId());
}

const statusOf = async (id: string) =>
  (await query<{ status: string; last_error: string | null }>('SELECT status, last_error FROM accounts WHERE id = $1', [id]))[0]!;

describe('a read that finds the session gone says so', () => {
  it('moves a connected account to SESSION_EXPIRED and keeps the reason', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    await asTheBrowserWorker();

    expect(() => canonical(readResult('NEEDS_SIGN_IN'), 'a profile', ctxFor(account))).toThrow(/sign/i);

    // The write is deliberately not awaited inside `canonical`, because telling
    // the owner must not slow a read down. It still has to land.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await statusOf(account.id);
    expect(after.status).toBe('SESSION_EXPIRED');
    expect(after.last_error).toMatch(/sign in again/i);
  });

  /*
    Only from CONNECTED, which is the rule the health task already uses: an
    account that never had a session is NEEDS_AUTH, and a read must not
    overwrite that with a state meaning "it used to work".
  */
  it('leaves an account that never had a session alone', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    await accountsRepo.updateAccount(account.id, { status: 'NEEDS_AUTH' });
    await asTheBrowserWorker();
    const fresh = (await accountsRepo.getAccount(account.id))!;

    expect(() => canonical(readResult('NEEDS_SIGN_IN'), 'a profile', ctxFor(fresh))).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await statusOf(account.id)).status).toBe('NEEDS_AUTH');
  });

  /*
    And a rate limit is not a lost session. Flattening every refusal into
    "sign in again" would send an owner to re-authenticate a working account.
  */
  it('does not touch the account when X only asked it to slow down', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    await asTheBrowserWorker();

    expect(() => canonical(readResult('RATE_LIMITED'), 'a profile', ctxFor(account))).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await statusOf(account.id)).status).toBe('CONNECTED');
  });
});

/**
 * The polling path records it too, and that is the one that notices first.
 *
 * `read.ts` covers a read somebody asked for. The radar polls on its own
 * schedule all day, so a session that has stopped being accepted shows up
 * there long before anybody opens a screen, and that file had its own handling
 * for the outcome which only ever wrote a sentence onto the source's row.
 *
 * `fromReadResult` is deliberately given only what it reads, so it can be
 * tested without a browser. The recording belongs to the callers that hold the
 * channel context, which is where the account is.
 */
describe('the radar records a lost session as well', () => {
  it('marks the account when a monitor is told to sign in', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    await asTheBrowserWorker();

    noteSignedOut(
      { channel: ctxFor(account), selfHandles: [], limit: 5, cursor: null, target: null } as never,
      'NEEDS_SIGN_IN',
      'X asked for a sign-in, so nothing was read.',
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await statusOf(account.id);
    expect(after.status).toBe('SESSION_EXPIRED');
    expect(after.last_error).toMatch(/sign-in/i);
  });
});

/**
 * And a process that does not own the browser cannot say the session is gone.
 *
 * This is the half that was missing, and it cost a live account rather than a
 * hypothetical one. A harness run outside ai17z-main derived its own profile
 * directory, which is correct and deliberate because a stored path is not
 * trusted across machines, opened a Chrome on a profile that had never been
 * signed in, was asked to sign in, and marked a healthy CONNECTED account
 * SESSION_EXPIRED. The installation's real signed-in browser was serving four
 * tabs throughout.
 *
 * `browserWorkerPresent` could not have helped: it was true the whole time.
 * The question is not whether the installation has a browser worker, it is
 * whether the caller is one.
 */
describe('only the process driving the browser may say the session is gone', () => {
  it('ignores a sign-in demand from something that is not a live browser worker', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    // A script, a harness, a checkout: nothing has written a worker row for it,
    // because `apps/worker` is the only thing that writes one.
    await asSomethingElse();

    // The read still refuses, which is right: this process genuinely cannot
    // read X. What it may not do is conclude anything about the account.
    expect(() => canonical(readResult('NEEDS_SIGN_IN'), 'a profile', ctxFor(account))).toThrow(/sign/i);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await statusOf(account.id);
    expect(after.status).toBe('CONNECTED');
    expect(after.last_error).toBeNull();
  });

  it('ignores one from the radar path too, which is the same rule and used to be a second copy of it', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    await asSomethingElse();

    noteSignedOut(
      { channel: ctxFor(account), selfHandles: [], limit: 5, cursor: null, target: null } as never,
      'NEEDS_SIGN_IN',
      'X asked for a sign-in, so nothing was read.',
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await statusOf(account.id)).status).toBe('CONNECTED');
  });

  it('ignores one from a worker that takes jobs but drives no browser', async () => {
    // The containerised worker. It has a row and it is live, so a check for
    // "is this a registered worker" would pass it, and it is exactly the
    // process that cannot see the profile, because it has no Chrome at all.
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    await workersRepo.heartbeat({
      id: thisWorkerId(),
      role: 'jobs',
      browserCapable: false,
      jobsCapable: true,
      hostname: 'test',
      version: 'test',
    });

    expect(() => canonical(readResult('NEEDS_SIGN_IN'), 'a profile', ctxFor(account))).toThrow(/sign/i);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await statusOf(account.id)).status).toBe('CONNECTED');
  });

  it('ignores one from a browser worker that stopped heartbeating', async () => {
    // A worker that died leaves its row behind. Standing is being live, not
    // having once existed, or a crashed worker's last word would outlive it.
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);
    await asTheBrowserWorker();
    await query(
      "UPDATE workers SET last_seen_at = now() - interval '10 minutes' WHERE id = $1",
      [thisWorkerId()],
    );

    expect(() => canonical(readResult('NEEDS_SIGN_IN'), 'a profile', ctxFor(account))).toThrow(/sign/i);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await statusOf(account.id)).status).toBe('CONNECTED');
  });
});
