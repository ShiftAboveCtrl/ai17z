import { describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  browserTasks as browserTasksRepo,
  notifications as notificationsRepo,
} from '@xbam/database';
import { notificationKey, sweepNotifications } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Getting rid of an account somebody has finished with.
 *
 * The owner connected an X account, decided against it, and then could not
 * remove it. It stayed registered, went on failing its sign-in, and raised
 * "@handle is signed out" on every health sweep. Dismissing that answered the
 * notification rather than the state producing it, so it came back on the next
 * sweep, for ever.
 *
 * Both halves were real. `DELETE /api/accounts/:id` existed and **nothing in
 * the interface called it** -- no button anywhere reached either that route or
 * the unlink route beside it. And the health sweep read `status` alone, so even
 * switching an account off left it raising the warning.
 *
 * Against a real database rather than mocks, because what makes removal safe is
 * the foreign keys: every table referencing an account either cascades or nulls
 * the column, and that is a property of the schema, not of any code that could
 * be tested with a stub.
 */

async function signedOutAccount(ownerId: string) {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'x',
    handle: `gone${uniqueSuffix()}`.slice(0, 15),
    displayName: 'An account nobody wants',
  });
  await accountsRepo.updateAccount(account.id, {
    status: 'NEEDS_AUTH',
    lastHealthStatus: 'The stored session is no longer accepted.',
  });
  return account;
}

const signedOutFor = async (accountId: string) =>
  (await notificationsRepo.listOpen()).filter(
    (row) => row.dedupeKey === notificationKey.accountSignedOut(accountId),
  );

describe('an account the owner has finished with', () => {
  it('stops saying it is signed out once it is removed, and does not start again', async () => {
    const fixture = await createFixture();
    const account = await signedOutAccount(fixture.ownerId);

    // It complains, which is correct while the account is still registered.
    await sweepNotifications();
    expect(await signedOutFor(account.id), 'the warning never appeared to begin with').toHaveLength(1);

    await accountsRepo.deleteAccount(account.id);

    // Gone with the row: `owner_notifications.account_id` cascades, so this is
    // the schema clearing it rather than anything remembering to.
    expect(await signedOutFor(account.id)).toHaveLength(0);

    // And the sweep that used to re-raise it every cycle now has nothing to
    // raise it from. Run twice, because "it came back" was the whole
    // complaint and one quiet sweep does not prove a quiet minute.
    await sweepNotifications();
    await sweepNotifications();
    expect(await signedOutFor(account.id), 'the warning came back after removal').toHaveLength(0);
    expect(await accountsRepo.getAccount(account.id)).toBeNull();
  });

  it('stops saying it when the account is only disconnected, and says it again if it comes back', async () => {
    // Disconnect is the reversible half, and it has to be just as quiet:
    // somebody who switched an account off did so to stop hearing about it.
    const fixture = await createFixture();
    const account = await signedOutAccount(fixture.ownerId);
    await sweepNotifications();
    expect(await signedOutFor(account.id)).toHaveLength(1);

    await accountsRepo.disconnectAccount(account.id);
    await sweepNotifications();
    expect(await signedOutFor(account.id), 'a disconnected account still complains').toHaveLength(0);

    const off = await accountsRepo.getAccount(account.id);
    expect(off?.enabled).toBe(false);
    expect(off?.status).toBe('DISCONNECTED');

    // Switched back on and failing again, it is news once more -- the sweep
    // reports current state rather than remembering a decision.
    await accountsRepo.reconnectAccount(account.id);
    await accountsRepo.updateAccount(account.id, { status: 'NEEDS_AUTH' });
    await sweepNotifications();
    expect(await signedOutFor(account.id), 'a reconnected account went quiet').toHaveLength(1);
  });

  it('takes its queued browser work with it', async () => {
    // A task left in the queue opens a window for an account the owner has just
    // removed, which is the most visible way this could go wrong.
    const fixture = await createFixture();
    const account = await signedOutAccount(fixture.ownerId);
    await browserTasksRepo.enqueueBrowserTask({
      accountId: account.id,
      kind: 'OPEN_AUTH',
      requestedBy: fixture.ownerId,
      params: {},
    });
    expect(await browserTasksRepo.listBrowserTasks(account.id)).not.toHaveLength(0);

    await accountsRepo.deleteAccount(account.id);
    expect(await browserTasksRepo.listBrowserTasks(account.id)).toHaveLength(0);
  });

  it('leaves the sign-in watcher nothing to watch', async () => {
    // The watcher claims accounts by status. A disconnected one must drop out
    // of that list, or it goes on driving a browser for an account nobody
    // wants -- and on writing that account's status back afterwards.
    const fixture = await createFixture();
    const account = await signedOutAccount(fixture.ownerId);
    await accountsRepo.updateAccount(account.id, { status: 'AWAITING_LOGIN' });

    const waiting = async () =>
      (await accountsRepo.accountsAwaitingSignIn()).some((row) => row.id === account.id);
    expect(await waiting(), 'it was never in the watcher list').toBe(true);

    await accountsRepo.disconnectAccount(account.id);
    expect(await waiting(), 'a disconnected account is still watched').toBe(false);
  });

  it('can be removed twice without leaving anything half-done', async () => {
    const fixture = await createFixture();
    const account = await signedOutAccount(fixture.ownerId);
    await accountsRepo.deleteAccount(account.id);
    await accountsRepo.deleteAccount(account.id);
    expect(await accountsRepo.getAccount(account.id)).toBeNull();
  });

  it('does not take the agent with it', async () => {
    // The first thing anybody wonders before pressing it. An account is
    // separate from an agent on purpose -- one agent can have several, and an
    // account can move between them -- so removing one must leave the agent
    // exactly where it was.
    const fixture = await createFixture();
    const account = await signedOutAccount(fixture.ownerId);
    await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id });
    expect(await accountsRepo.listAgentAccounts(fixture.agentId)).toHaveLength(1);

    await accountsRepo.deleteAccount(account.id);

    expect(await accountsRepo.listAgentAccounts(fixture.agentId)).toHaveLength(0);
    const { agents } = await import('@xbam/database');
    expect(await agents.getAgent(fixture.agentId), 'removing an account deleted the agent').not.toBeNull();
  });
});
