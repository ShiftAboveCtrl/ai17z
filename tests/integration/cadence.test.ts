import { describe, expect, it } from 'vitest';
import { CadenceConfig, defaultCadence } from '@xbam/shared/contracts';
import { accounts, cadences } from '@xbam/database';
import { checkAccountCadence } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

async function connectedAccount(ownerId: string) {
  const suffix = uniqueSuffix();
  const account = await accounts.createAccount({
    ownerId,
    channel: 'x',
    handle: `cadence_${suffix}`,
    displayName: 'Cadence test',
  });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  return account;
}

describe('cadence configuration', () => {
  it('runs on defaults until someone edits it, and says so', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);

    expect(await cadences.activeCadence(account.id)).toEqual(defaultCadence());
    expect(await cadences.listVersions(account.id)).toHaveLength(0);
  });

  it('versions every change instead of overwriting', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);

    const first = await cadences.saveVersion(
      account.id,
      CadenceConfig.parse({ polling: { intervalSeconds: 300 } }),
      'slower',
      fixture.ownerId,
    );
    const second = await cadences.saveVersion(
      account.id,
      CadenceConfig.parse({ polling: { intervalSeconds: 60 } }),
      'faster again',
      fixture.ownerId,
    );

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    const versions = await cadences.listVersions(account.id);
    expect(versions.map((v) => v.changeNote)).toEqual(['faster again', 'slower']);
    // The old one is still readable, which is the point of versioning it.
    expect(versions[1]!.config.polling.intervalSeconds).toBe(300);
    expect((await cadences.activeCadence(account.id)).polling.intervalSeconds).toBe(60);
  });

  it('takes effect immediately rather than after the old interval elapses', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);
    await cadences.recordPoll(account.id, new Date(Date.now() + 3_600_000), false);
    expect(await cadences.claimDueAccounts(10, 60)).toHaveLength(0);

    await cadences.saveVersion(account.id, defaultCadence(), 'edited', fixture.ownerId);

    const due = await cadences.claimDueAccounts(10, 60);
    expect(due.map((d) => d.id)).toContain(account.id);
  });
});

describe('poll scheduling', () => {
  it('claims a due account once, so two workers cannot both poll it', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);

    const first = await cadences.claimDueAccounts(10, 120);
    const second = await cadences.claimDueAccounts(10, 120);

    expect(first.map((d) => d.id)).toContain(account.id);
    expect(second.map((d) => d.id)).not.toContain(account.id);
  });

  it('leaves disconnected and disabled accounts alone', async () => {
    const fixture = await createFixture();
    const connected = await connectedAccount(fixture.ownerId);
    const disabled = await connectedAccount(fixture.ownerId);
    const needsAuth = await connectedAccount(fixture.ownerId);
    await accounts.updateAccount(disabled.id, { enabled: false });
    await accounts.updateAccount(needsAuth.id, { status: 'NEEDS_AUTH' });

    const due = (await cadences.claimDueAccounts(20, 60)).map((d) => d.id);
    expect(due).toContain(connected.id);
    expect(due).not.toContain(disabled.id);
    expect(due).not.toContain(needsAuth.id);
  });

  it('counts empty polls and resets the streak when something arrives', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);

    await cadences.recordPoll(account.id, new Date(), false);
    await cadences.recordPoll(account.id, new Date(), false);
    expect((await cadences.pollState(account.id))!.emptyPollStreak).toBe(2);

    await cadences.recordPoll(account.id, new Date(), true);
    expect((await cadences.pollState(account.id))!.emptyPollStreak).toBe(0);
  });

  it('hands the cadence to the worker along with the account', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);
    await cadences.saveVersion(
      account.id,
      CadenceConfig.parse({ polling: { intervalSeconds: 900, batchLimit: 42 } }),
      '',
      fixture.ownerId,
    );

    const claimed = (await cadences.claimDueAccounts(10, 60)).find((d) => d.id === account.id);
    expect(claimed?.config.polling.batchLimit).toBe(42);
  });
});

describe('account ceilings', () => {
  it('allows an account with no ceilings of its own', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);
    expect(await checkAccountCadence(account.id, defaultCadence())).toEqual({ allow: true });
  });

  it('blocks during quiet hours and says when it will be back', async () => {
    const fixture = await createFixture();
    const account = await connectedAccount(fixture.ownerId);
    const config = CadenceConfig.parse({
      quietHours: { enabled: true, timezone: 'UTC', startHour: 8, endHour: 23 },
    });

    const verdict = await checkAccountCadence(account.id, config, new Date('2026-01-01T03:00:00Z'));
    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.boundBy).toBe('account');
    expect(verdict.reason).toBe('account_quiet_hours');
    expect(verdict.retryAfterMs).toBeGreaterThan(0);
  });
});
