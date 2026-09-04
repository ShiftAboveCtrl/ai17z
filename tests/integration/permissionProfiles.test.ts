import { describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  ops,
  query,
} from '@xbam/database';
import { PolicyConfig } from '@xbam/shared/contracts';
import { applyProfile, currentProfile, describeProfile, profileOf } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/** The owner turns market lookups off. One setting, changed on purpose. */
async function turnOffMarketLookups(agentId: string): Promise<void> {
  const current = await agentsRepo.getActivePolicy(agentId);
  const config = PolicyConfig.parse(current?.config ?? {});
  await agentsRepo.savePolicyVersion(
    agentId,
    { ...config, tools: { ...config.tools, research: { ...config.tools.research, market: false } } },
    'turned market lookups off',
    null,
  );
}

async function linkedAccount(ownerId: string, agentId: string): Promise<string> {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'x',
    handle: `acct${uniqueSuffix()}`.slice(0, 15),
    displayName: 'Test account',
  });
  await accountsRepo.linkAgentAccount({ agentId, accountId: account.id });
  return account.id;
}

describe('saying what an agent may do in one word', () => {
  it('grants exactly what the name says', async () => {
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);

    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'REPLIES_ONLY' });
    const held = await capabilitiesRepo.grantsFor(fixture.agentId, accountId);
    expect([...held].sort()).toEqual(['GENERATE', 'READ', 'REPLY']);
  });

  it('takes permission away as readily as it gives it', async () => {
    // A narrower profile that only ever added would be a label with nothing
    // behind it.
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);

    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'EVERYTHING' });
    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'REPLIES_ONLY' });

    const held = await capabilitiesRepo.grantsFor(fixture.agentId, accountId);
    expect(held.has('POST')).toBe(false);
    expect(held.has('LIKE')).toBe(false);
  });

  it('reads back as the profile it was set to', async () => {
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);
    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'REPLIES_AND_POSTS' });
    expect(await currentProfile(fixture.agentId, accountId)).toBe('REPLIES_AND_POSTS');
  });

  it('calls a hand-edited set custom rather than mislabelling it', async () => {
    // Derived rather than stored, so a grant edited one at a time cannot leave
    // the screen claiming a profile it no longer matches.
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);
    await capabilitiesRepo.setGrants(fixture.agentId, accountId, ['READ', 'GENERATE', 'LIKE'], null);
    expect(await currentProfile(fixture.agentId, accountId)).toBe('CUSTOM');
  });

  it('does not call a superset of a profile that profile', async () => {
    expect(profileOf(['READ', 'GENERATE', 'REPLY', 'LIKE'])).toBe('CUSTOM');
  });

  it('leaves an agent with no permissions at all as custom, not as watch only', async () => {
    // Watch only can still draft. Nothing at all is a different situation and
    // must not wear a name that suggests it is working.
    expect(profileOf([])).toBe('CUSTOM');
  });
});

/**
 * The regression this feature exists to avoid.
 *
 * The natural implementation of a permission profile -- a bundle of settings
 * applied wholesale -- carries defaults for things it does not name, and every
 * switch quietly restores them. An owner who disabled market lookups because
 * the agent kept quoting prices at people, and then let it post, would find it
 * quoting prices at people again. They changed one thing.
 */
describe('switching a profile leaves everything it does not name alone', () => {
  it('does not re-enable market lookups the owner turned off', async () => {
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);

    // The owner turns market lookups off, deliberately, because the agent kept
    // quoting prices at people.
    await turnOffMarketLookups(fixture.agentId);
    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'REPLIES_ONLY' });

    // And then lets it post. That is the only thing they changed.
    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'REPLIES_AND_POSTS' });

    const policy = await agentsRepo.getActivePolicy(fixture.agentId);
    expect(PolicyConfig.parse(policy!.config).tools.research.market).toBe(false);
  });

  it('does not re-enable them going the other way either', async () => {
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);
    await turnOffMarketLookups(fixture.agentId);

    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'EVERYTHING' });
    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'MONITOR_ONLY' });

    const policy = await agentsRepo.getActivePolicy(fixture.agentId);
    expect(PolicyConfig.parse(policy!.config).tools.research.market).toBe(false);
  });

  it('does not re-enable a tool the owner turned off', async () => {
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);
    await ops.setAgentTool({ agentId: fixture.agentId, toolKey: 'http.fetch', enabled: false });

    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'REPLIES_ONLY' });
    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'REPLIES_AND_POSTS' });

    const tools = await ops.listAgentTools(fixture.agentId);
    expect(tools.find((tool: { key: string }) => tool.key === 'http.fetch')?.enabled).toBe(false);
  });

  it('does not widen which events trigger the agent', async () => {
    // Widening what an agent is triggered by changes what happens next. A
    // permission switch is not the place for that decision.
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);
    await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId, triggerEventTypes: ['MENTION'] });

    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'EVERYTHING' });

    const [row] = await query<{ trigger_event_types: string[] }>(
      'SELECT trigger_event_types FROM agent_accounts WHERE agent_id = $1 AND account_id = $2',
      [fixture.agentId, accountId],
    );
    expect(row!.trigger_event_types).toEqual(['MENTION']);
  });

  it('does not change whether replies are held for review', async () => {
    // Set away from the default first. Comparing two default policies proves
    // nothing: identical content is deduplicated, so even an implementation
    // that rewrites the whole document would pass.
    const fixture = await createFixture();
    const accountId = await linkedAccount(fixture.ownerId, fixture.agentId);
    const current = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    await agentsRepo.savePolicyVersion(
      fixture.agentId,
      { ...current, automation: { ...current.automation, mode: 'AUTONOMOUS', dryRunDefault: false } },
      'let it act by itself',
      null,
    );

    await applyProfile({ agentId: fixture.agentId, accountId, profile: 'EVERYTHING' });

    const after = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))!.config);
    expect(after.automation.mode).toBe('AUTONOMOUS');
    expect(after.automation.dryRunDefault).toBe(false);
  });

  it('does not touch another account linked to the same agent', async () => {
    const fixture = await createFixture();
    const one = await linkedAccount(fixture.ownerId, fixture.agentId);
    const two = await linkedAccount(fixture.ownerId, fixture.agentId);

    await applyProfile({ agentId: fixture.agentId, accountId: one, profile: 'EVERYTHING' });
    await applyProfile({ agentId: fixture.agentId, accountId: two, profile: 'MONITOR_ONLY' });

    expect(await currentProfile(fixture.agentId, one)).toBe('EVERYTHING');
    expect(await currentProfile(fixture.agentId, two)).toBe('MONITOR_ONLY');
  });

  it('does not touch another agent on the same account', async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `sh${uniqueSuffix()}`.slice(0, 15),
      displayName: 'Shared',
    });
    await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id });
    await accountsRepo.linkAgentAccount({ agentId: other.agentId, accountId: account.id });

    await applyProfile({ agentId: fixture.agentId, accountId: account.id, profile: 'EVERYTHING' });
    await applyProfile({ agentId: other.agentId, accountId: account.id, profile: 'MONITOR_ONLY' });

    expect(await currentProfile(fixture.agentId, account.id)).toBe('EVERYTHING');
  });
});

describe('before the button is pressed', () => {
  it('says what each choice will and will not change', () => {
    for (const name of ['MONITOR_ONLY', 'REPLIES_ONLY', 'REPLIES_AND_POSTS', 'EVERYTHING'] as const) {
      const described = describeProfile(name);
      expect(described.summary.length).toBeGreaterThan(0);
      expect(described.grants.length).toBeGreaterThan(0);
      // Every profile says it leaves tools alone, because that is the promise
      // the tests above enforce.
      expect(described.leaves.join(' ')).toContain('tools');
      expect(described.leaves.join(' ')).toContain('review');
    }
  });

  it('says watch only sends nothing, in those words', () => {
    expect(describeProfile('MONITOR_ONLY').summary).toContain('Sends nothing');
    expect(describeProfile('MONITOR_ONLY').grants).toContain('No replies');
  });
});
