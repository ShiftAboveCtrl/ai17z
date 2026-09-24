import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, autonomy as autonomyRepo, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Restraint that only lasts until the next restart is not restraint.
 *
 * Every one of these lives in the database rather than in a process, and that
 * is the whole point of the file: a counter in memory resets when the worker
 * is upgraded, and an agent that forgets somebody asked it to stop because a
 * container was replaced has not honoured the request, it has waited it out.
 *
 * The budgets themselves are deliberately not stored. How many model calls an
 * agent made today is already in `model_calls`; how many approaches it
 * published is already in `actions`. Those survive a restart because the rows
 * do, and a second copy would be a number that drifts from the thing it is
 * supposed to describe.
 */

async function agent() {
  const fixture = await createFixture();
  return fixture.agentId;
}

/** Everything a process could be holding, gone. Only the database remains. */
const asIfRestarted = async () => {
  // Nothing to do but say so: these repositories hold no state of their own,
  // which is the property being relied on. The reads below go to Postgres.
};

describe('a session ledger that survives the worker', () => {
  it('remembers an open session across a restart', async () => {
    const agentId = await agent();
    const started = await autonomyRepo.startSession(agentId);
    expect(started.endedAt).toBeNull();

    await asIfRestarted();
    const found = await autonomyRepo.openSession(agentId);
    expect(found?.id).toBe(started.id);
  });

  it('never opens two sessions at once, whoever asks', async () => {
    // The unique partial index is the guard, not the check above it: two
    // workers deciding to start a session in the same moment is an ordinary
    // race and only the database can settle it.
    const agentId = await agent();
    const [a, b, c] = await Promise.all([
      autonomyRepo.startSession(agentId),
      autonomyRepo.startSession(agentId),
      autonomyRepo.startSession(agentId),
    ]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);

    const [row] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_growth_sessions WHERE agent_id = $1 AND ended_at IS NULL`,
      [agentId],
    );
    expect(Number(row!.n)).toBe(1);
  });

  it('keeps what a session spent, and counts it against the day', async () => {
    const agentId = await agent();
    await autonomyRepo.startSession(agentId);
    await autonomyRepo.chargeSession(agentId, 'model', 3);
    await autonomyRepo.chargeSession(agentId, 'research');
    await autonomyRepo.chargeSession(agentId, 'candidates', 2);
    await autonomyRepo.endSession(agentId, 'ran its time');

    const spent = await autonomyRepo.spentToday(agentId);
    expect(spent.modelCalls).toBe(3);
    expect(spent.researchCalls).toBe(1);

    // And a closed session still counts towards the day's allowance, which is
    // what stops an agent opening and closing sessions to reset its budget.
    expect(await autonomyRepo.sessionsToday(agentId)).toBe(1);
    expect(await autonomyRepo.lastSessionEndedAt(agentId)).not.toBeNull();
  });

  it('records a session that did nothing, because resting after one is the point', async () => {
    const agentId = await agent();
    await autonomyRepo.startSession(agentId);
    await autonomyRepo.endSession(agentId, 'nothing was worth looking at');

    expect(await autonomyRepo.sessionsToday(agentId)).toBe(1);
    expect(await autonomyRepo.openSession(agentId)).toBeNull();
  });

  it('charges nothing when no session is open, rather than failing', async () => {
    const agentId = await agent();
    await expect(autonomyRepo.chargeSession(agentId, 'model')).resolves.toBeUndefined();
    expect((await autonomyRepo.spentToday(agentId)).modelCalls).toBe(0);
  });
});

describe('somebody who asked to be left alone', () => {
  it('is still on the list after a restart', async () => {
    const agentId = await agent();
    await autonomyRepo.addDoNotContact({
      agentId,
      channel: 'x',
      handle: 'quiet_person',
      source: 'THEY_ASKED',
      evidence: 'please stop tagging me in these',
    });

    await asIfRestarted();
    const found = await autonomyRepo.findDoNotContact(agentId, 'x', 'quiet_person');
    expect(found).not.toBeNull();
    expect(found!.source).toBe('THEY_ASKED');
    // The evidence survives too. A record that somebody asked to be left alone
    // is worth nothing if nobody can see what they actually wrote.
    expect(found!.evidence).toMatch(/stop tagging me/);
  });

  it('matches however the handle is written', async () => {
    const agentId = await agent();
    await autonomyRepo.addDoNotContact({ agentId, channel: 'x', handle: '@Mixed_Case' });
    expect(await autonomyRepo.findDoNotContact(agentId, 'x', 'mixed_case')).not.toBeNull();
    expect(await autonomyRepo.findDoNotContact(agentId, 'x', '@MIXED_CASE')).not.toBeNull();
  });

  it('treats the same person asking twice as one fact', async () => {
    const agentId = await agent();
    const first = await autonomyRepo.addDoNotContact({ agentId, channel: 'x', handle: 'twice', evidence: 'stop' });
    const again = await autonomyRepo.addDoNotContact({ agentId, channel: 'x', handle: 'twice', evidence: 'STOP' });
    expect(again.id).toBe(first.id);
    // The earliest evidence is kept: it establishes when this started.
    expect(again.evidence).toBe('stop');
  });

  it('does not leak between agents', async () => {
    const one = await agent();
    const two = await agent();
    await autonomyRepo.addDoNotContact({ agentId: one, channel: 'x', handle: 'shared_handle' });
    expect(await autonomyRepo.findDoNotContact(one, 'x', 'shared_handle')).not.toBeNull();
    expect(await autonomyRepo.findDoNotContact(two, 'x', 'shared_handle')).toBeNull();
  });

  it('keeps the row when it is lifted, rather than deleting the history', async () => {
    /*
      "They asked us to stop in March and started a conversation themselves in
      June" is a thing an owner may need to see. A delete would leave the agent
      looking as though it had never been told.
    */
    const agentId = await agent();
    const entry = await autonomyRepo.addDoNotContact({ agentId, channel: 'x', handle: 'came_back' });
    await autonomyRepo.revokeDoNotContact(entry.id, 'they started a conversation themselves');

    expect(await autonomyRepo.findDoNotContact(agentId, 'x', 'came_back')).toBeNull();
    const withHistory = await autonomyRepo.listDoNotContact(agentId, true);
    expect(withHistory.map((r) => r.id)).toContain(entry.id);
    expect(withHistory.find((r) => r.id === entry.id)!.revokedReason).toMatch(/started a conversation/);
  });
});

describe('what the owner keeps deciding', () => {
  it('accumulates rather than overwriting, and survives a restart', async () => {
    const agentId = await agent();
    const key = { agentId, fingerprint: 'keyword_match:reply:stranger', family: 'keyword_match:reply' };
    await autonomyRepo.recordOwnerDecision({ ...key, accepted: false });
    await autonomyRepo.recordOwnerDecision({ ...key, accepted: false });
    await autonomyRepo.recordOwnerDecision({ ...key, accepted: true });

    await asIfRestarted();
    const signal = await autonomyRepo.getOwnerSignal(agentId, key.fingerprint);
    expect(signal!.rejected).toBe(2);
    expect(signal!.accepted).toBe(1);
    expect(signal!.lastRejectedAt).not.toBeNull();
  });

  it('lets a new person inherit what their family has learned', async () => {
    const agentId = await agent();
    await autonomyRepo.recordOwnerDecision({
      agentId,
      fingerprint: 'keyword_match:reply:alice',
      family: 'keyword_match:reply',
      accepted: false,
    });
    await autonomyRepo.recordOwnerDecision({
      agentId,
      fingerprint: 'keyword_match:reply:bob',
      family: 'keyword_match:reply',
      accepted: false,
    });

    const family = await autonomyRepo.familySignal(agentId, 'keyword_match:reply');
    expect(family.rejected).toBe(2);
    // A brand new fingerprint has nothing of its own, which is exactly when
    // the family is worth consulting.
    expect(await autonomyRepo.getOwnerSignal(agentId, 'keyword_match:reply:carol')).toBeNull();
  });
});

describe('account health', () => {
  it('is stored beside the sign-in status rather than inside it', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'mock',
      handle: `health_${uniqueSuffix()}`,
    });
    await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });

    // A new account is healthy until something says otherwise.
    expect((await autonomyRepo.getAccountHealth(account.id))!.health).toBe('HEALTHY');

    await autonomyRepo.setAccountHealth({
      accountId: account.id,
      health: 'COOLDOWN',
      reason: 'X asked this account to slow down 11 times in the last hour.',
      until: new Date(Date.now() + 60 * 60_000),
    });

    const after = (await autonomyRepo.getAccountHealth(account.id))!;
    expect(after.health).toBe('COOLDOWN');
    expect(after.healthReason).toMatch(/11 times/);
    expect(after.healthUntil).not.toBeNull();
    expect(after.healthChangedAt).not.toBeNull();

    // And the sign-in status is untouched, because they are different facts.
    expect((await accountsRepo.getAccount(account.id))!.status).toBe('CONNECTED');
  });

  it('only moves the changed-at when the state actually changes', async () => {
    // "Degraded for the last forty minutes" has to be answerable. Writing the
    // timestamp on every check would make every reading look like a new
    // problem.
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'mock',
      handle: `stable_${uniqueSuffix()}`,
    });

    await autonomyRepo.setAccountHealth({ accountId: account.id, health: 'DEGRADED', reason: 'first' });
    const first = (await autonomyRepo.getAccountHealth(account.id))!.healthChangedAt;
    await autonomyRepo.setAccountHealth({ accountId: account.id, health: 'DEGRADED', reason: 'still' });
    expect((await autonomyRepo.getAccountHealth(account.id))!.healthChangedAt).toBe(first);

    await autonomyRepo.setAccountHealth({ accountId: account.id, health: 'HEALTHY', reason: 'recovered' });
    expect((await autonomyRepo.getAccountHealth(account.id))!.healthChangedAt).not.toBe(first);
  });

  it('refuses a health nobody defined', async () => {
    // The CHECK constraint is the contract. Growing this enum without widening
    // it fails at the database and passes every unit test.
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'mock',
      handle: `bad_${uniqueSuffix()}`,
    });
    await expect(
      query('UPDATE accounts SET health = $2 WHERE id = $1', [account.id, 'SORT_OF_FINE']),
    ).rejects.toThrow();
  });
});
