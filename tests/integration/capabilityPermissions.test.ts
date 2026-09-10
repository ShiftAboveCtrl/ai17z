import { describe, expect, it } from 'vitest';
import { capabilityPermissions as permissionsRepo, ops, query } from '@xbam/database';
import { capabilityPermissions, capabilitySettings, registerXCapabilities, setCapabilityPermission } from '@xbam/runtime';
import { getCapability, resetCapabilitiesForTest } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * An owner's decision about a capability has to survive being written down.
 *
 * This is the test that did not exist, and its absence cost a release. The
 * permission was stored through `setAgentTool`, whose insert selects the tool
 * catalogue row by key -- and capability ids have never been in that catalogue,
 * so it selected nothing, inserted nothing, and returned as though it had
 * worked. Every permission an owner set was written nowhere.
 *
 * Reads default to allowed, so reads worked and the hole stayed invisible.
 * Writes default to disabled, so `x.like` and `x.repost` could not be switched
 * on from the interface at all: the screen said Allowed, the runtime said
 * "switched off for this agent", and nothing raised.
 *
 * Against real Postgres because the failure was a write that silently affected
 * no rows. A mock would have accepted it exactly as the database did.
 */
describe('an owner decision about a capability', () => {
  it('is still there when the runtime asks', async () => {
    // The whole bug in three lines.
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });

    const permissions = await capabilityPermissions(fixture.agentId);
    expect(permissions.get('x.like')).toBe('ALLOWED');
  });

  it('overrides the default in both directions', async () => {
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    // A read is allowed by default; switching it off has to stick too.
    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.read_post', permission: 'DISABLED' });
    await setCapabilityPermission({
      agentId: fixture.agentId,
      capabilityId: 'x.repost',
      permission: 'OWNER_APPROVAL',
    });

    const permissions = await capabilityPermissions(fixture.agentId);
    expect(permissions.get('x.read_post')).toBe('DISABLED');
    expect(permissions.get('x.repost')).toBe('OWNER_APPROVAL');
  });

  it('falls back to the capability default when nobody has decided', async () => {
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    const permissions = await capabilityPermissions(fixture.agentId);
    // Reads allowed, writes not. This is what makes a newly registered read
    // work without configuration and a newly registered write not.
    expect(permissions.get('x.read_post')).toBe('ALLOWED');
    expect(permissions.get('x.like')).toBe('DISABLED');
    expect(getCapability('x.like')!.effect).toBe('WRITE');
  });

  it('changes its mind without leaving two rows', async () => {
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });
    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'DISABLED' });

    const rows = await permissionsRepo.listForAgent(fixture.agentId);
    expect(rows.filter((row) => row.capability_id === 'x.like')).toHaveLength(1);
    expect((await capabilityPermissions(fixture.agentId)).get('x.like')).toBe('DISABLED');
  });

  it('refuses a capability nothing registers', async () => {
    // Recording a decision about something that will never be offered is how
    // an owner ends up believing they configured something.
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await expect(
      setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.not_a_capability', permission: 'ALLOWED' }),
    ).rejects.toThrow(/capability/i);
  });

  it('keeps one agent’s decision away from another’s', async () => {
    const a = await createFixture();
    const b = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await setCapabilityPermission({ agentId: a.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });

    expect((await capabilityPermissions(a.agentId)).get('x.like')).toBe('ALLOWED');
    expect((await capabilityPermissions(b.agentId)).get('x.like')).toBe('DISABLED');
  });
});

/**
 * The other half of the same defect.
 *
 * `setAgentTool` returned successfully having written nothing whenever the key
 * named no catalogue tool. That silence is what let the storage above be wrong
 * for an entire release, so it is now an error in its own right -- even though
 * capabilities no longer go through it.
 */
describe('turning on a tool that does not exist', () => {
  it('says so rather than appearing to work', async () => {
    const fixture = await createFixture();
    await expect(
      ops.setAgentTool({ agentId: fixture.agentId, toolKey: 'not.a.real.tool', enabled: true }),
    ).rejects.toThrow(/not\.a\.real\.tool/);
  });

  it('still turns on a tool that does', async () => {
    const fixture = await createFixture();
    const [tool] = await ops.listTools();
    expect(tool, 'the catalogue should have been seeded').toBeDefined();

    await ops.setAgentTool({ agentId: fixture.agentId, toolKey: tool!.key, enabled: true });
    const rows = await ops.listAgentTools(fixture.agentId);
    expect(rows.find((row) => row.key === tool!.key)?.enabled).toBe(true);
  });
});

/**
 * The other half of the same row: how a capability should behave, not whether.
 *
 * `CapabilityContext.config` has been in the contract since capabilities were,
 * described as coming from `agent_tools.config`. It never did. Capabilities
 * left `agent_tools` when they were given their own table, nothing wrote that
 * row before, and `stepGenerate` -- the only production caller of the loop --
 * passed permissions and never configs. So every capability was handed `{}`
 * however it was configured, and the sentence saying where it came from was
 * false in two ways at once.
 *
 * Against real Postgres because the storage is a jsonb column with a CHECK on
 * it, and the interesting cases are what the database will and will not accept.
 */
describe('how an owner has set a capability up', () => {
  it('survives being written down, and reaches the reader', async () => {
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await permissionsRepo.setConfig({
      agentId: fixture.agentId,
      capabilityId: 'x.search',
      permission: 'ALLOWED',
      config: { maxResults: 5, language: 'en' },
    });

    const settings = await capabilitySettings(fixture.agentId);
    expect(settings.configs.get('x.search')).toEqual({ maxResults: 5, language: 'en' });
    expect(settings.permissions.get('x.search')).toBe('ALLOWED');
  });

  it('carries nothing for a capability nobody has configured', async () => {
    // Absent rather than present-and-empty: the loop already answers a missing
    // entry with {}, and two ways of saying nothing is one too many.
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });

    const settings = await capabilitySettings(fixture.agentId);
    expect(settings.configs.has('x.like')).toBe(false);
    expect(settings.permissions.get('x.like')).toBe('ALLOWED');
  });

  it('keeps the decision and the settings out of each other’s way', async () => {
    // Turning a capability off and on again must not discard how it was set up,
    // and changing the settings must not quietly re-permit it.
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await permissionsRepo.setConfig({
      agentId: fixture.agentId,
      capabilityId: 'x.search',
      permission: 'ALLOWED',
      config: { maxResults: 5 },
    });
    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.search', permission: 'DISABLED' });
    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.search', permission: 'ALLOWED' });

    const settings = await capabilitySettings(fixture.agentId);
    expect(settings.configs.get('x.search')).toEqual({ maxResults: 5 });
    expect(settings.permissions.get('x.search')).toBe('ALLOWED');
  });

  it('replaces the settings rather than merging them, so a field can be cleared', async () => {
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await permissionsRepo.setConfig({
      agentId: fixture.agentId,
      capabilityId: 'x.search',
      permission: 'ALLOWED',
      config: { maxResults: 5, language: 'en' },
    });
    await permissionsRepo.setConfig({
      agentId: fixture.agentId,
      capabilityId: 'x.search',
      permission: 'ALLOWED',
      config: { maxResults: 9 },
    });

    expect((await capabilitySettings(fixture.agentId)).configs.get('x.search')).toEqual({ maxResults: 9 });
  });

  it('refuses anything that is not a bag of named settings', async () => {
    // Every reader treats this as Record<string, unknown>. A bare number or a
    // list would arrive as something no caller has a branch for, so the
    // database refuses it rather than the runtime hoping.
    const fixture = await createFixture();
    await expect(
      query(
        `INSERT INTO agent_capability_permissions (agent_id, capability_id, permission, config)
         VALUES ($1, 'x.search', 'ALLOWED', $2::jsonb)`,
        [fixture.agentId, JSON.stringify([1, 2, 3])],
      ),
    ).rejects.toThrow(/config_object/);
  });

  it('defaults to an empty object for a row written without one', async () => {
    const fixture = await createFixture();
    resetCapabilitiesForTest();
    registerXCapabilities();

    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'x.like', permission: 'ALLOWED' });
    const [row] = await permissionsRepo.listForAgent(fixture.agentId);
    expect(row!.config).toEqual({});
  });
});
