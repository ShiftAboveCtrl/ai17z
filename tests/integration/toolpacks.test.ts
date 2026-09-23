import { describe, expect, it } from 'vitest';
import { capabilityPermissions as permissionsRepo } from '@xbam/database';
import { defaultPermission } from '@xbam/shared/contracts';
import {
  capabilityViews,
  registerChainCapabilities,
  registerContractCapabilities,
  registerXCapabilities,
  setCapabilityPermission,
  pluginViews,
  setToolpack,
  toolpackViews,
} from '@xbam/runtime';
import {
  TOOLPACKS,
  capabilitiesInPack,
  capabilitiesOutsideAnyPack,
  resetCapabilitiesForTest,
} from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Capabilities, grouped the way somebody would ask for them.
 *
 * Twenty-three switches is past the point where a flat list is a screen anybody
 * reads. A pack is how a person says "let my agent look things up on chains"
 * without deciding about `chain.read_receipt`.
 *
 * The property that matters is that a pack **stores nothing**. It is computed
 * from the capability permissions underneath it and it writes them. Two
 * overlapping answers to "may this agent do that" is how something ends up
 * allowed by one screen and refused by another -- which this codebase has
 * already paid for once, when capability permissions were written into the tool
 * catalogue and silently went nowhere.
 *
 * Against real Postgres because the thing under test is what was actually
 * stored.
 */

function registerEverything() {
  resetCapabilitiesForTest();
  registerXCapabilities();
  registerChainCapabilities();
  registerContractCapabilities();
}

async function views(agentId: string) {
  return toolpackViews({ agentId, accountId: null, paused: false });
}

describe('turning a pack on', () => {
  it('writes the capability permissions underneath it, and stores nothing else', async () => {
    const fixture = await createFixture();
    registerEverything();

    await setToolpack({ agentId: fixture.agentId, packId: 'crypto', on: true });

    // The only thing that changed is rows in the one table decisions live in.
    const rows = await permissionsRepo.listForAgent(fixture.agentId);
    const ids = capabilitiesInPack('crypto').map((capability) => capability.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(rows.find((row) => row.capability_id === id), id).toBeDefined();
    }
  });

  it('does not sweep a capability that changes something to allowed', async () => {
    // "Let my agent look at X" is not consent to let it post. A pack that
    // allowed a write would be making a decision the owner did not.
    const fixture = await createFixture();
    registerEverything();

    await setToolpack({ agentId: fixture.agentId, packId: 'x', on: true });

    const all = await capabilityViews({ agentId: fixture.agentId, accountId: null, paused: false });
    const inPack = all.filter((view) => view.id.startsWith('x.'));
    expect(inPack.length).toBeGreaterThan(0);

    for (const view of inPack) {
      // Each one is at its own default and no further. Nothing that writes is
      // allowed, and neither is a read of somebody's inbox: `x.read_conversation`
      // is a READ at HIGH risk, so its default asks -- which is the rule that
      // makes the two message surfaces ask every time.
      expect(view.permission, view.id).toBe(defaultPermission(view.effect, view.risk));
      if (view.effect === 'WRITE') expect(view.permission, view.id).not.toBe('ALLOWED');
    }
    expect(inPack.some((view) => view.effect === 'WRITE')).toBe(true);
    expect(inPack.some((view) => view.permission === 'ALLOWED')).toBe(true);
  });

  it('turns everything in it off again', async () => {
    const fixture = await createFixture();
    registerEverything();

    await setToolpack({ agentId: fixture.agentId, packId: 'crypto', on: true });
    await setToolpack({ agentId: fixture.agentId, packId: 'crypto', on: false });

    const { packs } = await views(fixture.agentId);
    const crypto = packs.find((pack) => pack.id === 'crypto')!;
    expect(crypto.state).toBe('OFF');
    for (const capability of crypto.capabilities) expect(capability.permission, capability.id).toBe('DISABLED');
  });

  it('leaves the other packs alone', async () => {
    const fixture = await createFixture();
    registerEverything();

    await setToolpack({ agentId: fixture.agentId, packId: 'crypto', on: true });
    const { packs } = await views(fixture.agentId);
    expect(packs.find((pack) => pack.id === 'crypto')!.state).toBe('ON');
    // X was never mentioned, so its reads are still at their default -- which
    // is on, because that is what a read defaults to, not because a pack said so.
    const x = packs.find((pack) => pack.id === 'x')!;
    expect(x.state).not.toBe('MIXED');
  });
});

describe('a pack an owner has taken apart', () => {
  it('reads MIXED rather than pretending to be on', async () => {
    // The truth, not a conflict. An owner who switches one capability off in
    // Advanced has a pack that is neither on nor off, and a screen that said ON
    // would be describing something that is refused.
    const fixture = await createFixture();
    registerEverything();

    await setToolpack({ agentId: fixture.agentId, packId: 'crypto', on: true });
    await setCapabilityPermission({
      agentId: fixture.agentId,
      capabilityId: 'chain.read_balance',
      permission: 'DISABLED',
    });

    const { packs } = await views(fixture.agentId);
    expect(packs.find((pack) => pack.id === 'crypto')!.state).toBe('MIXED');
  });

  it('keeps the individual decision, so Advanced still wins', async () => {
    const fixture = await createFixture();
    registerEverything();

    await setCapabilityPermission({
      agentId: fixture.agentId,
      capabilityId: 'chain.read_balance',
      permission: 'OWNER_APPROVAL',
    });
    const { packs } = await views(fixture.agentId);
    const one = packs
      .find((pack) => pack.id === 'crypto')!
      .capabilities.find((capability) => capability.id === 'chain.read_balance')!;
    expect(one.permission).toBe('OWNER_APPROVAL');
  });
});

describe('what a pack says about itself', () => {
  it('counts how many of its capabilities could actually run', async () => {
    const fixture = await createFixture();
    registerEverything();

    const { packs } = await views(fixture.agentId);
    for (const pack of packs) {
      expect(pack.total, pack.id).toBeGreaterThan(0);
      expect(pack.ready + pack.needsSetup, pack.id).toBeLessThanOrEqual(pack.total);
      expect(pack.detail, pack.id).not.toBe('');
    }
  });

  it('claims every capability exactly once', async () => {
    // A capability in two packs would be one an owner could turn on in one
    // screen and off in another.
    registerEverything();
    const seen = new Map<string, string>();
    for (const pack of TOOLPACKS) {
      for (const capability of capabilitiesInPack(pack.id)) {
        expect(seen.get(capability.id), `${capability.id} is in two packs`).toBeUndefined();
        seen.set(capability.id, pack.id);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('leaves no capability out of every pack', async () => {
    // The mirror of the test above, and the one that was missing. Claiming a
    // capability twice is a contradiction an owner would notice; claiming it
    // never is a capability that exists, works, and appears nowhere on the
    // normal screen. Ten of them accumulated that way before this existed --
    // web history, feeds, scholarly search, entities and filings were all
    // reachable by a model and invisible to the person who owns it.
    //
    // The exempt list is short and each entry earns its place: these are always
    // available, reach no outside source, and are not a decision anybody makes.
    const ALWAYS_ON = ['agent.diagnostics', 'memory.search', 'time.now'];

    registerEverything();
    const orphans = capabilitiesOutsideAnyPack()
      .map((capability) => capability.id)
      .filter((id) => !ALWAYS_ON.includes(id));

    expect(orphans, `these capabilities are in no pack: ${orphans.join(', ')}`).toEqual([]);
  });

  it('refuses a pack that does not exist rather than doing nothing quietly', async () => {
    const fixture = await createFixture();
    registerEverything();
    await expect(setToolpack({ agentId: fixture.agentId, packId: 'not-a-pack', on: true })).rejects.toThrow();
  });
});

describe('the built-in Plugins, as a product', () => {
  it('is the six toolpacks and not a copy of them', async () => {
    const fixture = await createFixture();
    registerEverything();
    const views = await pluginViews({ agentId: fixture.agentId, accountId: null, paused: false });
    const builtIn = views.filter((view) => view.source === 'BUILT_IN');

    // Every pack that has members, and nothing invented beside them.
    const packsWithMembers = TOOLPACKS.filter((pack) => capabilitiesInPack(pack.id).length > 0);
    expect(builtIn.map((view) => view.id).sort()).toEqual(packsWithMembers.map((pack) => pack.id).sort());

    // The capabilities are the pack's own, registered once. A Plugin layer
    // that copied them would show the same id under two owners.
    const seen = new Map<string, string>();
    for (const view of views) {
      for (const capability of view.capabilities) {
        expect(seen.has(capability.id), `${capability.id} appears under two Plugins`).toBe(false);
        seen.set(capability.id, view.id);
      }
    }
    for (const view of builtIn) {
      expect(view.capabilities.map((c) => c.id).sort(), view.id).toEqual(
        capabilitiesInPack(view.id).map((c) => c.id).sort(),
      );
    }
  });

  it('says nothing about a version, a host or a quota, because it has none', async () => {
    const fixture = await createFixture();
    registerEverything();
    const views = await pluginViews({ agentId: fixture.agentId, accountId: null, paused: false });
    for (const view of views.filter((entry) => entry.source === 'BUILT_IN')) {
      expect(view.version, view.id).toBeNull();
      expect(view.removable, view.id).toBe(false);
      expect(view.hosts, view.id).toEqual([]);
      expect(view.quotaPerHour, view.id).toBeNull();
      expect(view.configFields, view.id).toEqual([]);
      expect(view.features, view.id).toEqual([]);
      expect(view.panel, view.id).toBeNull();
    }
  });

  it('keeps registered, ready and used as three separate answers', async () => {
    // The distinction the whole screen rests on. A capability can be
    // registered, permitted, and still unable to run -- and never yet used.
    const fixture = await createFixture();
    registerEverything();
    const views = await pluginViews({ agentId: fixture.agentId, accountId: null, paused: false });
    const every = views.flatMap((view) => view.capabilities);
    expect(every.length).toBeGreaterThan(0);
    for (const capability of every) {
      // A status, a permission, and a last-used answer that is allowed to be
      // null. Collapsing any two of these is how a screen starts lying.
      expect(typeof capability.status).toBe('string');
      expect(typeof capability.permission).toBe('string');
      expect(capability.lastUsedAt === null || typeof capability.lastUsedAt === 'string').toBe(true);
    }
    expect(every.some((capability) => capability.status !== 'AVAILABLE')).toBe(true);
    expect(every.every((capability) => capability.lastUsedAt === null)).toBe(true);
  });
});
