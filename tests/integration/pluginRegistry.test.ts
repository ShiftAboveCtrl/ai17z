import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plugins as pluginsRepo } from '@xbam/database';
import {
  installFromRegistry,
  registryAddress,
  registryCatalog,
  registryDetail,
  registryKeyState,
  setRegistryAddress,
  setRegistryKey,
} from '@xbam/runtime';
import { buildVersion, pluginCapabilityId } from '@xbam/shared';
import { getCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { startRegistry, sha256, type FakeRegistry } from '../support/registryServer';

installHarness();

/**
 * The registry client, against a server that speaks the protocol.
 *
 * The official registry is not deployed and there is no website source here,
 * so the alternative to this would be testing the client against mocks of
 * itself. `tests/support/registryServer.ts` implements the contract instead,
 * which means a change to the client that stops speaking the protocol fails
 * here rather than on somebody's machine.
 */

const core = buildVersion().version.replace(/-.*$/, '');

const manifestFor = (id: string, publisher = 'AI17Z Test', version = '1.0.0') =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    name: `Registry ${id}`,
    summary: 'A Plugin fetched from a registry, for proving the path works.',
    publisher,
    version,
    compatibility: { minimum: core },
    kind: 'HTTP_CAPABILITY',
    config: [],
    capabilities: [
      {
        name: 'read_thing',
        title: 'Read a thing',
        description: 'Reads one value from a public API.',
        category: 'RESEARCH',
        effect: 'READ',
        risk: 'LOW',
        input: { fields: [{ name: 'q', type: 'string', required: true, describe: 'What to ask for' }] },
        output: { fields: [{ name: 'value', type: 'string', from: 'result.value' }] },
        http: {
          method: 'GET',
          url: 'https://api.example-registry.test/v1?q={q}',
          hosts: ['api.example-registry.test'],
          timeoutMs: 8_000,
          quotaPerHour: 30,
        },
      },
    ],
    features: [],
  });

let registry: FakeRegistry;
const through = () => ({
  base: registry.url,
  transport: async (url: string, headers: Record<string, string>) => {
    const response = await fetch(url, { headers });
    return { status: response.status, text: await response.text() };
  },
});

beforeEach(async () => {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  for (const record of await pluginsRepo.listInstalledPlugins()) {
    await pluginsRepo.removeInstalledPlugin(record.id);
  }
  await setRegistryKey(null);
  await setRegistryAddress(null);
});

afterEach(async () => {
  await registry?.close();
});

describe('browsing without a key', () => {
  it('lists public Plugins', async () => {
    registry = await startRegistry([
      { id: 'open-one', name: 'Open One', summary: 'Public.', publisher: 'AI17Z Test', version: '1.0.0', manifest: manifestFor('open-one') },
    ]);
    const answer = await registryCatalog(undefined, through());
    expect(answer.ok, answer.ok ? '' : answer.why).toBe(true);
    if (answer.ok) expect(answer.plugins.map((p) => p.id)).toContain('open-one');
    // A public catalogue is public. Needing a key to browse is how a narrow
    // credential becomes one every installation has to have.
    expect(registry.sawKey).toBe(false);
  });

  it('does not list an entitled Plugin, and says so when asked for it', async () => {
    registry = await startRegistry([
      { id: 'private-one', name: 'Private One', summary: 'Entitled.', publisher: 'AI17Z Test', version: '1.0.0', entitled: true, manifest: manifestFor('private-one') },
    ]);
    const list = await registryCatalog(undefined, through());
    expect(list.ok && list.plugins.length).toBe(0);

    const detail = await registryDetail('private-one', through());
    expect(detail.ok).toBe(false);
    if (!detail.ok) expect(detail.needsKey).toBe(true);
  });
});

describe('browsing with a key', () => {
  it('sends the key and sees the entitled Plugin', async () => {
    registry = await startRegistry([
      { id: 'private-one', name: 'Private One', summary: 'Entitled.', publisher: 'AI17Z Test', version: '1.0.0', entitled: true, manifest: manifestFor('private-one') },
    ]);
    await setRegistryKey('registry-key-for-a-test-0001');

    const answer = await registryCatalog(undefined, through());
    expect(answer.ok && answer.plugins.map((p) => p.id)).toContain('private-one');
    expect(registry.sawKey).toBe(true);

    // And it is still never readable back out.
    const state = await registryKeyState();
    expect(state.present).toBe(true);
    expect(state.hint).toBe('0001');
  });
});

describe('installing from the registry', () => {
  it('verifies the checksum before reading the manifest, and installs', async () => {
    const manifest = manifestFor('good-one');
    registry = await startRegistry([
      { id: 'good-one', name: 'Good One', summary: 'Fine.', publisher: 'AI17Z Test', version: '1.0.0', manifest },
    ]);

    const done = await installFromRegistry('good-one', through());
    expect(done.ok, done.ok ? '' : done.why).toBe(true);
    expect(getCapability(pluginCapabilityId('good-one', 'read_thing'))).not.toBeNull();
    const record = await pluginsRepo.getInstalledPlugin('good-one');
    expect(record?.source).toBe('AI17Z_REGISTRY');
    expect(record?.manifestSha256).toBe(sha256(manifest));
  });

  it('refuses when what arrived does not match the published checksum', async () => {
    registry = await startRegistry([
      {
        id: 'tampered',
        name: 'Tampered',
        summary: 'Its bytes and its hash disagree.',
        publisher: 'AI17Z Test',
        version: '1.0.0',
        manifest: manifestFor('tampered'),
        // What the catalogue publishes, which is not what it sent.
        publishHashAs: 'a'.repeat(64),
      },
    ]);

    const done = await installFromRegistry('tampered', through());
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.why).toContain('checksum');
    // Refused without being read: a document changed in transit is not one to
    // reason about the contents of.
    expect(getCapability(pluginCapabilityId('tampered', 'read_thing'))).toBeNull();
  });

  it('refuses a manifest for a different Plugin than the one asked for', async () => {
    registry = await startRegistry([
      {
        id: 'bait',
        name: 'Bait',
        summary: 'Offers one id and sends another.',
        publisher: 'AI17Z Test',
        version: '1.0.0',
        manifest: manifestFor('switch'),
      },
    ]);
    const done = await installFromRegistry('bait', through());
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.why).toContain('sent a manifest for');
  });

  it('refuses when the catalogue and the manifest disagree about the publisher', async () => {
    registry = await startRegistry([
      {
        id: 'mismatch',
        name: 'Mismatch',
        summary: 'Two publishers.',
        publisher: 'Somebody Else',
        version: '1.0.0',
        manifest: manifestFor('mismatch', 'AI17Z Test'),
      },
    ]);
    const done = await installFromRegistry('mismatch', through());
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.why).toContain('publishes');
  });

  it('refuses one built for a newer AI17Z', async () => {
    const manifest = JSON.stringify({
      ...JSON.parse(manifestFor('too-new')),
      compatibility: { minimum: '99.0.0' },
    });
    registry = await startRegistry([
      { id: 'too-new', name: 'Too New', summary: 'Needs a later AI17Z.', publisher: 'AI17Z Test', version: '1.0.0', manifest },
    ]);
    const done = await installFromRegistry('too-new', through());
    expect(done.ok).toBe(false);
    expect(getCapability(pluginCapabilityId('too-new', 'read_thing'))).toBeNull();
  });
});

describe('when there is no registry', () => {
  it('says so rather than failing as if the network were broken', async () => {
    await setRegistryAddress(null);
    const answer = await registryCatalog();
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.why).toContain('No Plugin registry is configured');
  });
});

describe('a registry that answers badly', () => {
  /** A server that answers whatever the test tells it to, at any path. */
  const speaking = (status: number, body: string) => ({
    base: 'https://registry.example.test',
    transport: async () => ({ status, text: body }),
  });

  it('refuses a protocol it does not speak', async () => {
    // A future registry answering protocol 2 is not a registry this build may
    // guess about. Guessing is how a field that changed meaning is read with
    // its old meaning.
    const answer = await registryCatalog(undefined, speaking(200, JSON.stringify({ protocol: 2, plugins: [] })));
    expect(answer.ok).toBe(false);
    expect(answer.ok ? '' : answer.why).toContain('does not understand');
  });

  it('refuses a shape it does not recognise', async () => {
    const answer = await registryCatalog(undefined, speaking(200, JSON.stringify({ protocol: 1, items: [] })));
    expect(answer.ok).toBe(false);
  });

  it('refuses an answer that is not JSON at all', async () => {
    const answer = await registryCatalog(undefined, speaking(200, '<html>a proxy login page</html>'));
    expect(answer.ok).toBe(false);
    expect(answer.ok ? '' : answer.why).toContain('not JSON');
  });

  it('reports a server error as the registry failing, not the Plugin', async () => {
    const answer = await registryCatalog(undefined, speaking(503, 'unavailable'));
    expect(answer.ok).toBe(false);
    expect(answer.ok ? '' : answer.why).toContain('503');
  });

  it('says a key would help when one is refused', async () => {
    const answer = await registryCatalog(undefined, speaking(403, 'forbidden'));
    expect(answer.ok).toBe(false);
    expect(answer.ok ? false : answer.needsKey).toBe(true);
  });

  it('reports a transport that never answers rather than hanging', async () => {
    const answer = await registryCatalog(undefined, {
      base: 'https://registry.example.test',
      transport: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(answer.ok).toBe(false);
    expect(answer.ok ? '' : answer.why).toContain('could not be reached');
  });

  it('refuses a detail carrying a field it was not expecting', async () => {
    // Strict on the way in, for the same reason the manifest is strict: a
    // field this build does not understand may be the one that mattered.
    const answer = await registryDetail(
      'anything',
      speaking(
        200,
        JSON.stringify({
          protocol: 1,
          plugin: { id: 'a', name: 'AA', summary: '', publisher: 'PP', version: '1.0.0', entitled: false },
          manifest: '{}',
          manifestSha256: 'a'.repeat(64),
          somethingNew: true,
        }),
      ),
    );
    expect(answer.ok).toBe(false);
  });
});

describe('updating from the registry', () => {
  const listed = (version: string, publisher = 'AI17Z Test') => ({
    id: 'movable',
    name: 'Movable',
    summary: 'Public.',
    publisher,
    version,
    manifest: manifestFor('movable', publisher, version),
  });

  it('replaces the installed copy and leaves no stale registration', async () => {
    registry = await startRegistry([listed('1.0.0')]);

    const first = await installFromRegistry('movable', through());
    expect(first.ok, first.ok ? '' : first.why).toBe(true);
    expect(first.ok && first.version).toBe('1.0.0');
    const capability = pluginCapabilityId('movable', 'read_thing');
    expect(getCapability(capability)).not.toBeNull();

    await registry.close();
    registry = await startRegistry([listed('1.1.0')]);

    const second = await installFromRegistry('movable', through());
    expect(second.ok, second.ok ? '' : second.why).toBe(true);
    expect(second.ok && second.version).toBe('1.1.0');

    // Recorded once, registered once. A stale registration is what made the
    // registry refuse a legitimate re-register the first time this was built.
    const record = await pluginsRepo.getInstalledPlugin('movable');
    expect(record!.version).toBe('1.1.0');
    expect(getCapability(capability)).not.toBeNull();
    expect((await pluginsRepo.listInstalledPlugins()).filter((row) => row.id === 'movable')).toHaveLength(1);
  });

  it('refuses a catalogue that has been rolled back under it', async () => {
    registry = await startRegistry([listed('2.0.0')]);
    expect((await installFromRegistry('movable', through())).ok).toBe(true);

    await registry.close();
    registry = await startRegistry([listed('1.0.0')]);
    const back = await installFromRegistry('movable', through());
    expect(back.ok).toBe(false);
    expect(back.ok ? '' : back.why).toContain('older');
    expect((await pluginsRepo.getInstalledPlugin('movable'))!.version).toBe('2.0.0');
  });

  it('refuses a new version whose publisher has changed', async () => {
    registry = await startRegistry([listed('1.0.0')]);
    expect((await installFromRegistry('movable', through())).ok).toBe(true);

    await registry.close();
    registry = await startRegistry([listed('1.1.0', 'Somebody Else')]);
    const swapped = await installFromRegistry('movable', through());
    expect(swapped.ok).toBe(false);
    expect(swapped.ok ? '' : swapped.why).toContain('different publisher');
    expect((await pluginsRepo.getInstalledPlugin('movable'))!.publisher).toBe('AI17Z Test');
  });
});

describe('the address itself', () => {
  it('keeps the origin and discards anything after it', async () => {
    await setRegistryAddress('https://plugins.example.test/some/path?q=1');
    // A path in a base address would be prepended to every endpoint, and a
    // query string would be lost the moment one was built.
    expect(await registryAddress()).toBe('https://plugins.example.test');
  });

  it('treats an http address as no address at all', async () => {
    await setRegistryAddress('http://plugins.example.test');
    expect(await registryAddress()).toBeNull();
  });

  it('treats something that is not a URL as no address', async () => {
    await setRegistryAddress('plugins.example.test');
    expect(await registryAddress()).toBeNull();
  });
});
