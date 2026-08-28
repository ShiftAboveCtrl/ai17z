import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUSES_IN_PROGRESS,
  ACCOUNT_STATUSES_NEEDING_PERSON,
  ACCOUNT_STATUSES_WATCHABLE,
} from '@xbam/shared/contracts';
import { accounts as accountsRepo } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function account(ownerId: string, status: (typeof ACCOUNT_STATUSES)[number]) {
  const created = await accountsRepo.createAccount({
    ownerId,
    channel: 'x',
    handle: `states_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(created.id, { status });
  return created;
}

/**
 * The watcher must not look at a browser the sign-in task is still setting up.
 *
 * This reproduces a real failure. `OPEN_AUTH` sets `STARTING_BROWSER` before it
 * launches Chrome, because a cold profile takes long enough that saying nothing
 * looks broken. The watcher polled that state too, leased the same context while
 * `page.goto` was still running, and Playwright threw — as it does when a
 * navigation destroys the execution context mid-call. The watcher read the throw
 * as `UNREACHABLE` and declared the window closed 0.6 seconds after opening it,
 * leaving the account at NEEDS_AUTH with "the sign-in window was closed before
 * it finished" while a perfectly good Chrome window sat on the screen.
 *
 * The fix is a smaller set of states: only the ones the task has finished with.
 */
describe('the sign-in watcher only looks at settled states', () => {
  it('ignores an account whose browser is still being launched', async () => {
    const fixture = await createFixture();
    const starting = await account(fixture.ownerId, 'STARTING_BROWSER');
    const ready = await account(fixture.ownerId, 'BROWSER_READY');

    const watched = (await accountsRepo.accountsAwaitingSignIn()).map((a) => a.id);
    expect(watched).not.toContain(starting.id);
    expect(watched).not.toContain(ready.id);
  });

  it('watches an account once the task has handed the window over', async () => {
    const fixture = await createFixture();
    const awaiting = await account(fixture.ownerId, 'AWAITING_LOGIN');
    const authenticating = await account(fixture.ownerId, 'AUTHENTICATING');

    const watched = (await accountsRepo.accountsAwaitingSignIn()).map((a) => a.id);
    expect(watched).toContain(awaiting.id);
    expect(watched).toContain(authenticating.id);
  });

  it('stops looking once a person has been asked for something', async () => {
    const fixture = await createFixture();
    const challenged = await account(fixture.ownerId, 'CHALLENGE_REQUIRES_USER');
    // Continuing to read the page somebody is typing a code into is the thing
    // this must never do.
    expect((await accountsRepo.accountsAwaitingSignIn()).map((a) => a.id)).not.toContain(challenged.id);
  });

  it('leaves settled accounts alone', async () => {
    const fixture = await createFixture();
    for (const status of ['CONNECTED', 'NEEDS_AUTH', 'TIMEOUT', 'ERROR', 'DISCONNECTED'] as const) {
      const row = await account(fixture.ownerId, status);
      expect((await accountsRepo.accountsAwaitingSignIn()).map((a) => a.id)).not.toContain(row.id);
    }
  });
});

describe('the state vocabulary agrees with itself', () => {
  it('watches only states that are also in progress', () => {
    for (const status of ACCOUNT_STATUSES_WATCHABLE) {
      expect(ACCOUNT_STATUSES_IN_PROGRESS).toContain(status);
    }
  });

  it('never watches a state that is waiting on a person', () => {
    for (const status of ACCOUNT_STATUSES_NEEDING_PERSON) {
      expect(ACCOUNT_STATUSES_WATCHABLE).not.toContain(status);
    }
  });

  it('leaves the launch states to the task that owns them', () => {
    // Both are in progress, and neither is watchable: the OPEN_AUTH task holds
    // the browser through them and the watcher would be racing it.
    expect(ACCOUNT_STATUSES_IN_PROGRESS).toContain('STARTING_BROWSER');
    expect(ACCOUNT_STATUSES_IN_PROGRESS).toContain('BROWSER_READY');
    expect(ACCOUNT_STATUSES_WATCHABLE).not.toContain('STARTING_BROWSER');
    expect(ACCOUNT_STATUSES_WATCHABLE).not.toContain('BROWSER_READY');
  });

  it('every watchable state is a real state', () => {
    for (const status of ACCOUNT_STATUSES_WATCHABLE) {
      expect(ACCOUNT_STATUSES).toContain(status);
    }
  });
});
