import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { PERSONA_LIMITS } from '@xbam/shared/contracts';
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

const persona = (over: Record<string, unknown> = {}) => ({
  identityKind: 'FICTIONAL',
  displayName: 'Scratch',
  biography: '',
  personality: '',
  tone: '',
  styleGuidelines: '',
  styleExamples: [],
  topics: [],
  languagePolicy: '',
  responseLength: 'SHORT',
  prohibitedBehaviors: [],
  customInstructions: '',
  changeNote: '',
  ...over,
});

/**
 * Pressing save and being told "the request body did not match the expected
 * shape" is a dead end. Somebody who wrote a long personality has no way to
 * learn which of eleven fields was too long, or by how much, and the difference
 * between 2,000 and 2,341 characters is not visible in a text box.
 */
describe('when a field is refused', () => {
  it('names the field, the size, the limit and the overage', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const over = 341;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({ personality: 'x'.repeat(PERSONA_LIMITS.personality + over) }),
    });

    expect(response.statusCode).toBe(422);
    const message = (response.json() as { error: { message: string } }).error.message;
    expect(message).toMatch(/personality/i);
    expect(message).toContain((PERSONA_LIMITS.personality + over).toLocaleString());
    expect(message).toContain(PERSONA_LIMITS.personality.toLocaleString());
    expect(message).toContain(over.toLocaleString());
  });

  it('says a required field is empty rather than describing a shape', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({ displayName: '' }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/cannot be empty/i);
  });

  it('still lists every problem for anything that wants them', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({ personality: 'x'.repeat(PERSONA_LIMITS.personality + 1), tone: 'y'.repeat(PERSONA_LIMITS.tone + 1) }),
    });
    const details = (response.json() as { error: { details: { path: string }[] } }).error.details;
    expect(details.map((d) => d.path)).toEqual(expect.arrayContaining(['personality', 'tone']));
  });

  it('accepts a value exactly at the limit', async () => {
    // Off-by-one here means a counter that reads "4,000 / 4,000" refuses to save.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({ personality: 'x'.repeat(PERSONA_LIMITS.personality) }),
    });
    expect(response.statusCode, response.body).toBe(200);
  });
});
