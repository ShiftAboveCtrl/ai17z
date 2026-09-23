import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityPermissions as permissionsRepo, plugins as pluginsRepo } from '@xbam/database';
import {
  exportAgent,
  importAgent,
  installPlugin,
  setPluginEnabled,
  uninstallPlugin,
} from '@xbam/runtime';
import { PORTABLE_AGENT_VERSION, buildVersion, pluginCapabilityId } from '@xbam/shared';
import { registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { registerReferenceCapabilities } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * What a Plugin leaves behind when an agent is written down and read back.
 *
 * The rule the whole format rests on: an agent document is configuration, and
 * a Plugin's *identity* is configuration while its *manifest* is an installer.
 * Carrying the manifest would make one of these files a way of adding a remote
 * endpoint to whatever machine opens it, and these get emailed around.
 *
 * A credential never travels at all, on either mode. A sealed value belongs to
 * the installation that sealed it, exactly as a provider key does.
 */

installHarness();

const core = buildVersion().version.replace(/-.*$/, '');
const json = (value: unknown) => JSON.stringify(value);
const PLUGIN_ID = 'ledger-reader';
const CAPABILITY = pluginCapabilityId(PLUGIN_ID, 'read_entry');

const LEDGER = {
  schemaVersion: 1,
  id: PLUGIN_ID,
  name: 'Ledger Reader',
  summary: 'Reads one entry from a ledger service, for proving portability.',
  publisher: 'AI17Z Test',
  version: '1.0.0',
  compatibility: { minimum: core },
  kind: 'HTTP_CAPABILITY',
  config: [
    { key: 'api_key', label: 'API key', help: 'From the ledger service.', secret: true, required: true },
    { key: 'ledger', label: 'Which ledger', help: 'The ledger name.', secret: false, required: true },
  ],
  capabilities: [
    {
      name: 'read_entry',
      title: 'Read an entry',
      description: 'Reads one entry from the configured ledger by its reference.',
      category: 'RESEARCH',
      effect: 'READ',
      risk: 'LOW',
      input: { fields: [{ name: 'reference', type: 'string', required: true, describe: 'The entry reference' }] },
      output: { fields: [{ name: 'entry', type: 'string', from: 'entry' }] },
      http: {
        method: 'GET',
        url: 'https://api.ledger.test/v1/entry?ref={reference}',
        hosts: ['api.ledger.test'],
        timeoutMs: 5_000,
        quotaPerHour: 20,
        auth: { kind: 'BEARER', name: '', configKey: 'api_key' },
      },
    },
  ],
  features: [],
};

const SECRET = 'sk-ledger-do-not-travel';

beforeEach(async () => {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  registerReferenceCapabilities();
  for (const record of await pluginsRepo.listInstalledPlugins()) {
    await pluginsRepo.removeInstalledPlugin(record.id);
  }
});

/** An agent with the Plugin installed, configured, enabled and credentialed. */
async function agentUsingTheLedger() {
  const fixture = await createFixture();
  expect((await installPlugin({ raw: json(LEDGER), source: 'LOCAL' })).ok).toBe(true);
  await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
  await pluginsRepo.setPluginConfig(fixture.agentId, PLUGIN_ID, { ledger: 'main' });
  await pluginsRepo.setPluginSecret(fixture.agentId, PLUGIN_ID, 'api_key', SECRET);
  return fixture;
}

describe('exporting an agent that uses a Plugin', () => {
  it('names the Plugin and carries no manifest', async () => {
    const fixture = await agentUsingTheLedger();
    const document = await exportAgent(fixture.agentId);

    expect(document.version).toBe(PORTABLE_AGENT_VERSION);
    const carried = document.plugins.find((plugin) => plugin.id === PLUGIN_ID)!;
    expect(carried).toBeDefined();
    expect(carried.name).toBe('Ledger Reader');
    expect(carried.publisher).toBe('AI17Z Test');
    expect(carried.version).toBe('1.0.0');

    // Nowhere in the whole document is there a manifest, a host, a URL or a
    // capability declaration. Opening this file installs nothing.
    const text = json(document);
    expect(text).not.toContain('api.ledger.test');
    expect(text).not.toContain('schemaVersion');
    expect(text).not.toContain('quotaPerHour');
  });

  it('carries the non-secret configuration and not the credential', async () => {
    const fixture = await agentUsingTheLedger();
    const document = await exportAgent(fixture.agentId);
    const carried = document.plugins.find((plugin) => plugin.id === PLUGIN_ID)!;

    expect(carried.config).toEqual({ ledger: 'main' });
    // The one thing this test exists for.
    expect(json(document)).not.toContain(SECRET);
    expect(json(document)).not.toContain('api_key');
  });

  it('carries the decision about its capability, which is what it is for', async () => {
    const fixture = await agentUsingTheLedger();
    const document = await exportAgent(fixture.agentId);
    const decided = document.toolspace.find((entry) => entry.id === CAPABILITY);
    expect(decided, 'the decision about a Plugin capability was lost').toBeDefined();
    expect(decided!.permission).toBe('ALLOWED');
  });
});

describe('importing it where the Plugin is installed', () => {
  it('applies the configuration and keeps the decision', async () => {
    const source = await agentUsingTheLedger();
    const document = await exportAgent(source.agentId);

    // Same installation, same Plugin, a new agent.
    const report = await importAgent({ ownerId: source.ownerId, document, name: 'Imported' });

    const config = await pluginsRepo.getPluginConfig(report.agentId, PLUGIN_ID);
    expect(config).toEqual({ ledger: 'main' });

    const rows = await permissionsRepo.listForAgent(report.agentId);
    expect(rows.find((row) => row.capability_id === CAPABILITY)?.permission).toBe('ALLOWED');
  });

  it('brings no credential with it, and says so rather than leaving it to be discovered', async () => {
    const source = await agentUsingTheLedger();
    const document = await exportAgent(source.agentId);
    const report = await importAgent({ ownerId: source.ownerId, document, name: 'Imported' });

    expect(await pluginsRepo.pluginSecretKeys(report.agentId, PLUGIN_ID)).toEqual([]);
    expect(report.notes.join(' ')).toContain('credential');
    // Said in a sentence somebody can act on, naming the Plugin.
    expect(report.notes.join(' ')).toContain('Ledger Reader');
  });

  it('does not apply another publisher’s configuration to a Plugin of the same name', async () => {
    const source = await agentUsingTheLedger();
    const document = await exportAgent(source.agentId);

    // The same id, published by somebody else. That is a different Plugin.
    await uninstallPlugin(PLUGIN_ID);
    await installPlugin({ raw: json({ ...LEDGER, publisher: 'Somebody Else' }), source: 'LOCAL' });

    const report = await importAgent({ ownerId: source.ownerId, document, name: 'Imported' });
    expect(await pluginsRepo.getPluginConfig(report.agentId, PLUGIN_ID)).toEqual({});
    expect(report.notes.join(' ')).toContain('different Plugin');
  });
});

describe('importing it where the Plugin is not installed', () => {
  it('names what is missing instead of leaving a list of ids nobody can explain', async () => {
    const source = await agentUsingTheLedger();
    const document = await exportAgent(source.agentId);

    await uninstallPlugin(PLUGIN_ID);
    const report = await importAgent({ ownerId: source.ownerId, document, name: 'Imported' });

    const notes = report.notes.join(' ');
    expect(notes).toContain('Ledger Reader');
    expect(notes).toContain('1.0.0');
    expect(notes).toContain('AI17Z Test');
    expect(notes).toContain('not installed here');
  });

  it('installs nothing, whatever the document says', async () => {
    const source = await agentUsingTheLedger();
    const document = await exportAgent(source.agentId);

    await uninstallPlugin(PLUGIN_ID);
    await importAgent({ ownerId: source.ownerId, document, name: 'Imported' });

    // The property the format is built around. A file that arrived by email
    // does not get to add a remote endpoint to somebody's machine.
    expect(await pluginsRepo.getInstalledPlugin(PLUGIN_ID)).toBeNull();
  });

  it('writes no configuration for a Plugin that is not there', async () => {
    const source = await agentUsingTheLedger();
    const document = await exportAgent(source.agentId);

    await uninstallPlugin(PLUGIN_ID);
    const report = await importAgent({ ownerId: source.ownerId, document, name: 'Imported' });

    // Enforced by the foreign key as well as by the branch above, so a later
    // caller that forgot could not write one either.
    expect(await pluginsRepo.getPluginConfig(report.agentId, PLUGIN_ID)).toEqual({});
  });
});

describe('an imported agent keeps its own decisions', () => {
  it('is not given this installation’s recommended defaults on top', async () => {
    // The import path deliberately does not call `applyCoreRecommended`. If it
    // did, every capability the package did not mention would end up at this
    // machine's recommendation rather than at what its owner chose, and the
    // difference is invisible until the agent does something it was told not
    // to.
    const source = await createFixture();
    await permissionsRepo.set({
      agentId: source.agentId,
      capabilityId: 'reference.look_up',
      permission: 'DISABLED',
    });
    const document = await exportAgent(source.agentId);

    const report = await importAgent({ ownerId: source.ownerId, document, name: 'Imported' });
    const rows = await permissionsRepo.listForAgent(report.agentId);
    // `reference` is in the recommended set. The export said off, so it is off.
    expect(rows.find((row) => row.capability_id === 'reference.look_up')?.permission).toBe('DISABLED');
  });
});
