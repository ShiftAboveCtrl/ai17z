import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityInvocations, plugins as pluginsRepo } from '@xbam/database';
import {
  capabilitySettings,
  installPlugin,
  pluginPanels,
  pluginResearchSources,
  pluginViews,
  research,
  setPluginEnabled,
  uninstallPlugin,
} from '@xbam/runtime';
import { buildVersion, pluginCapabilityId } from '@xbam/shared';
import { registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { setCapabilityPermission } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * The two things a Plugin may unlock, proved to go through the canonical path.
 *
 * The property worth pinning is not that a research source returns a finding.
 * It is that it returns one *through `invokeCapability`*, so an owner who
 * switched the Plugin off has switched the source off without anybody having
 * written a check for that, the quota applies, the allowlist applies, and the
 * call is audited. A feature that reached the network by another route would
 * pass a happy-path test and be a second, ungoverned way out of this process.
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

const core = buildVersion().version.replace(/-.*$/, '');
const json = (value: unknown) => JSON.stringify(value);
const PLUGIN_ID = 'almanac';
const CAPABILITY = pluginCapabilityId(PLUGIN_ID, 'look_up');

const ALMANAC = {
  schemaVersion: 1,
  id: PLUGIN_ID,
  name: 'Almanac',
  summary: 'Looks a term up in a reference almanac, as a research source.',
  publisher: 'AI17Z Test',
  version: '1.0.0',
  compatibility: { minimum: core },
  kind: 'FEATURE',
  homepage: 'https://almanac.test/about',
  config: [],
  capabilities: [
    {
      name: 'look_up',
      title: 'Look something up',
      description: 'Looks a term up in the almanac and returns what it says about it.',
      category: 'RESEARCH',
      effect: 'READ',
      risk: 'LOW',
      input: { fields: [{ name: 'term', type: 'string', required: true, describe: 'What to look up' }] },
      output: {
        fields: [
          { name: 'heading', type: 'string', from: 'entry.title' },
          { name: 'body', type: 'string', from: 'entry.text' },
          { name: 'where', type: 'string', from: 'entry.url' },
        ],
      },
      http: {
        method: 'GET',
        url: 'https://api.almanac.test/v1/entry?term={term}',
        hosts: ['api.almanac.test'],
        timeoutMs: 5_000,
        quotaPerHour: 20,
      },
    },
  ],
  features: ['RESEARCH_SOURCE', 'OWNER_PANEL'],
  research: {
    capability: 'look_up',
    queryField: 'term',
    title: 'heading',
    summary: 'body',
    url: 'where',
    sourceName: 'The Almanac',
  },
  panel: {
    title: 'Almanac',
    body: ['Looks terms up in a reference almanac.', 'It reads and never writes.'],
    showRuns: ['look_up'],
    links: [{ label: 'About the almanac', url: 'https://almanac.test/about' }],
  },
};

const answers = () =>
  served.set('api.almanac.test', {
    status: 200,
    text: json({ entry: { title: 'Hysteresis', text: 'A lag between cause and effect.', url: 'https://almanac.test/h' } }),
  });

async function sourcesFor(agentId: string) {
  const settings = await capabilitySettings(agentId);
  return pluginResearchSources({
    agentId,
    jobId: null,
    accountId: null,
    permissions: settings.permissions,
    paused: false,
    logger: console,
  });
}

beforeEach(async () => {
  served.clear();
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  for (const record of await pluginsRepo.listInstalledPlugins()) {
    await pluginsRepo.removeInstalledPlugin(record.id);
  }
});

describe('a Plugin offered as a research source', () => {
  it('answers a lookup, attributed to itself rather than to the agent', async () => {
    const fixture = await createFixture();
    expect((await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' })).ok).toBe(true);
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    answers();

    const sources = await sourcesFor(fixture.agentId);
    expect(sources.map((source) => source.sourceName)).toEqual(['The Almanac']);

    const result = await research(
      [{ kind: 'search', query: 'hysteresis', reason: 'they asked what it means' }],
      // No browser, so the Plugin is the only source there is. That is the
      // case worth proving: a finding arriving from a Plugin and nothing else.
      { extraSources: sources },
    );

    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding!.source).toBe('The Almanac');
    expect(finding!.title).toBe('Hysteresis');
    expect(finding!.summary).toContain('lag between cause and effect');
    expect(finding!.url).toBe('https://almanac.test/h');
    // A Plugin answering is not a gap, and "no browser was available" must not
    // appear beside a finding: the model hedges when it reads that.
    expect(result.failed).toHaveLength(0);
  });

  it('is audited like every other capability', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    answers();

    const sources = await sourcesFor(fixture.agentId);
    await research([{ kind: 'search', query: 'hysteresis', reason: 'asked' }], { extraSources: sources });

    const rows = await capabilityInvocations.listForAgent(fixture.agentId, 20);
    const row = rows.find((entry) => entry.capabilityId === CAPABILITY);
    expect(row, 'a research source ran and was not recorded').toBeDefined();
    expect(row!.outcome).toBe('SUCCEEDED');
  });

  it('is not offered at all once the owner turns the Plugin off', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    expect(await sourcesFor(fixture.agentId)).toHaveLength(1);

    // The Plugins screen writes one row, and that row is what this reads.
    // There is no second switch for "may it be a research source".
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: false });
    expect(await sourcesFor(fixture.agentId)).toHaveLength(0);
  });

  it('is skipped rather than held when the owner set it to ask first', async () => {
    // There is nobody to ask inside a reply being written now, and holding one
    // would stall the pipeline behind a question read tomorrow -- then be
    // abandoned as a timeout, which is not what happened.
    const fixture = await createFixture();
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    await setCapabilityPermission({
      agentId: fixture.agentId,
      capabilityId: CAPABILITY,
      permission: 'OWNER_APPROVAL',
    });
    expect(await sourcesFor(fixture.agentId)).toHaveLength(0);
  });

  it('reports a gap under its own name when it has nothing', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    served.set('api.almanac.test', { status: 200, text: json({ entry: {} }) });

    const sources = await sourcesFor(fixture.agentId);
    const result = await research([{ kind: 'search', query: 'nothing', reason: 'asked' }], {
      extraSources: sources,
    });
    expect(result.findings).toHaveLength(0);
    // Named, so the model is told which source had nothing rather than being
    // handed an empty heading it will treat as a fact it misread.
    expect(result.failed[0]!.reason).toContain('The Almanac');
  });

  it('still obeys the allowlist when it is reached as a source', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    served.set('api.almanac.test', {
      status: 200,
      text: json({ entry: { title: 'Elsewhere', text: 'From off the allowlist.' } }),
      url: 'https://not-the-almanac.test/v1/entry',
    });

    const sources = await sourcesFor(fixture.agentId);
    const result = await research([{ kind: 'search', query: 'hysteresis', reason: 'asked' }], {
      extraSources: sources,
    });
    expect(result.findings).toHaveLength(0);
    expect(json(result)).not.toContain('From off the allowlist');
  });

  it('stops being a source when the Plugin is removed', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    await setPluginEnabled({ agentId: fixture.agentId, pluginId: PLUGIN_ID, enabled: true });
    await uninstallPlugin(PLUGIN_ID);
    expect(await sourcesFor(fixture.agentId)).toHaveLength(0);
  });
});

describe('a Plugin owner panel', () => {
  it('is data and nothing else', async () => {
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    const panels = await pluginPanels();
    expect(panels).toHaveLength(1);
    const [panel] = panels;
    expect(panel!.panel.title).toBe('Almanac');
    expect(panel!.panel.body).toHaveLength(2);
    // The runs it asks to show are resolved to canonical capability ids, so
    // the route filters this agent's own history rather than trusting a name.
    expect(panel!.runsOf).toEqual([CAPABILITY]);
    // No markup anywhere in what reaches the screen.
    expect(json(panel)).not.toMatch(/<\/?[a-z]/i);
  });

  it('travels on the Plugin view, so the card and the panel agree', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    const views = await pluginViews({ agentId: fixture.agentId, accountId: null, paused: false });
    const mine = views.find((view) => view.id === PLUGIN_ID)!;
    expect(mine.features).toEqual(['RESEARCH_SOURCE', 'OWNER_PANEL']);
    expect(mine.researchSourceName).toBe('The Almanac');
    expect(mine.panel!.title).toBe('Almanac');
  });

  it('is gone when the Plugin is', async () => {
    await installPlugin({ raw: json(ALMANAC), source: 'LOCAL' });
    await uninstallPlugin(PLUGIN_ID);
    expect(await pluginPanels()).toHaveLength(0);
  });
});
