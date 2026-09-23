import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityInvocations, capabilityPermissions as permissionsRepo, plugins } from '@xbam/database';
import {
  installFromRegistry,
  runCapabilityLoop,
  setPluginEnabled,
  uninstallPlugin,
  capabilitySettings,
} from '@xbam/runtime';
import { buildVersion, pluginCapabilityId } from '@xbam/shared';
import {
  listModelCallable,
  registerBuiltinCapabilities,
  resetCapabilitiesForTest,
} from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { startRegistry, type FakeRegistry } from '../support/registryServer';

/**
 * The one thing this test cannot do for real: reach the internet.
 *
 * `safeFetch` is the canonical bounded layer and is mocked here rather than
 * bypassed, so the executor still calls exactly what it calls in production
 * and still receives the shape it receives. Everything the executor does
 * around this call, which is the part under test, is untouched: the allowlist
 * before and after, the quota, the credential, the schema and the audit.
 */
const served = new Map<string, { status: number; text: string; url?: string }>();
vi.mock('@xbam/upstream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xbam/upstream')>();
  return {
    ...actual,
    safeFetch: async (url: string) => {
      for (const [match, answer] of served) {
        if (url.includes(match)) {
          return { status: answer.status, text: answer.text, url: answer.url ?? url, headers: {} };
        }
      }
      throw new Error(`nothing served for ${url}`);
    },
  };
});

installHarness();

/**
 * A Plugin nobody wrote into this repository, extending an agent.
 *
 * This is the proof the whole Plugins product rests on, and it is deliberately
 * the long way round: the Plugin is published by a registry, fetched over the
 * registry protocol, checked, installed, registered, enabled, shortlisted,
 * chosen by a model, validated, executed, audited, and then turned off and
 * removed again. Nothing here is special-cased in production code. If any link
 * were faked, the next Plugin somebody writes would not work.
 *
 * `registered` is not `offered`, `offered` is not `selected`, and `selected` is
 * not `used`. Each of those is asserted separately, because a test that only
 * checks the last one cannot say which link broke.
 */

const core = buildVersion().version.replace(/-.*$/, '');
const PLUGIN_ID = 'tide-times';
const CAPABILITY = pluginCapabilityId(PLUGIN_ID, 'read_tide');

const MANIFEST = JSON.stringify({
  schemaVersion: 1,
  id: PLUGIN_ID,
  name: 'Tide Times',
  summary: 'Reads the next high tide for a harbour.',
  publisher: 'AI17Z Test',
  version: '1.0.0',
  compatibility: { minimum: core },
  kind: 'HTTP_CAPABILITY',
  config: [],
  capabilities: [
    {
      name: 'read_tide',
      title: 'Read the tide',
      description: 'Reads the next high tide time for a named harbour. Use it when somebody asks about tides.',
      category: 'RESEARCH',
      effect: 'READ',
      risk: 'LOW',
      input: { fields: [{ name: 'harbour', type: 'string', required: true, describe: 'The harbour name' }] },
      output: {
        fields: [
          { name: 'harbour', type: 'string', from: 'place' },
          { name: 'highTide', type: 'string', from: 'next.high' },
        ],
      },
      http: {
        method: 'GET',
        url: 'https://api.example-tides.test/v1/next?harbour={harbour}',
        hosts: ['api.example-tides.test'],
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
  served.clear();
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  for (const record of await plugins.listInstalledPlugins()) {
    await plugins.removeInstalledPlugin(record.id);
  }
});

describe('a Plugin from a registry reaches the model and comes back', () => {
  it('goes the whole way, and stops going when it is turned off', async () => {
    const fixture = await createFixture();
    registry = await startRegistry([
      {
        id: PLUGIN_ID,
        name: 'Tide Times',
        summary: 'Reads the next high tide.',
        publisher: 'AI17Z Test',
        version: '1.0.0',
        manifest: MANIFEST,
      },
    ]);

    // ── 1. The registry lists it, and the detail loads ──────────────────────
    const installed = await installFromRegistry(PLUGIN_ID, through());
    expect(installed.ok, installed.ok ? '' : installed.why).toBe(true);
    expect(registry.requests.some((path) => path.includes(PLUGIN_ID))).toBe(true);

    // ── 2. Registered, which is not the same as offered ─────────────────────
    expect(listModelCallable().some((capability) => capability.id === CAPABILITY)).toBe(true);

    // ── 3. The agent follows the configured permission ──────────────────────
    // A newly installed READ/LOW capability defaults to allowed, and the
    // decision lives in the one place decisions live.
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    const decided = await permissionsRepo.listForAgent(fixture.agentId);
    expect(decided.find((row) => row.capability_id === CAPABILITY)?.permission).toBe('ALLOWED');

    // The declared host answers, from the mock above.
    served.set('api.example-tides.test', {
      status: 200,
      text: JSON.stringify({ place: 'Newlyn', next: { high: '14:08' } }),
    });

    const settings = await capabilitySettings(fixture.agentId);
    const asked = 'when is the next high tide at Newlyn harbour';
    let sawMenu: string[] = [];

    const loop = await runCapabilityLoop({
      agentId: fixture.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: asked }],
      task: asked,
      permissions: settings.permissions,
      configs: settings.configs,
      paused: false,
      maxSteps: 2,
      // Standing in for the model, and choosing the way a model does: from
      // the menu it was shown. If the capability were not shortlisted, there
      // would be nothing here to choose and this would answer without it.
      generate: async (messages) => {
        const menu = messages.map((message) => String(message.content)).join('\n');
        if (sawMenu.length === 0) {
          sawMenu = menu.includes(CAPABILITY) ? [CAPABILITY] : [];
        }
        if (menu.includes('"highTide"') || menu.includes('14:08')) {
          return 'The next high tide at Newlyn is at 14:08.';
        }
        return `<use-capability>{"id":"${CAPABILITY}","input":{"harbour":"Newlyn"}}</use-capability>`;
      },
    });

    // ── 4. Offered ──────────────────────────────────────────────────────────
    expect(loop.shortlist.offered.map((capability) => capability.id)).toContain(CAPABILITY);

    // ── 5. Selected, 6. validated, 7. permitted and ready, 8. executed ──────
    expect(loop.steps.map((step) => step.capabilityId)).toContain(CAPABILITY);
    const step = loop.steps.find((entry) => entry.capabilityId === CAPABILITY)!;
    expect(step.outcome, step.detail).toBe('SUCCEEDED');

    // ── 9. The result reaches the answer ────────────────────────────────────
    expect(loop.answer).toContain('14:08');

    // ── 10. Audited, like every other capability ────────────────────────────
    const audit = await capabilityInvocations.listForAgent(fixture.agentId, 20);
    const row = audit.find((entry) => entry.capabilityId === CAPABILITY);
    expect(row, 'the invocation was not recorded').toBeDefined();
    expect(row!.outcome).toBe('SUCCEEDED');

    // ── 11. Turned off, it is no longer offered ─────────────────────────────
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: false });
    const after = await capabilitySettings(fixture.agentId);
    const offAgain = await runCapabilityLoop({
      agentId: fixture.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: asked }],
      task: asked,
      permissions: after.permissions,
      configs: after.configs,
      paused: false,
      maxSteps: 1,
      generate: async () => 'I cannot look that up.',
    });
    expect(offAgain.shortlist.offered.map((capability) => capability.id)).not.toContain(CAPABILITY);

    // ── 12. Uninstalled, it is gone without taking the agent with it ────────
    const removed = await uninstallPlugin(PLUGIN_ID);
    expect(removed.ok).toBe(true);
    expect(listModelCallable().some((capability) => capability.id === CAPABILITY)).toBe(false);

    // The audit of what the agent did survives. Uninstalling the thing it used
    // does not undo having used it.
    const stillAudited = await capabilityInvocations.listForAgent(fixture.agentId, 20);
    expect(stillAudited.some((entry) => entry.capabilityId === CAPABILITY)).toBe(true);
  });

  it('refuses to reach a host the Plugin never declared', async () => {
    const fixture = await createFixture();
    registry = await startRegistry([
      {
        id: PLUGIN_ID,
        name: 'Tide Times',
        summary: 'Reads the next high tide.',
        publisher: 'AI17Z Test',
        version: '1.0.0',
        manifest: MANIFEST,
      },
    ]);
    await installFromRegistry(PLUGIN_ID, through());
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });

    // The declared host answers, but the address that actually answered is
    // somewhere the Plugin never named. `safeFetch` re-judges hops for private
    // addresses; this is the other half, a public host outside the
    // declaration, which only the executor's own check can catch.
    served.set('api.example-tides.test', {
      status: 200,
      text: JSON.stringify({ place: 'Elsewhere', next: { high: '00:00' } }),
      url: 'https://somewhere-else.test/v1/next',
    });

    const settings = await capabilitySettings(fixture.agentId);
    const loop = await runCapabilityLoop({
      agentId: fixture.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'tide at Newlyn' }],
      task: 'tide at Newlyn',
      permissions: settings.permissions,
      configs: settings.configs,
      paused: false,
      maxSteps: 1,
      generate: async () =>
        `<use-capability>{"id":"${CAPABILITY}","input":{"harbour":"../../etc/passwd"}}</use-capability>`,
    });

    const step = loop.steps.find((entry) => entry.capabilityId === CAPABILITY);
    expect(step, 'the capability was never reached').toBeDefined();
    // Refused, and named: a redirect off the allowlist reads nothing.
    expect(step!.outcome).not.toBe('SUCCEEDED');
    expect(step!.detail).toContain('did not declare');
    expect(loop.answer).not.toContain('00:00');
  });
});

describe('a Plugin that gets a new version', () => {
  /** The same Plugin, at a version, optionally reaching one more host. */
  const at = (version: string, extraHost?: string) =>
    JSON.stringify({
      ...JSON.parse(MANIFEST),
      version,
      capabilities: [
        {
          ...JSON.parse(MANIFEST).capabilities[0],
          http: {
            ...JSON.parse(MANIFEST).capabilities[0].http,
            hosts: extraHost
              ? ['api.example-tides.test', extraHost]
              : ['api.example-tides.test'],
          },
        },
      ],
    });

  it('keeps the agent’s decision and its configuration across an update', async () => {
    const fixture = await createFixture();
    registry = await startRegistry([
      {
        id: PLUGIN_ID,
        name: 'Tide Times',
        summary: 'Reads the next high tide.',
        publisher: 'AI17Z Test',
        version: '1.0.0',
        manifest: at('1.0.0'),
      },
    ]);

    expect((await installFromRegistry(PLUGIN_ID, through())).ok).toBe(true);
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    await plugins.setPluginConfig(fixture.agentId, PLUGIN_ID, { harbour_default: 'Newlyn' });

    await registry.close();
    registry = await startRegistry([
      {
        id: PLUGIN_ID,
        name: 'Tide Times',
        summary: 'Reads the next high tide.',
        publisher: 'AI17Z Test',
        version: '1.1.0',
        manifest: at('1.1.0'),
      },
    ]);
    const updated = await installFromRegistry(PLUGIN_ID, through());
    expect(updated.ok, updated.ok ? '' : updated.why).toBe(true);

    // An update is not a reinstall. What the owner decided and what they
    // configured survive it, or every update is a small outage they have to
    // notice and repair.
    const decided = await permissionsRepo.listForAgent(fixture.agentId);
    expect(decided.find((row) => row.capability_id === CAPABILITY)?.permission).toBe('ALLOWED');
    expect(await plugins.getPluginConfig(fixture.agentId, PLUGIN_ID)).toEqual({ harbour_default: 'Newlyn' });

    // One registration, one record, at the new version.
    expect(listModelCallable().filter((capability) => capability.id === CAPABILITY)).toHaveLength(1);
    expect((await plugins.getInstalledPlugin(PLUGIN_ID))!.version).toBe('1.1.0');
  });

  it('stops for an owner when the new version reaches somewhere new', async () => {
    const fixture = await createFixture();
    registry = await startRegistry([
      {
        id: PLUGIN_ID,
        name: 'Tide Times',
        summary: 'Reads the next high tide.',
        publisher: 'AI17Z Test',
        version: '1.0.0',
        manifest: at('1.0.0'),
      },
    ]);
    expect((await installFromRegistry(PLUGIN_ID, through())).ok).toBe(true);
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });

    await registry.close();
    registry = await startRegistry([
      {
        id: PLUGIN_ID,
        name: 'Tide Times',
        summary: 'Reads the next high tide.',
        publisher: 'AI17Z Test',
        version: '2.0.0',
        manifest: at('2.0.0', 'telemetry.example-tides.test'),
      },
    ]);

    const blocked = await installFromRegistry(PLUGIN_ID, through());
    expect(blocked.ok).toBe(false);
    expect((blocked.ok ? [] : (blocked.needsAcknowledgement ?? [])).join(' ')).toContain(
      'telemetry.example-tides.test',
    );
    // Still on 1.0.0, still working, still reaching only what was approved.
    expect((await plugins.getInstalledPlugin(PLUGIN_ID))!.version).toBe('1.0.0');

    const allowed = await installFromRegistry(PLUGIN_ID, { ...through(), acknowledgeExpansion: true });
    expect(allowed.ok, allowed.ok ? '' : allowed.why).toBe(true);
    expect((await plugins.getInstalledPlugin(PLUGIN_ID))!.version).toBe('2.0.0');
  });
});
