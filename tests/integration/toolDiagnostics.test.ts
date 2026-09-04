import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { agents as agentsRepo } from '@xbam/database';
import { PolicyConfig } from '@xbam/shared/contracts';
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

const body = <T>(response: { json: () => unknown }): T => (response.json() as { data: T }).data;

interface Verdict {
  key: string;
  state: 'READY' | 'BLOCKED' | 'OFF';
  summary: string;
  setting: string;
  fix: string | null;
  grant: Record<string, string> | null;
}

/**
 * Somebody switches a tool on, is told it is on, and it never runs. The old
 * answer was the words "blocked by policy" with no policy named and nothing to
 * press. These go through the API the interface uses.
 */
describe('why a tool is not running', () => {
  it('a tool switched on but not permitted says which setting stops it', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/tools/memory.search`,
      headers: auth,
      payload: { enabled: true, config: {} },
    });

    const { readiness } = body<{ readiness: Verdict[] }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/tools`, headers: auth }),
    );
    const verdict = readiness.find((r) => r.key === 'memory.search')!;
    expect(verdict.state).toBe('BLOCKED');
    expect(verdict.summary).toContain('policy does not permit');
    expect(verdict.setting).toContain('policy.tools.allowed');
    expect(verdict.grant).toEqual({ addToolToPolicyAllowlist: 'memory.search' });
  });

  it('warns before the switch instead of after the conversation', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const check = body<{ willRun: boolean; warning: string | null }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/tools/memory.search/preflight`, headers: auth }),
    );
    expect(check.willRun).toBe(false);
    expect(check.warning).toContain('not enough on its own');
  });

  it('the fix permits that one tool and touches nothing else', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    const before = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))?.config ?? {});
    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/tools/memory.search`, headers: auth, payload: { enabled: true, config: {} } });

    const applied = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/tools/memory.search/allow`, headers: auth });
    expect(applied.statusCode, applied.body).toBe(200);

    const after = PolicyConfig.parse((await agentsRepo.getActivePolicy(fixture.agentId))?.config ?? {});
    expect(after.tools.allowed).toContain('memory.search');
    // Everything else about the policy is untouched: a quick fix that widens
    // the agent to make one tool work is not a fix.
    expect(after.rate).toEqual(before.rate);
    expect(after.output).toEqual(before.output);
    expect(after.content).toEqual(before.content);
    expect(after.automation).toEqual(before.automation);
    expect(after.identity).toEqual(before.identity);
  });

  it('reports READY once both gates are open', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/tools/memory.search`, headers: auth, payload: { enabled: true, config: {} } });
    const { readiness } = body<{ readiness: Verdict[] }>(
      await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/tools/memory.search/allow`, headers: auth }),
    );
    const verdict = readiness.find((r) => r.key === 'memory.search')!;
    expect(verdict.state).toBe('READY');
    expect(verdict.fix).toBeNull();
  });

  it('distinguishes a tool nobody switched on from one the policy refuses', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const { readiness } = body<{ readiness: Verdict[] }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/tools`, headers: auth }),
    );
    expect(readiness.length).toBeGreaterThan(0);
    expect(readiness.every((r) => r.state === 'OFF')).toBe(true);
  });

  it('refuses to allow a tool on somebody else\'s agent', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    const auth = await signIn(mine.ownerEmail);
    const attempt = await app.inject({ method: 'POST', url: `/api/agents/${theirs.agentId}/tools/memory.search/allow`, headers: auth });
    expect(attempt.statusCode).toBe(403);
  });
});
