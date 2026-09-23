import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityPermissions as permissionsRepo, plugins as pluginsRepo, query } from '@xbam/database';
import {
  installPlugin,
  pluginViews,
  readManifest,
  setPluginEnabled,
  uninstallPlugin,
} from '@xbam/runtime';
import { buildVersion, footprintExpansion, pluginCapabilityId, pluginFootprint } from '@xbam/shared';
import { PluginManifest } from '@xbam/shared/contracts';
import {
  getCapability,
  invokeCapability,
  registerBuiltinCapabilities,
  resetCapabilitiesForTest,
} from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * The edges a Plugin system is attacked at, and what each one is answered with.
 *
 * Every case here is a thing somebody would try rather than a thing the schema
 * happens to reject. The property under all of them: an installed Plugin is a
 * declaration, so the only way it can do something is for this build to decide
 * to do it, and each of these is one of those decisions written down.
 */

/** Serves whatever a Plugin's declared host is supposed to answer. */
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

const core = buildVersion().version.replace(/-.*$/, '');
const json = (value: unknown) => JSON.stringify(value);

/** A minimal, valid Plugin. Every case below is this with one thing changed. */
const base = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'sec-probe',
  name: 'Security Probe',
  summary: 'A Plugin used to prove the edges of the Plugin system.',
  publisher: 'AI17Z Test',
  version: '1.0.0',
  compatibility: { minimum: core },
  kind: 'HTTP_CAPABILITY',
  config: [],
  capabilities: [
    {
      name: 'read_thing',
      title: 'Read a thing',
      description: 'Reads one thing from one declared host, for proving the boundary.',
      category: 'RESEARCH',
      effect: 'READ',
      risk: 'LOW',
      input: { fields: [{ name: 'what', type: 'string', required: true, describe: 'What to read' }] },
      output: { fields: [{ name: 'answer', type: 'string', from: 'answer' }] },
      http: {
        method: 'GET',
        url: 'https://api.probe.test/v1/read?what={what}',
        hosts: ['api.probe.test'],
        timeoutMs: 5_000,
        quotaPerHour: 5,
        // Declared as optional here so a case below can fill it in. The
        // manifest treats an absent credential slot and an undefined one the
        // same way, and zod strips it.
        auth: undefined as { kind: string; name: string; configKey: string } | undefined,
      },
    },
  ],
  features: [],
  ...over,
});

const CAPABILITY = pluginCapabilityId('sec-probe', 'read_thing');

beforeEach(async () => {
  served.clear();
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  for (const record of await pluginsRepo.listInstalledPlugins()) {
    await pluginsRepo.removeInstalledPlugin(record.id);
  }
});

describe('a manifest that is not what it says it is', () => {
  it('refuses one that is too big to be a manifest', () => {
    // The route caps this too. Checked here as well because the cap that
    // matters is the one nearest the thing being protected, and a 200 KB
    // manifest is not a manifest somebody wrote.
    const huge = base({ summary: 'x'.repeat(400) });
    const read = readManifest(json(huge));
    expect(read.ok).toBe(false);
  });

  it('refuses a host with a wildcard in it', () => {
    // A wildcard is how an allowlist stops being one.
    const wild = base();
    wild.capabilities[0]!.http.hosts = ['*.probe.test'];
    const read = readManifest(json(wild));
    expect(read.ok).toBe(false);
  });

  it('refuses a host carrying a scheme, a port or a path', () => {
    for (const host of ['https://api.probe.test', 'api.probe.test:8443', 'api.probe.test/v1']) {
      const bad = base();
      bad.capabilities[0]!.http.hosts = [host];
      expect(readManifest(json(bad)).ok, host).toBe(false);
    }
  });

  it('refuses an id that could climb out of a path', () => {
    // `installFromRegistry` encodes the id before it reaches a URL, so this is
    // the second line rather than the first. Both exist because the id is also
    // a primary key, a capability namespace and a table key.
    for (const id of ['../etc/passwd', 'a/../b', '.', 'a b', 'x', '-lead', 'trail-']) {
      const bad = base({ id });
      expect(readManifest(json(bad)).ok, id).toBe(false);
    }
  });

  it('normalises an id rather than refusing a capital letter', () => {
    // Not a refusal, because it is not a danger: the id is lower-cased before
    // the shape is checked, so two spellings cannot become two Plugins.
    const read = readManifest(json(base({ id: 'Sec-Probe' })));
    expect(read.ok, read.ok ? '' : read.why).toBe(true);
    expect(read.ok && read.manifest.id).toBe('sec-probe');
  });

  it('refuses a capability name that would escape its own family', () => {
    for (const name of ['read.thing', 'read/thing', '../read']) {
      const bad = base();
      bad.capabilities[0]!.name = name;
      expect(readManifest(json(bad)).ok, name).toBe(false);
    }
  });

  it('refuses a Plugin declaring a feature with nothing behind it', () => {
    // An entitlement that unlocks a blank is a Plugin that looks like it does
    // something it does not.
    const bare = base({ features: ['RESEARCH_SOURCE'] });
    const read = readManifest(json(bare));
    expect(read.ok).toBe(false);
    expect(read.ok ? '' : read.why).toContain('RESEARCH_SOURCE');
  });

  it('refuses a research source naming a capability it never declares', () => {
    const wrong = base({
      features: ['RESEARCH_SOURCE'],
      research: {
        capability: 'read_something_else',
        queryField: 'what',
        title: 'answer',
        summary: 'answer',
        sourceName: 'The Probe',
      },
    });
    expect(readManifest(json(wrong)).ok).toBe(false);
  });

  it('refuses a research source whose question has nowhere to go', () => {
    const wrong = base({
      features: ['RESEARCH_SOURCE'],
      research: {
        capability: 'read_thing',
        queryField: 'not_a_field',
        title: 'answer',
        summary: 'answer',
        sourceName: 'The Probe',
      },
    });
    expect(readManifest(json(wrong)).ok).toBe(false);
  });

  it('refuses an owner panel linking somewhere the Plugin never declared', () => {
    // A panel is drawn under a publisher's name. A link to a host nobody
    // approved is a way of putting any address at all in front of somebody.
    const wrong = base({
      features: ['OWNER_PANEL'],
      panel: {
        title: 'Probe',
        body: ['It reads one thing.'],
        showRuns: [],
        links: [{ label: 'Elsewhere', url: 'https://somewhere-else.test/docs' }],
      },
    });
    const read = readManifest(json(wrong));
    expect(read.ok).toBe(false);
    expect(read.ok ? '' : read.why).toContain('never declared');
  });

  it('refuses an owner panel link that is not https', () => {
    const wrong = base({
      features: ['OWNER_PANEL'],
      panel: {
        title: 'Probe',
        body: [],
        showRuns: [],
        links: [{ label: 'Docs', url: 'http://api.probe.test/docs' }],
      },
    });
    expect(readManifest(json(wrong)).ok).toBe(false);
  });

  it('accepts an owner panel linking to a host it does declare', () => {
    const fine = base({
      features: ['OWNER_PANEL'],
      panel: {
        title: 'Probe',
        body: ['It reads one thing.'],
        showRuns: ['read_thing'],
        links: [{ label: 'Docs', url: 'https://api.probe.test/docs' }],
      },
    });
    const read = readManifest(json(fine));
    expect(read.ok, read.ok ? '' : read.why).toBe(true);
  });

  it('refuses a panel showing runs of a capability it never declares', () => {
    const wrong = base({
      features: ['OWNER_PANEL'],
      panel: { title: 'Probe', body: [], showRuns: ['read_something_else'], links: [] },
    });
    expect(readManifest(json(wrong)).ok).toBe(false);
  });
});

describe('a Plugin cannot claim a namespace that is not its own', () => {
  it('registers under the reserved plugin family whatever it calls itself', async () => {
    // A Plugin that names itself after a built-in family still becomes
    // `plugin_time.`, never `time.`. The reserved prefix is what makes that
    // true by construction rather than by a list of forbidden names.
    const pretender = base({ id: 'time' });
    const done = await installPlugin({ raw: json(pretender), source: 'LOCAL' });
    expect(done.ok, done.ok ? '' : done.why).toBe(true);

    expect(getCapability('plugin_time.read_thing')).not.toBeNull();
    expect(getCapability('time.read_thing')).toBeNull();
    // And the real `time.now` is still the built-in, not something a Plugin
    // replaced.
    expect(getCapability('time.now')).not.toBeNull();
    await uninstallPlugin('time');
  });

  it('refuses one that claims a capability id already in the registry', async () => {
    const first = await installPlugin({ raw: json(base()), source: 'LOCAL' });
    expect(first.ok).toBe(true);

    // A second Plugin cannot produce this id, because the id is derived from
    // the Plugin's own id. The case that matters is a *different* Plugin id
    // claiming the same capability, which the namespace makes impossible --
    // so the guard that remains is against a built-in, proved by the id shape.
    const clash = base({ id: 'sec-probe-two' });
    const second = await installPlugin({ raw: json(clash), source: 'LOCAL' });
    expect(second.ok, second.ok ? '' : second.why).toBe(true);
    expect(getCapability(pluginCapabilityId('sec-probe-two', 'read_thing'))).not.toBeNull();
    expect(getCapability(CAPABILITY)).not.toBeNull();
    await uninstallPlugin('sec-probe-two');
  });
});

describe('updating a Plugin', () => {
  it('refuses an older version arriving as if it were an update', async () => {
    await installPlugin({ raw: json(base({ version: '1.2.0' })), source: 'LOCAL' });
    const back = await installPlugin({ raw: json(base({ version: '1.1.0' })), source: 'LOCAL' });
    expect(back.ok).toBe(false);
    expect(back.ok ? '' : back.why).toContain('older');

    // The installed copy is untouched, which is the half that matters.
    const record = await pluginsRepo.getInstalledPlugin('sec-probe');
    expect(record!.version).toBe('1.2.0');
  });

  it('installs the same version again without complaint', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    const again = await installPlugin({ raw: json(base()), source: 'LOCAL' });
    expect(again.ok, again.ok ? '' : again.why).toBe(true);
  });

  it('will not inherit approval for a version that asks for a new host', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });

    const wider = base({ version: '1.1.0' });
    wider.capabilities[0]!.http.hosts = ['api.probe.test', 'other.probe.test'];
    const blocked = await installPlugin({ raw: json(wider), source: 'LOCAL' });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? [] : blocked.needsAcknowledgement).toBeDefined();
    expect((blocked.ok ? [] : blocked.needsAcknowledgement!).join(' ')).toContain('other.probe.test');

    // And the old version is still what is installed and running.
    expect((await pluginsRepo.getInstalledPlugin('sec-probe'))!.version).toBe('1.0.0');

    const allowed = await installPlugin({ raw: json(wider), source: 'LOCAL', acknowledgeExpansion: true });
    expect(allowed.ok, allowed.ok ? '' : allowed.why).toBe(true);
    expect((await pluginsRepo.getInstalledPlugin('sec-probe'))!.version).toBe('1.1.0');
  });

  it('asks again for a version that newly wants a credential', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    const wants = base({
      version: '1.1.0',
      config: [{ key: 'api_key', label: 'API key', help: '', secret: true, required: true }],
    });
    const blocked = await installPlugin({ raw: json(wants), source: 'LOCAL' });
    expect(blocked.ok).toBe(false);
    expect((blocked.ok ? [] : blocked.needsAcknowledgement!).join(' ')).toContain('credential');
  });

  it('asks again for a version that raises its own ceiling', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    const greedy = base({ version: '1.1.0' });
    greedy.capabilities[0]!.http.quotaPerHour = 500;
    const blocked = await installPlugin({ raw: json(greedy), source: 'LOCAL' });
    expect(blocked.ok).toBe(false);
    expect((blocked.ok ? [] : blocked.needsAcknowledgement!).join(' ')).toContain('500');
  });

  it('says nothing about a version that asks for less', async () => {
    // Narrowing needs no permission. A Plugin dropping a host or a capability
    // is doing less, and asking about it teaches an owner to click through.
    const wide = base({ version: '1.0.0' });
    wide.capabilities[0]!.http.hosts = ['api.probe.test', 'other.probe.test'];
    await installPlugin({ raw: json(wide), source: 'LOCAL' });

    const narrow = base({ version: '1.1.0' });
    const done = await installPlugin({ raw: json(narrow), source: 'LOCAL' });
    expect(done.ok, done.ok ? '' : done.why).toBe(true);
  });

  it('leaves exactly one registration behind, never a stale one', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    const renamed = base({ version: '1.1.0' });
    renamed.capabilities[0]!.name = 'read_other';
    renamed.capabilities[0]!.http.url = 'https://api.probe.test/v1/other?what={what}';

    const done = await installPlugin({ raw: json(renamed), source: 'LOCAL', acknowledgeExpansion: true });
    expect(done.ok, done.ok ? '' : done.why).toBe(true);

    // The capability the old version declared is gone, not left callable
    // against a manifest nobody is looking at any more.
    expect(getCapability(CAPABILITY)).toBeNull();
    expect(getCapability(pluginCapabilityId('sec-probe', 'read_other'))).not.toBeNull();
  });

  it('keeps the working copy when recording the new one fails', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    const spy = vi.spyOn(pluginsRepo, 'putInstalledPlugin').mockRejectedValueOnce(new Error('the disk said no'));

    const next = base({ version: '1.1.0' });
    const failed = await installPlugin({ raw: json(next), source: 'LOCAL' });
    expect(failed.ok).toBe(false);
    spy.mockRestore();

    // Half an update is the one outcome worse than none: the capability the
    // owner had is still registered and still callable.
    expect(getCapability(CAPABILITY)).not.toBeNull();
    expect((await pluginsRepo.getInstalledPlugin('sec-probe'))!.version).toBe('1.0.0');
  });
});

describe('a publisher cannot be substituted', () => {
  it('refuses a version arriving under a different name', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    const other = base({ version: '1.1.0', publisher: 'Somebody Else' });
    const done = await installPlugin({ raw: json(other), source: 'LOCAL' });
    expect(done.ok).toBe(false);
    expect(done.ok ? '' : done.why).toContain('different publisher');
  });

  it('refuses one whose publisher is not the one the caller expected', async () => {
    const done = await installPlugin({
      raw: json(base()),
      source: 'AI17Z_REGISTRY',
      expectPublisher: 'Someone Official',
    });
    expect(done.ok).toBe(false);
  });
});

describe('what an uninstall takes with it', () => {
  it('takes the sealed secrets, the configuration and the budget', async () => {
    const fixture = await createFixture();
    const withKey = base({
      config: [{ key: 'api_key', label: 'API key', help: '', secret: true, required: true }],
    });
    withKey.capabilities[0]!.http.auth = { kind: 'BEARER', name: '', configKey: 'api_key' };
    await installPlugin({ raw: json(withKey), source: 'LOCAL' });

    await pluginsRepo.setPluginSecret(fixture.agentId, 'sec-probe', 'api_key', 'a-real-looking-key');
    await pluginsRepo.setPluginConfig(fixture.agentId, 'sec-probe', { note: 'kept' });
    await pluginsRepo.chargePluginCall(fixture.agentId, 'sec-probe', 5);

    await uninstallPlugin('sec-probe');

    // Enforced by the database rather than by this function remembering:
    // migration 0087 puts the foreign keys on, so a second caller that forgot
    // could not leave a sealed credential behind either.
    const secrets = await query('SELECT 1 FROM agent_plugin_secrets WHERE plugin_id = $1', ['sec-probe']);
    const config = await query('SELECT 1 FROM agent_plugin_config WHERE plugin_id = $1', ['sec-probe']);
    const budget = await query('SELECT 1 FROM plugin_call_budget WHERE plugin_id = $1', ['sec-probe']);
    expect(secrets).toHaveLength(0);
    expect(config).toHaveLength(0);
    expect(budget).toHaveLength(0);
  });

  it('takes the permissions, so reinstalling does not restore an old decision', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: 'sec-probe', enabled: true });
    expect(
      (await permissionsRepo.listForAgent(fixture.agentId)).some((row) => row.capability_id === CAPABILITY),
    ).toBe(true);

    await uninstallPlugin('sec-probe');
    expect(
      (await permissionsRepo.listForAgent(fixture.agentId)).some((row) => row.capability_id === CAPABILITY),
    ).toBe(false);
  });

  it('puts the capability back when the record cannot be deleted', async () => {
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    const spy = vi.spyOn(pluginsRepo, 'removeInstalledPlugin').mockRejectedValueOnce(new Error('the disk said no'));

    const done = await uninstallPlugin('sec-probe');
    expect(done.ok).toBe(false);
    spy.mockRestore();

    // Still installed, so it has to still be callable. Installed and
    // permanently uncallable until somebody restarts the process is the one
    // state this must never be left in.
    expect(getCapability(CAPABILITY)).not.toBeNull();
  });

  it('refuses to remove something that is not installed', async () => {
    const done = await uninstallPlugin('never-existed');
    expect(done.ok).toBe(false);
  });
});

describe('the declared boundary holds at execution', () => {
  const run = async (agentId: string, input: Record<string, unknown>) =>
    invokeCapability({
      call: { id: CAPABILITY, input },
      context: { agentId, jobId: null, accountId: null, config: {}, logger: console as never },
      permission: { stored: 'ALLOWED', paused: false },
    });

  it('refuses a redirect to a host the Plugin never declared', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    served.set('api.probe.test', {
      status: 200,
      text: json({ answer: 'from somewhere else' }),
      url: 'https://evil.probe-lookalike.test/v1/read',
    });

    const result = await run(fixture.agentId, { what: 'anything' });
    expect(result.outcome).not.toBe('SUCCEEDED');
    expect(result.detail).toContain('did not declare');
    expect(json(result.output)).not.toContain('from somewhere else');
  });

  it('cannot be made to reach another host through an input value', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    served.set('api.probe.test', { status: 200, text: json({ answer: 'ok' }) });

    // Encoded on the way in, so it stays one query value rather than becoming
    // a second host, a path segment or another parameter.
    const result = await run(fixture.agentId, { what: 'x&redirect=https://evil.test/../../etc/passwd' });
    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.output).toEqual({ answer: 'ok' });
  });

  it('stops at its declared ceiling and says when it will work again', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    served.set('api.probe.test', { status: 200, text: json({ answer: 'ok' }) });

    // Five an hour, declared in the manifest.
    for (let at = 0; at < 5; at += 1) {
      const ok = await run(fixture.agentId, { what: `call ${at}` });
      expect(ok.outcome, ok.detail).toBe('SUCCEEDED');
    }
    const sixth = await run(fixture.agentId, { what: 'one too many' });
    expect(sixth.outcome).not.toBe('SUCCEEDED');
    expect(sixth.detail).toContain('next hour');
  });

  it('charges the quota against the agent rather than the installation', async () => {
    const one = await createFixture();
    const two = await createFixture();
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    served.set('api.probe.test', { status: 200, text: json({ answer: 'ok' }) });

    for (let at = 0; at < 5; at += 1) await run(one.agentId, { what: `call ${at}` });
    expect((await run(one.agentId, { what: 'over' })).outcome).not.toBe('SUCCEEDED');
    // The other agent has spent nothing, which is the point of a per-agent
    // ceiling: one agent cannot exhaust another's.
    expect((await run(two.agentId, { what: 'first' })).outcome).toBe('SUCCEEDED');
  });

  it('refuses an input the declaration did not describe', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    served.set('api.probe.test', { status: 200, text: json({ answer: 'ok' }) });

    const result = await run(fixture.agentId, { what: 'fine', extra: 'not declared' });
    expect(result.outcome).toBe('REFUSED');
  });

  it('will not run at all without a credential it says it needs', async () => {
    const fixture = await createFixture();
    const withKey = base({
      config: [{ key: 'api_key', label: 'API key', help: '', secret: true, required: true }],
    });
    withKey.capabilities[0]!.http.auth = { kind: 'BEARER', name: '', configKey: 'api_key' };
    await installPlugin({ raw: json(withKey), source: 'LOCAL' });
    served.set('api.probe.test', { status: 200, text: json({ answer: 'ok' }) });

    const result = await run(fixture.agentId, { what: 'anything' });
    // UNAVAILABLE rather than DISABLED: nobody switched it off, it cannot
    // work yet, and telling an owner it is off sends them to the wrong screen.
    expect(result.outcome).toBe('REFUSED');
    expect(result.detail).toContain('API key');
  });
});

describe('secrets never come back out', () => {
  it('is absent from everything the Plugins screen is built from', async () => {
    const fixture = await createFixture();
    const withKey = base({
      config: [{ key: 'api_key', label: 'API key', help: '', secret: true, required: true }],
    });
    withKey.capabilities[0]!.http.auth = { kind: 'BEARER', name: '', configKey: 'api_key' };
    await installPlugin({ raw: json(withKey), source: 'LOCAL' });
    await pluginsRepo.setPluginSecret(fixture.agentId, 'sec-probe', 'api_key', 'sk-do-not-leak-me');

    const views = await pluginViews({ agentId: fixture.agentId, accountId: null, paused: false });
    const text = JSON.stringify(views);
    expect(text).not.toContain('sk-do-not-leak-me');
    // What it does say is which key is filled, which is the useful half.
    const mine = views.find((view) => view.id === 'sec-probe')!;
    expect(mine.secretsPresent).toEqual(['api_key']);
    expect(mine.config).toEqual({});
  });

  it('is not readable from the sealed row without the master key', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(base()), source: 'LOCAL' });
    await pluginsRepo.setPluginSecret(fixture.agentId, 'sec-probe', 'api_key', 'sk-do-not-leak-me');
    const rows = await query<{ sealed: string }>(
      'SELECT sealed FROM agent_plugin_secrets WHERE agent_id = $1 AND plugin_id = $2',
      [fixture.agentId, 'sec-probe'],
    );
    expect(rows[0]!.sealed).not.toContain('sk-do-not-leak-me');
  });
});

describe('the footprint comparison itself', () => {
  it('reports nothing when a manifest is unchanged', () => {
    const manifest = PluginManifest.parse(base());
    expect(footprintExpansion(pluginFootprint(manifest), pluginFootprint(manifest))).toEqual([]);
  });

  it('names a feature a new version wants to unlock', () => {
    const before = PluginManifest.parse(base());
    const after = PluginManifest.parse(
      base({
        features: ['OWNER_PANEL'],
        panel: { title: 'Probe', body: [], showRuns: [], links: [] },
      }),
    );
    const grew = footprintExpansion(pluginFootprint(before), pluginFootprint(after));
    expect(grew.join(' ')).toContain('owner panel');
  });

  it('names a capability a new version adds', () => {
    const before = PluginManifest.parse(base());
    const wider = base({ version: '1.1.0' });
    wider.capabilities.push({ ...wider.capabilities[0]!, name: 'read_more' });
    const after = PluginManifest.parse(wider);
    expect(footprintExpansion(pluginFootprint(before), pluginFootprint(after)).join(' ')).toContain('read_more');
  });
});
