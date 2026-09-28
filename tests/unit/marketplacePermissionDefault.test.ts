import { describe, expect, it } from 'vitest';
import { capabilitiesOf } from '../../packages/runtime/src/pluginCapabilities';
import { PluginManifest, permissionWhenUnset } from '@xbam/shared/contracts';
import { resolvePermission } from '@xbam/tools';

/**
 * Bought, installed and entitled is not the same as allowed.
 *
 * An ordinary Plugin's read capabilities are allowed for an agent whose owner
 * decided nothing, which is the long-standing default. A Plugin bought on
 * Studio is not: paying for it and installing it are not a decision about
 * which agents may use it, so every agent starts DISABLED until its owner
 * enables it, and enabling it grants the ordinary default.
 */
function manifest(url: string, hosts: string[]) {
  return PluginManifest.parse({
    schemaVersion: 1,
    id: 'weather-pro',
    name: 'Weather Pro',
    summary: 'Reads a forecast.',
    publisher: 'Example',
    version: '1.0.0',
    compatibility: { minimum: '1.0.0' },
    kind: 'HTTP_CAPABILITY',
    config: [],
    capabilities: [
      {
        name: 'read_forecast',
        title: 'Read a forecast',
        description: 'Reads a forecast for a place.',
        category: 'RESEARCH',
        effect: 'READ',
        risk: 'LOW',
        input: { fields: [{ name: 'place', type: 'string', required: true }] },
        output: { fields: [{ name: 'summary', type: 'string' }] },
        http: { method: 'GET', url, hosts, timeoutMs: 8_000, quotaPerHour: 30 },
      },
    ],
  });
}

describe('what an agent may do with a Plugin nobody has decided about', () => {
  it('keeps the ordinary default for a Plugin that is not from the marketplace', () => {
    const [capability] = capabilitiesOf({ id: 'weather-pro', manifest: manifest('https://api.example.test/f?p={place}', ['api.example.test']) });
    expect(permissionWhenUnset(capability!)).toBe('ALLOWED');
  });

  it.each([
    ['the registry said it needs an entitlement', { requiresEntitlement: true }, 'https://api.example.test/f?p={place}', ['api.example.test']],
    ['it goes through Studio\'s gateway', {}, 'https://studio.example/api/gateway/v1/weather-pro/read_forecast?place={place}', ['studio.example']],
  ])('starts DISABLED when %s, and the runtime refuses it', (_label, extra, url, hosts) => {
    const [capability] = capabilitiesOf({ id: 'weather-pro', manifest: manifest(url, hosts), ...extra });
    expect(permissionWhenUnset(capability!)).toBe('DISABLED');
    expect(resolvePermission({ capability: capability!, stored: null, paused: false }).allowed).toBe(false);
    // The owner enabling it is a stored decision, and that is what then applies.
    expect(resolvePermission({ capability: capability!, stored: 'ALLOWED', paused: false }).allowed).toBe(true);
  });
});
