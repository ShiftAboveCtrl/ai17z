import { describe, expect, it } from 'vitest';
import { capabilityPermissions as permissionsRepo, ops } from '@xbam/database';
import { capabilityPermissions, registerXCapabilities, setCapabilityPermission } from '@xbam/runtime';
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
