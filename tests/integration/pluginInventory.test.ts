import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { pluginsAndCore } from '@xbam/runtime';
import {
  listCapabilities,
  packFor,
  registerBuiltinCapabilities,
  resetCapabilitiesForTest,
} from '@xbam/tools';
import {
  registerChainCapabilities,
  registerReferenceCapabilities,
  registerXCapabilities,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The Plugins screen has to account for every capability, not most of them.
 *
 * Grouping the registry into six Plugins is the right product answer and it
 * hid three capabilities completely: `time.now`, `memory.search` and
 * `agent.diagnostics` belong to no pack, so a screen built only from packs
 * never mentioned them. The owner noticed, which is the wrong way to find it.
 *
 * The rule pinned here is the one that matters and does not depend on the
 * current count: **grouped plus ungrouped is everything registered**, with no
 * capability in both and none invented. It keeps holding when a seventh pack
 * or a hundredth capability arrives.
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
  const body = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${body.data.token}` };
}

beforeEach(() => {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  // Families on both sides of the line: `reference`/`x`/`chain` belong to
  // packs, and the three built-ins belong to none.
  registerReferenceCapabilities();
  registerXCapabilities();
  registerChainCapabilities();
});

describe('every registered capability is accounted for', () => {
  it('grouped plus ungrouped is the whole registry, with nothing counted twice', async () => {
    const fixture = await createFixture();
    const { plugins, core } = await pluginsAndCore({
      agentId: fixture.agentId,
      accountId: null,
      paused: false,
    });

    const grouped = plugins.flatMap((plugin) => plugin.capabilities.map((capability) => capability.id));
    const ungrouped = core.map((capability) => capability.id);
    const seen = [...grouped, ...ungrouped];
    const registered = listCapabilities().map((capability) => capability.id);

    expect(new Set(seen).size, 'a capability appears under two owners').toBe(seen.length);
    expect(seen.slice().sort()).toEqual(registered.slice().sort());
  });

  it('puts a capability in no pack into core rather than dropping it', async () => {
    const fixture = await createFixture();
    const { core } = await pluginsAndCore({ agentId: fixture.agentId, accountId: null, paused: false });
    const expected = listCapabilities()
      .filter((capability) => packFor(capability.id) === null)
      .map((capability) => capability.id)
      .sort();

    expect(expected.length, 'this test proves nothing if every capability is in a pack').toBeGreaterThan(0);
    expect(core.map((capability) => capability.id).sort()).toEqual(expected);
  });

  it('gives a core capability everything a grouped one has', async () => {
    // The row is rendered by the same component, so a core capability missing
    // its permission or status would render as a blank switch.
    const fixture = await createFixture();
    const { core } = await pluginsAndCore({ agentId: fixture.agentId, accountId: null, paused: false });
    for (const capability of core) {
      expect(typeof capability.permission, capability.id).toBe('string');
      expect(typeof capability.status, capability.id).toBe('string');
      expect(typeof capability.effect, capability.id).toBe('string');
      expect(capability.lastUsedAt === null || typeof capability.lastUsedAt === 'string').toBe(true);
    }
  });

  it('serves both halves over HTTP, which is what the screen reads', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const response = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/plugins`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { data } = response.json() as {
      data: { plugins: { capabilities: { id: string }[] }[]; core: { id: string }[] };
    };

    const total =
      data.plugins.reduce((n, plugin) => n + plugin.capabilities.length, 0) + data.core.length;
    expect(total).toBe(listCapabilities().length);
    expect(data.core.length).toBeGreaterThan(0);
  });
});
