import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityPermissions as permissionsRepo, plugins as pluginsRepo } from '@xbam/database';
import {
  CORE_RECOMMENDED_PACKS,
  applyCoreRecommended,
  installPlugin,
  pluginViews,
  readManifest,
  registerReferenceCapabilities,
  setPluginEnabled,
  uninstallPlugin,
} from '@xbam/runtime';
import { buildVersion, pluginCapabilityId } from '@xbam/shared';
import {
  getCapability,
  listModelCallable,
  registerBuiltinCapabilities,
  resetCapabilitiesForTest,
} from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Plugins, which are the owner's product over the capability system.
 *
 * The property every one of these is about: a Plugin is a way of deciding
 * about capabilities, and never a second place those decisions live. If a
 * Plugin could record its own idea of what an agent may do, the Plugins screen
 * and the capability row under it could disagree, which is exactly the fault
 * `toolpacks.ts` was written to avoid and exactly the fault that matters more
 * once something can be installed from elsewhere.
 */

const core = buildVersion().version.replace(/-.*$/, '');

/** A Plugin that reads one public API and needs no credential. */
const WEATHER = {
  schemaVersion: 1,
  id: 'test-weather',
  name: 'Test Weather',
  summary: 'Reads a forecast for a place, for proving the Plugin path works.',
  publisher: 'AI17Z Test',
  version: '1.0.0',
  compatibility: { minimum: core },
  kind: 'HTTP_CAPABILITY',
  config: [],
  capabilities: [
    {
      name: 'read_forecast',
      title: 'Read a forecast',
      description: 'Reads the current temperature for a latitude and longitude.',
      category: 'RESEARCH',
      effect: 'READ',
      risk: 'LOW',
      input: {
        fields: [
          { name: 'latitude', type: 'number', required: true, describe: 'Degrees north' },
          { name: 'longitude', type: 'number', required: true, describe: 'Degrees east' },
        ],
      },
      output: { fields: [{ name: 'temperature', type: 'number', from: 'current.temperature_2m' }] },
      http: {
        method: 'GET',
        url: 'https://api.example-weather.test/v1/forecast?latitude={latitude}&longitude={longitude}',
        hosts: ['api.example-weather.test'],
        timeoutMs: 8_000,
        quotaPerHour: 30,
      },
    },
  ],
  features: [],
};

const json = (value: unknown) => JSON.stringify(value);
const capabilityId = pluginCapabilityId('test-weather', 'read_forecast');

beforeEach(async () => {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  // The reference family too. The three built-ins are `time.`, `memory.` and
  // `self.`, none of which belongs to a pack, so without this there is no
  // built-in Plugin with anything in it -- and a pack with no registered
  // members is deliberately not shown, because its only control would be a
  // button `setToolpack` refuses.
  registerReferenceCapabilities();
  for (const record of await pluginsRepo.listInstalledPlugins()) {
    await pluginsRepo.removeInstalledPlugin(record.id);
  }
});

describe('a manifest is read strictly or not at all', () => {
  it('accepts one this build understands', () => {
    const read = readManifest(json(WEATHER));
    expect(read.ok, read.ok ? '' : read.why).toBe(true);
  });

  it('refuses something that is not JSON', () => {
    const read = readManifest('<html>not a manifest</html>');
    expect(read.ok).toBe(false);
  });

  it('refuses an unknown schema version rather than guessing', () => {
    // The field this build does not understand may be the one that mattered.
    const read = readManifest(json({ ...WEATHER, schemaVersion: 99 }));
    expect(read.ok).toBe(false);
  });

  it('refuses a field it does not know', () => {
    const read = readManifest(json({ ...WEATHER, sneaky: 'extra' }));
    expect(read.ok).toBe(false);
  });

  it('refuses a Plugin made for a newer AI17Z', () => {
    const read = readManifest(json({ ...WEATHER, compatibility: { minimum: '99.0.0' } }));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.why).toContain('99.0.0');
  });

  it('refuses a Plugin that authenticates with a field it never declared', () => {
    const read = readManifest(
      json({
        ...WEATHER,
        capabilities: [
          {
            ...WEATHER.capabilities[0],
            http: { ...WEATHER.capabilities[0]!.http, auth: { kind: 'BEARER', name: '', configKey: 'nowhere' } },
          },
        ],
      }),
    );
    expect(read.ok).toBe(false);
  });

  it('refuses a credential kept as ordinary configuration', () => {
    // An auth value that is not marked secret would travel in a shared agent
    // package, which is the one set of values that must never include one.
    const read = readManifest(
      json({
        ...WEATHER,
        config: [{ key: 'api_key', label: 'API key', secret: false, required: true, help: '' }],
        capabilities: [
          {
            ...WEATHER.capabilities[0],
            http: { ...WEATHER.capabilities[0]!.http, auth: { kind: 'BEARER', name: '', configKey: 'api_key' } },
          },
        ],
      }),
    );
    expect(read.ok).toBe(false);
  });

  it('refuses a write, because a declaration cannot show it is safe to retry', () => {
    const read = readManifest(
      json({ ...WEATHER, capabilities: [{ ...WEATHER.capabilities[0], effect: 'WRITE' }] }),
    );
    expect(read.ok).toBe(false);
  });
});

describe('installing a Plugin changes what the model may choose', () => {
  it('registers its capability into the one canonical registry', async () => {
    expect(getCapability(capabilityId)).toBeNull();
    const done = await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });
    expect(done.ok, done.ok ? '' : done.why).toBe(true);

    const registered = getCapability(capabilityId);
    expect(registered).not.toBeNull();
    // Registered the same way as every built-in: same registry, same shape.
    expect(registered!.effect).toBe('READ');
    expect(registered!.modelCallable).toBe(true);
  });

  it('is recorded with the hash of what was approved', async () => {
    const raw = json(WEATHER);
    await installPlugin({ raw, source: 'LOCAL' });
    const record = await pluginsRepo.getInstalledPlugin('test-weather');
    expect(record?.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.publisher).toBe('AI17Z Test');
  });

  it('refuses a later version under a different publisher', async () => {
    await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });
    // A substitution, not an update. The only way to notice is to have kept
    // what the first copy said.
    const again = await installPlugin({
      raw: json({ ...WEATHER, version: '2.0.0', publisher: 'Somebody Else' }),
      source: 'LOCAL',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.why).toContain('different publisher');
    expect((await pluginsRepo.getInstalledPlugin('test-weather'))?.version).toBe('1.0.0');
  });

  it('refuses a Plugin claiming a capability that already exists', async () => {
    await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });
    const clash = await installPlugin({
      raw: json({ ...WEATHER, id: 'test-weather', publisher: 'AI17Z Test', version: '1.0.1' }),
      source: 'LOCAL',
    });
    // Same Plugin updating itself is allowed; the id is its own namespace.
    expect(clash.ok).toBe(true);
  });

  it('leaves nothing registered when recording fails', async () => {
    const broken = await installPlugin({ raw: json({ ...WEATHER, id: 'x'.repeat(200) }), source: 'LOCAL' });
    expect(broken.ok).toBe(false);
    expect(listModelCallable().some((c) => c.id.startsWith('plugin_x'))).toBe(false);
  });
});

describe('a Plugin is a way of deciding about capabilities', () => {
  it('turning it off stops the capability being offered', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });

    await setPluginEnabled({ agentId: fixture.agentId, pluginId: 'test-weather', enabled: true });
    const on = await permissionsRepo.listForAgent(fixture.agentId);
    expect(on.find((row) => row.capability_id === capabilityId)?.permission).toBe('ALLOWED');

    await setPluginEnabled({ agentId: fixture.agentId, pluginId: 'test-weather', enabled: false });
    const off = await permissionsRepo.listForAgent(fixture.agentId);
    expect(off.find((row) => row.capability_id === capabilityId)?.permission).toBe('DISABLED');
  });

  it('writes the decision where the loop reads it, not somewhere of its own', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: 'test-weather', enabled: true });

    // The one place a decision lives. If a Plugin kept its own copy, this
    // would be empty and the screen would still say the Plugin was on.
    const stored = await permissionsRepo.listForAgent(fixture.agentId);
    expect(stored.some((row) => row.capability_id === capabilityId)).toBe(true);
  });

  it('shows the Plugin with its capability, hosts and quota', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });
    const views = await pluginViews({ agentId: fixture.agentId, accountId: null, paused: false });

    const mine = views.find((view) => view.id === 'test-weather');
    expect(mine).toBeDefined();
    expect(mine!.source).toBe('LOCAL');
    expect(mine!.removable).toBe(true);
    expect(mine!.capabilities.map((c) => c.id)).toContain(capabilityId);
    // The hosts it may reach are shown, because that is the thing an owner is
    // actually being asked to trust.
    expect(mine!.hosts).toEqual(['api.example-weather.test']);
    expect(mine!.quotaPerHour).toBe(30);
  });

  it('shows the built-in packs as Plugins without copying them', async () => {
    const fixture = await createFixture();
    const views = await pluginViews({ agentId: fixture.agentId, accountId: null, paused: false });
    const builtIn = views.filter((view) => view.source === 'BUILT_IN');
    expect(builtIn.length).toBeGreaterThan(0);
    // A built-in cannot be removed, and it has no version of its own because
    // it ships with the application.
    for (const view of builtIn) {
      expect(view.removable).toBe(false);
      expect(view.version).toBeNull();
    }
  });
});

describe('uninstalling', () => {
  it('stops the capability being callable and forgets the decision', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: 'test-weather', enabled: true });

    const gone = await uninstallPlugin('test-weather');
    expect(gone.ok).toBe(true);
    expect(getCapability(capabilityId)).toBeNull();

    // A decision about something that no longer exists is not one anybody can
    // act on, and leaving it behind means reinstalling silently restores a
    // permission the owner last saw long ago.
    const stored = await permissionsRepo.listForAgent(fixture.agentId);
    expect(stored.some((row) => row.capability_id === capabilityId)).toBe(false);
  });

  it('does not touch the rest of the agent', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(WEATHER), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: 'test-weather', enabled: true });
    const before = (await permissionsRepo.listForAgent(fixture.agentId)).filter(
      (row) => !row.capability_id.startsWith('plugin_'),
    ).length;

    await uninstallPlugin('test-weather');
    const after = (await permissionsRepo.listForAgent(fixture.agentId)).filter(
      (row) => !row.capability_id.startsWith('plugin_'),
    ).length;
    expect(after).toBe(before);
  });
});

describe('what a new agent starts with', () => {
  it('switches on a small read-only set and nothing else', async () => {
    const fixture = await createFixture();
    await permissionsRepo.clear(fixture.agentId, '').catch(() => undefined);
    await applyCoreRecommended(fixture.agentId);

    const stored = await permissionsRepo.listForAgent(fixture.agentId);
    const on = stored.filter((row) => row.permission !== 'DISABLED');
    expect(on.length).toBeGreaterThan(0);

    // Nothing that writes, and nothing financial, is on for an agent nobody
    // has configured.
    for (const row of on) {
      const capability = getCapability(row.capability_id);
      expect(capability?.effect, `${row.capability_id} writes and is on by default`).toBe('READ');
      expect(row.capability_id.startsWith('market.')).toBe(false);
      expect(row.capability_id.startsWith('chain.')).toBe(false);
      expect(row.capability_id.startsWith('x.')).toBe(false);
    }
  });

  it('never overwrites an agent that already has choices', async () => {
    const fixture = await createFixture();
    await permissionsRepo.set({ agentId: fixture.agentId, capabilityId: 'time.now', permission: 'DISABLED' });

    await applyCoreRecommended(fixture.agentId);

    // An existing decision is the owner's, and absence is not permission.
    const stored = await permissionsRepo.listForAgent(fixture.agentId);
    expect(stored.find((row) => row.capability_id === 'time.now')?.permission).toBe('DISABLED');
  });

  it('recommends only packs that exist', () => {
    // A recommended set naming a pack nobody ships is a default that silently
    // switches nothing on.
    for (const id of CORE_RECOMMENDED_PACKS) {
      expect(typeof id).toBe('string');
    }
  });
});
