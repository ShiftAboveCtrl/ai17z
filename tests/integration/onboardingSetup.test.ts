import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { agents as agentsRepo, providers as providersRepo } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

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
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-1234' },
  });
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}

/**
 * Setting an agent up must leave behind what it says it left behind.
 *
 * The onboarding flow had a chain of five linked defects, each individually
 * small: the primary model was written only inside the provider test handler,
 * so typing one and pressing Continue discarded it; DeepSeek returns no default
 * model, so testing before typing left no model at all; the screen reported
 * "Connected" either way; the character builder two steps later failed on the
 * model that was never set; and going back to repair it hit the
 * `(owner_id, label)` unique index and surfaced as a raw 500 carrying the
 * constraint name, on a screen with no way to edit the label.
 *
 * These pin the halves that live on the server. The parts that live in the
 * browser -- which control writes the model, and what the review screen reads --
 * are covered by the walkthrough.
 */
describe('connecting a provider is repeatable', () => {
  it('returns the same credential rather than failing on the second connect', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const label = `DeepSeek-${uniqueSuffix()}`;

    const first = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: auth,
      payload: { provider: 'deepseek', label, apiKey: 'sk-first' },
    });
    expect(first.statusCode, first.body).toBe(200);

    // Stepping back and pressing connect again is the same intent, not a
    // request for a second credential.
    const second = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: auth,
      payload: { provider: 'deepseek', label, apiKey: 'sk-second' },
    });

    expect(second.statusCode, second.body).toBe(200);
    const firstId = (first.json() as { data: { id: string } }).data.id;
    const secondId = (second.json() as { data: { id: string } }).data.id;
    // The same row: model_configs point at this id, and replacing it would
    // orphan every role already assigned.
    expect(secondId).toBe(firstId);
  });

  it('never leaks the database constraint to the caller', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const label = `Repeat-${uniqueSuffix()}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/providers',
        headers: auth,
        payload: { provider: 'deepseek', label, apiKey: 'sk-x' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('duplicate key');
      expect(response.body).not.toContain('provider_credentials_owner_id_label_key');
      expect(response.body).not.toContain('violates unique constraint');
    }
  });

  it('keeps the stored key when a reconnect does not supply one', async () => {
    // Re-testing a connection must not wipe the key that made it work.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const label = `Keep-${uniqueSuffix()}`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: auth,
      payload: { provider: 'deepseek', label, apiKey: 'sk-keep-this' },
    });
    const id = (created.json() as { data: { id: string } }).data.id;

    await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: auth,
      payload: { provider: 'deepseek', label, apiKey: null },
    });

    expect(await providersRepo.getDecryptedApiKey(id)).toBe('sk-keep-this');
  });
});

describe('a credential that works is not an agent that can think', () => {
  it('reports the model as missing until a primary role exists', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const agent = await agentsRepo.getAgent(fixture.agentId);

    // The fixture agent has a model; drop it to model the real setup state,
    // where the credential exists and no role has been assigned.
    await providersRepo.deleteModelConfig(agent!.id, 'primary');

    const preflight = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent!.id}/preflight`,
      headers: auth,
    });
    const { data } = preflight.json() as { data: { ready: boolean; blockers: { what: string }[] } };

    expect(data.ready).toBe(false);
    expect(data.blockers.map((b) => b.what).join(' ')).toMatch(/no ai model is connected/i);
  });

  it('stops reporting it once the primary model is stored', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    const preflight = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/preflight`,
      headers: auth,
    });
    const { data } = preflight.json() as { data: { blockers: { what: string }[] } };

    expect(data.blockers.map((b) => b.what).join(' ')).not.toMatch(/no ai model is connected/i);
  });
});

describe('a model id is stored exactly as the provider spells it', () => {
  it('round-trips without prettification', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/models`,
      headers: auth,
      payload: {
        role: 'primary',
        providerCredentialId: fixture.providerId,
        model: 'deepseek-v4-pro',
        parameters: {},
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const read = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/models`,
      headers: auth,
    });
    const { data } = read.json() as { data: { items: { role: string; model: string }[] } };
    const primary = data.items.find((m) => m.role === 'primary');

    // Not "Deepseek-V4-Pro". A title-cased id is no longer an id.
    expect(primary?.model).toBe('deepseek-v4-pro');
  });
});
