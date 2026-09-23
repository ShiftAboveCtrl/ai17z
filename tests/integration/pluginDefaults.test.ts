import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { capabilityPermissions as permissionsRepo } from '@xbam/database';
import { CORE_RECOMMENDED_PACKS, applyCoreRecommended } from '@xbam/runtime';
import { defaultPermission } from '@xbam/shared/contracts';
import {
  TOOLPACKS,
  capabilitiesInPack,
  listCapabilities,
  registerBuiltinCapabilities,
  resetCapabilitiesForTest,
} from '@xbam/tools';
import {
  registerChainCapabilities,
  registerFeedCapabilities,
  registerReferenceCapabilities,
  registerWebHistoryCapabilities,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * What a brand new agent starts able to reach for, proved through the route
 * that actually creates one.
 *
 * `applyCoreRecommended` had no caller when it was written, so every agent
 * created by the product started with no permission rows at all and fell back
 * to each capability's own default -- which is a different set, and one an
 * owner could not see on the Plugins screen because there was nothing there to
 * read. A default nothing applies is a decision nobody made.
 *
 * The other half matters more: this must never touch an agent that already has
 * choices. An owner who switched something off and found it back on after an
 * upgrade has been overruled by a program.
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
  // Enough families for the recommended set and one that is deliberately not
  // in it, so "switched this on and nothing else" is a claim with two sides.
  registerReferenceCapabilities();
  registerWebHistoryCapabilities();
  registerFeedCapabilities();
  registerChainCapabilities();
});

describe('creating an agent through the product', () => {
  it('writes the recommended decisions, explicitly', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);

    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers,
      payload: { name: 'Brand New' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const { data } = created.json() as { data: { id: string } };

    const rows = await permissionsRepo.listForAgent(data.id);
    // Explicit rows rather than an absence that happens to mean the same
    // thing, so the Plugins screen on day one shows what the runtime will do.
    expect(rows.length).toBe(listCapabilities().length);

    const permission = (id: string) => rows.find((row) => row.capability_id === id)?.permission;
    for (const pack of CORE_RECOMMENDED_PACKS) {
      for (const capability of capabilitiesInPack(pack)) {
        expect(permission(capability.id), capability.id).toBe(
          defaultPermission(capability.effect, capability.risk),
        );
      }
    }
    // The clock and its own memory, which belong to no pack.
    expect(permission('time.now')).toBe('ALLOWED');
    expect(permission('memory.search')).toBe('ALLOWED');
  });

  it('leaves everything that was not recommended switched off', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers,
      payload: { name: 'Brand New' },
    });
    const { data } = created.json() as { data: { id: string } };
    const rows = await permissionsRepo.listForAgent(data.id);

    // Crypto is deliberately not recommended: it is financial, and switching
    // it on for somebody who has not asked is making their decision.
    const chain = capabilitiesInPack('crypto');
    expect(chain.length).toBeGreaterThan(0);
    for (const capability of chain) {
      expect(rows.find((row) => row.capability_id === capability.id)?.permission, capability.id).toBe('DISABLED');
    }
  });

  it('switches nothing on that writes', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers,
      payload: { name: 'Brand New' },
    });
    const { data } = created.json() as { data: { id: string } };
    const rows = await permissionsRepo.listForAgent(data.id);

    for (const capability of listCapabilities()) {
      if (capability.effect !== 'WRITE') continue;
      const permission = rows.find((row) => row.capability_id === capability.id)?.permission;
      expect(permission, capability.id).not.toBe('ALLOWED');
    }
  });

  it('shows the agent on the Plugins screen with those decisions in it', async () => {
    // The point of writing them explicitly. Before this, a new agent's Plugins
    // screen was computed from an empty table.
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers,
      payload: { name: 'Brand New' },
    });
    const { data } = created.json() as { data: { id: string } };

    const screen = await app.inject({ method: 'GET', url: `/api/agents/${data.id}/plugins`, headers });
    expect(screen.statusCode, screen.body).toBe(200);
    const view = screen.json() as { data: { plugins: { id: string; state: string }[] } };
    const byId = new Map(view.data.plugins.map((plugin) => [plugin.id, plugin.state]));
    expect(byId.get('reference')).toBe('ON');
    expect(byId.get('web')).toBe('ON');
    expect(byId.get('crypto')).toBe('OFF');
  });
});

describe('an agent that already has decisions', () => {
  it('is never overwritten', async () => {
    const fixture = await createFixture();
    await permissionsRepo.set({
      agentId: fixture.agentId,
      capabilityId: 'reference.look_up',
      permission: 'DISABLED',
    });

    await applyCoreRecommended(fixture.agentId);

    const rows = await permissionsRepo.listForAgent(fixture.agentId);
    // Still off, and still the only row. An owner's choice is not a starting
    // point to be improved on.
    expect(rows.find((row) => row.capability_id === 'reference.look_up')?.permission).toBe('DISABLED');
    expect(rows).toHaveLength(1);
  });

  it('is left alone when it is called twice', async () => {
    const fixture = await createFixture();
    await applyCoreRecommended(fixture.agentId);
    await permissionsRepo.set({
      agentId: fixture.agentId,
      capabilityId: 'reference.look_up',
      permission: 'DISABLED',
    });
    // The second call is the upgrade case: something runs this again on an
    // installation that has been going for months.
    await applyCoreRecommended(fixture.agentId);

    const rows = await permissionsRepo.listForAgent(fixture.agentId);
    expect(rows.find((row) => row.capability_id === 'reference.look_up')?.permission).toBe('DISABLED');
  });
});

describe('the recommended set itself', () => {
  it('names only packs that exist', () => {
    for (const id of CORE_RECOMMENDED_PACKS) {
      expect(TOOLPACKS.some((pack) => pack.id === id), id).toBe(true);
    }
  });

  it('recommends nothing that writes and nothing that needs an account', () => {
    // The rule the set was chosen against, held against the set rather than
    // restated in a comment: read-only, and nothing that needs somebody to
    // connect an account or supply a credential first.
    for (const id of CORE_RECOMMENDED_PACKS) {
      for (const capability of capabilitiesInPack(id)) {
        expect(capability.effect, capability.id).toBe('READ');
      }
    }
    expect((CORE_RECOMMENDED_PACKS as readonly string[]).includes('x')).toBe(false);
    expect((CORE_RECOMMENDED_PACKS as readonly string[]).includes('filings')).toBe(false);
  });
});
