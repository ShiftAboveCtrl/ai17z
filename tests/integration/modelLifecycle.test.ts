import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { providers as providersRepo } from '@xbam/database';
import { staleModel } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

async function signIn(email: string): Promise<{ authorization: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}
const body = <T>(r: { json: () => unknown }): T => (r.json() as { data: T }).data;

/**
 * The quiet expensive failure: a provider that tests green while the agent is
 * pointed at a model that provider no longer offers. Every screen says
 * connected, the agent looks entirely healthy, and every generation fails.
 */
describe('a model an agent is pointed at', () => {
  it('travels with what its provider says it offers', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await providersRepo.updateProvider(fixture.providerId, { availableModels: ['mock-echo', 'mock-other'] });

    const detail = body<{ models: { model: string; providerModels: string[] }[] }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}`, headers: auth }),
    );
    const primary = detail.models.find((m) => m.model === 'mock-echo')!;
    expect(primary.providerModels).toContain('mock-echo');
  });

  it('is reported when the provider has stopped offering it', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    // The provider is retested and no longer lists the model this agent uses.
    await providersRepo.updateProvider(fixture.providerId, { availableModels: ['something-else'] });

    const detail = body<{ models: { model: string; providerModels: string[]; providerLabel: string; providerCheckedAt: string | null }[] }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}`, headers: auth }),
    );
    const primary = detail.models[0]!;
    const warning = staleModel(primary);
    expect(warning).toBeTruthy();
    expect(warning).toContain('mock-echo');
    // It says what it noticed, and names the two things it could mean. What it
    // may not do is pick one of them, which is what the sentence used to do.
    expect(warning).toMatch(/did not list/i);
    expect(warning).toMatch(/out of date/i);
    expect(warning).not.toMatch(/cannot generate/i);
    expect(warning).not.toMatch(/no longer offers/i);
  });

  /**
   * The list has an age, and the age is most of what an absence from it means.
   *
   * Measured on ai17z-test rather than imagined: the stored list was
   * `["deepseek-flash", "deepseek-v4-pro"]`, taken five days earlier and never
   * refreshed, and the screen carried a red "unavailable" chip against four of
   * the seven roles. `deepseek-v4-flash` had completed twelve calls in the
   * previous three hours. An owner reading that would have gone and
   * reconfigured four roles that worked.
   */
  it('says when the list it is judging against was taken', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await providersRepo.updateProvider(fixture.providerId, { availableModels: ['something-else'] });

    const detail = body<{
      models: { model: string; providerModels: string[]; providerLabel: string; providerCheckedAt: string | null }[];
    }>(await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}`, headers: auth }));

    const primary = detail.models[0]!;
    // Carried through the API rather than derived in the browser, so the
    // screen and the runtime are reading one fact.
    expect(primary).toHaveProperty('providerCheckedAt');

    expect(staleModel(primary)).toMatch(/last checked/i);

    // And with no date it still refuses to invent one.
    const undated = staleModel({ ...primary, providerCheckedAt: null });
    expect(undated).toMatch(/when it was last checked\./);
    expect(undated).not.toMatch(/Invalid Date/);
  });

  it('says nothing when the provider publishes no list', async () => {
    // Absence of a list is not evidence the model is gone, and guessing that
    // it is would mark every Anthropic agent broken.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await providersRepo.updateProvider(fixture.providerId, { availableModels: [] });

    const detail = body<{ models: { model: string; providerModels: string[]; providerLabel: string; providerCheckedAt: string | null }[] }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}`, headers: auth }),
    );
    expect(staleModel(detail.models[0]!)).toBeNull();
  });

  it('removing a model from an agent leaves the provider alone', async () => {
    // Two different operations. Removing a model from one agent must not
    // delete a credential other agents are using.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${fixture.agentId}/models/primary`,
      headers: auth,
    });
    expect([200, 204]).toContain(removed.statusCode);

    expect(await providersRepo.getProvider(fixture.providerId)).not.toBeNull();
    const detail = body<{ models: { role: string }[] }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}`, headers: auth }),
    );
    expect(detail.models.some((m) => m.role === 'primary')).toBe(false);
  });
});
