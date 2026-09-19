import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, query } from '@xbam/database';
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

const statusOf = async (id: string) =>
  (await query<{ status: string; last_error: string | null }>('SELECT status, last_error FROM accounts WHERE id = $1', [id]))[0]!;

describe('a read that finds the session gone says so', () => {
  it('moves a connected account to SESSION_EXPIRED and keeps the reason', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture);

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
