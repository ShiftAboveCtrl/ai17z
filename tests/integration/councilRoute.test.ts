import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
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

const body = {
  proposition: 'The pool is deep enough for a 1k trade.',
  evidence: [{ source: 'example.com', content: 'The pool holds about four million in liquidity.' }],
};

/**
 * Convening a council through the API: the owner's own agent only, with
 * evidence, and an honest report when a member does not answer in shape. The
 * fixture's model echoes its prompt, so every member is dropped and the
 * report says why rather than inventing a verdict.
 */
describe('a council over the API', () => {
  it('reports on every member, and invents no verdict from an answer out of shape', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const response = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/council`, headers: auth, payload: body });
    expect(response.statusCode, response.body).toBe(200);
    const report = (response.json() as { data: { calls: number; views: unknown[]; dropped: { why: string }[]; consensus: unknown } }).data;
    expect(report.calls).toBe(5);
    expect(report.views).toEqual([]);
    expect(report.dropped).toHaveLength(5);
    expect(report.consensus).toBeNull();
  });

  it("is refused for another owner's agent, and without evidence", async () => {
    const mine = await createFixture();
    const other = await createFixture();
    const auth = await signIn(mine.ownerEmail);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${other.agentId}/council`, headers: auth, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${mine.agentId}/council`, headers: auth, payload: { ...body, evidence: [] } })).statusCode).toBe(422);
  });
});
