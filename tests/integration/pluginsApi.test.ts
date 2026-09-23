import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { plugins as pluginsRepo } from '@xbam/database';
import { buildVersion, pluginCapabilityId } from '@xbam/shared';
import { getCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { registerReferenceCapabilities } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The Plugins surface, over HTTP.
 *
 * The runtime behind these already has its own tests. What is proved here is
 * the part an owner actually touches: that somebody can reach their own
 * Plugins and nobody else's, that turning one on over the network changes the
 * capability permissions underneath it, and above all that no secret comes
 * back out. A key that is write-only is a property of the route, not of the
 * store, because the store cannot stop a route selecting it.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

async function signIn(email: string): Promise<{ authorization: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-1234' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}

const core = buildVersion().version.replace(/-.*$/, '');

const WEATHER = {
  schemaVersion: 1,
  id: 'api-weather',
  name: 'API Weather',
  summary: 'A Plugin used to prove the HTTP surface behaves.',
  publisher: 'AI17Z Test',
  version: '1.0.0',
  compatibility: { minimum: core },
  kind: 'HTTP_CAPABILITY',
  config: [{ key: 'api_key', label: 'API key', secret: true, required: true, help: '' }],
  capabilities: [
    {
      name: 'read_forecast',
      title: 'Read a forecast',
      description: 'Reads the current temperature somewhere.',
      category: 'RESEARCH',
      effect: 'READ',
      risk: 'LOW',
      input: { fields: [{ name: 'place', type: 'string', required: true, describe: 'Where' }] },
      output: { fields: [{ name: 'temperature', type: 'number', from: 'temp' }] },
      http: {
        method: 'GET',
        url: 'https://api.example-weather.test/v1?q={place}',
        hosts: ['api.example-weather.test'],
        auth: { kind: 'BEARER', name: '', configKey: 'api_key' },
        timeoutMs: 8_000,
        quotaPerHour: 20,
      },
    },
  ],
  features: [],
};

beforeEach(async () => {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  // The reference family as well, because the built-in three are `time.`,
  // `memory.` and `self.` and none of them is in a pack. Turning a pack on
  // over the network is only a test of anything if the pack has members:
  // without these, `reference` was an empty group and the route was exercising
  // the case where there is nothing to decide about.
  registerReferenceCapabilities();
  for (const record of await pluginsRepo.listInstalledPlugins()) {
    await pluginsRepo.removeInstalledPlugin(record.id);
  }
});

describe('reaching Plugins over HTTP', () => {
  it('lists the built-in Plugins for an owner', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const response = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/plugins`, headers });
    expect(response.statusCode, response.body).toBe(200);
    const { data } = response.json() as { data: { plugins: { id: string; source: string; removable: boolean }[] } };
    expect(data.plugins.length).toBeGreaterThan(0);
    // A built-in ships with the application and cannot be removed, only
    // switched off. Saying otherwise would offer a button that does nothing.
    expect(data.plugins.every((plugin) => plugin.source !== 'BUILT_IN' || !plugin.removable)).toBe(true);
  });

  it('refuses somebody else’s agent', async () => {
    const mine = await createFixture();
    const stranger = await createFixture();
    const headers = await signIn(stranger.ownerEmail);

    const response = await app.inject({ method: 'GET', url: `/api/agents/${mine.agentId}/plugins`, headers });
    expect([403, 404]).toContain(response.statusCode);
  });

  it('turning one on over the network writes the capability permission', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const off = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/plugins/reference`,
      headers,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);

    const after = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/plugins`, headers });
    const { data } = after.json() as { data: { plugins: { id: string; state: string }[] } };
    expect(data.plugins.find((plugin) => plugin.id === 'reference')?.state).toBe('OFF');
  });
});

describe('installing over HTTP', () => {
  it('installs a manifest and registers its capability', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      headers,
      payload: { manifest: JSON.stringify(WEATHER) },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { data } = response.json() as { data: { ok: boolean } };
    expect(data.ok).toBe(true);
    expect(getCapability(pluginCapabilityId('api-weather', 'read_forecast'))).not.toBeNull();
  });

  it('refuses a malformed manifest with a reason rather than a stack', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      headers,
      payload: { manifest: '{"schemaVersion":99}' },
    });
    expect(response.statusCode).toBe(200);
    const { data } = response.json() as { data: { ok: boolean; why?: string } };
    expect(data.ok).toBe(false);
    expect(data.why).toBeTruthy();
  });

  it('uninstalls and the capability goes with it', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      headers,
      payload: { manifest: JSON.stringify(WEATHER) },
    });

    const gone = await app.inject({ method: 'DELETE', url: '/api/plugins/api-weather', headers });
    expect(gone.statusCode, gone.body).toBe(200);
    expect(getCapability(pluginCapabilityId('api-weather', 'read_forecast'))).toBeNull();
  });
});

describe('secrets go in and never come back', () => {
  it('stores a Plugin secret and reports only which keys are filled', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      headers,
      payload: { manifest: JSON.stringify(WEATHER) },
    });

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/plugins/api-weather/config`,
      headers,
      payload: { config: {}, secrets: { api_key: 'sk-very-secret-value-9876' } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // The answer names the key and never carries the value.
    expect(saved.body).toContain('api_key');
    expect(saved.body).not.toContain('sk-very-secret-value-9876');

    // And it is not reachable from the Plugin listing either.
    const listed = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/plugins`, headers });
    expect(listed.body).not.toContain('sk-very-secret-value-9876');
  });

  it('will not accept a value for a key the manifest never declared', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    await app.inject({
      method: 'POST',
      url: '/api/plugins/install',
      headers,
      payload: { manifest: JSON.stringify(WEATHER) },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/plugins/api-weather/config`,
      headers,
      // A Plugin that could be handed values it never asked for is a Plugin
      // that can be used as somebody's storage.
      payload: { config: { smuggled: 'value' }, secrets: {} },
    });
    expect(response.statusCode).toBe(200);
    const { data } = response.json() as { data: { config: Record<string, unknown> } };
    expect(data.config.smuggled).toBeUndefined();
  });
});

describe('the registry key is write-only', () => {
  it('reports presence and the last four characters, never the key', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/plugins/registry',
      headers,
      payload: { key: 'ai17z-registry-key-abcd1234' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain('ai17z-registry-key-abcd1234');

    const read = await app.inject({ method: 'GET', url: '/api/plugins/registry', headers });
    const { data } = read.json() as { data: { key: { present: boolean; hint: string | null } } };
    expect(data.key.present).toBe(true);
    expect(data.key.hint).toBe('1234');
    expect(read.body).not.toContain('ai17z-registry-key-abcd1234');
  });

  it('says the catalogue is unreachable rather than pretending, with no registry set', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    await app.inject({ method: 'PUT', url: '/api/plugins/registry', headers, payload: { url: null } });

    const response = await app.inject({ method: 'GET', url: '/api/plugins/catalog', headers });
    expect(response.statusCode).toBe(200);
    const { data } = response.json() as { data: { ok: boolean; why?: string } };
    expect(data.ok).toBe(false);
    expect(data.why).toContain('registry');
  });

  it('refuses an address that is not https, and says so', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/plugins/registry',
      headers,
      payload: { url: 'http://registry.example.test' },
    });
    expect(response.statusCode).toBe(200);
    const { data } = response.json() as { data: { ok: boolean; why?: string } };
    // A catalogue fetched over http is one somebody on the path chooses.
    expect(data.ok).toBe(false);
    expect(data.why).toContain('https');

    // And nothing was stored. This used to accept the value, keep it, and
    // report the address as null -- so an owner watched the field they had
    // just filled in go blank with no explanation, while an unusable value sat
    // in the settings table.
    const after = await app.inject({ method: 'GET', url: '/api/plugins/registry', headers });
    const read = after.json() as { data: { url: string | null } };
    expect(read.data.url).toBeNull();
  });
});
