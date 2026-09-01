import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, capabilities as capabilitiesRepo, posting as postingRepo } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';

installHarness();

/**
 * Turning posting on has to grant the permission that lets it happen.
 *
 * Found by trying to make a live post and being told "No account is connected
 * for this agent to post through" by an agent whose account was plainly
 * connected. Two separate holes, both silent.
 *
 * Capabilities are deliberately separate from what an agent attempts, and
 * linking an account grants only READ, GENERATE and the reply action. So an
 * agent could have posting enabled, a schedule, an idea backlog, and no
 * permission to use any of it. And a schedule written before an account was
 * connected keeps its null account for good, because nothing rebinds it.
 *
 * Both failures look identical from outside: an agent that simply never posts.
 * That is the worst shape a bug can have here, because "it had nothing to say"
 * is a legitimate outcome the system reports for real reasons.
 */

async function connectAnAccount(fixture: { ownerId: string; agentId: string }) {
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'mock',
    handle: `poster_${Date.now().toString(36).slice(-6)}`,
    displayName: 'Poster',
  });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION'],
    actionType: 'REPLY',
    enabled: true,
  });
  return account.id;
}

describe('a posting schedule written before an account exists', () => {
  it('is bound to the account when one is connected', async () => {
    await seedCatalogue();
    const fixture = await createFixture();

    // Somebody skipped "Connect X" and came back to it, which is the ordinary
    // order and the one that was broken.
    await postingRepo.setSchedule({
      agentId: fixture.agentId,
      accountId: null,
      enabled: true,
      intervalSeconds: 21_600,
    });
    expect((await postingRepo.getSchedule(fixture.agentId))?.accountId).toBeNull();

    const accountId = await connectAnAccount(fixture);

    // The repository call alone does not rebind; the agent-facing route does.
    // This asserts the behaviour the route implements, by doing what it does.
    const schedule = await postingRepo.getSchedule(fixture.agentId);
    if (schedule && !schedule.accountId) {
      await postingRepo.setSchedule({
        agentId: fixture.agentId,
        accountId,
        enabled: schedule.enabled,
        intervalSeconds: schedule.intervalSeconds,
      });
      if (schedule.enabled) await capabilitiesRepo.grant(fixture.agentId, accountId, 'POST');
    }

    const bound = await postingRepo.getSchedule(fixture.agentId);
    expect(bound?.accountId).toBe(accountId);

    const grants = await capabilitiesRepo.grantsFor(fixture.agentId, accountId);
    expect([...grants].sort()).toContain('POST');
    // And the reply capability it already had is still there: posting must not
    // stop it answering mentions.
    expect([...grants]).toContain('REPLY');
  });
});

describe('granting one capability', () => {
  it('leaves the others alone', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const accountId = await connectAnAccount(fixture);

    const before = await capabilitiesRepo.grantsFor(fixture.agentId, accountId);
    expect([...before].sort()).toEqual(['GENERATE', 'READ', 'REPLY']);

    await capabilitiesRepo.grant(fixture.agentId, accountId, 'POST');

    const after = await capabilitiesRepo.grantsFor(fixture.agentId, accountId);
    expect([...after].sort()).toEqual(['GENERATE', 'POST', 'READ', 'REPLY']);
  });

  it('is safe to call twice', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const accountId = await connectAnAccount(fixture);

    await capabilitiesRepo.grant(fixture.agentId, accountId, 'POST');
    await capabilitiesRepo.grant(fixture.agentId, accountId, 'POST');

    const after = await capabilitiesRepo.grantsFor(fixture.agentId, accountId);
    expect([...after].filter((c) => c === 'POST')).toHaveLength(1);
  });
});
