import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { accounts as accountsRepo, agents as agentsRepo, memories } from '@xbam/database';
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

/**
 * Renaming is a display change and must stay one.
 *
 * The identity that matters is the agent id: accounts hang off it, memories
 * belong to it, jobs reference it, and a browser profile directory is derived
 * from the *account* id rather than from any name. A rename that disturbed any
 * of that would separate an agent from its history silently, which is the kind
 * of thing nobody notices until the agent has forgotten everybody.
 */
describe('renaming an agent', () => {
  it('changes the name and nothing durable', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    await memories.writeMemory({
      agentId: fixture.agentId,
      scope: 'USER',
      memoryType: 'FACT',
      content: 'They prefer short answers.',
      remoteHandle: 'alice',
    });
    const before = await memories.searchMemories({ agentId: fixture.agentId, limit: 10 });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${fixture.agentId}`,
      headers: auth,
      payload: { name: 'Renamed Agent' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const agent = await agentsRepo.getAgent(fixture.agentId);
    expect(agent!.name).toBe('Renamed Agent');
    // The id is the identity, and it has not moved.
    expect(agent!.id).toBe(fixture.agentId);

    const after = await memories.searchMemories({ agentId: fixture.agentId, limit: 10 });
    expect(after.total).toBe(before.total);
    expect(after.items[0]!.content).toBe('They prefer short answers.');
  });

  it('leaves the connected accounts attached', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const before = await accountsRepo.listAgentAccounts(fixture.agentId);

    await app.inject({ method: 'PATCH', url: `/api/agents/${fixture.agentId}`, headers: auth, payload: { name: 'Second Name' } });

    const after = await accountsRepo.listAgentAccounts(fixture.agentId);
    expect(after.map((a) => a.accountId).sort()).toEqual(before.map((a) => a.accountId).sort());
  });

  it('does not touch the persona display name, which is a separate thing', async () => {
    // The agent name is what the owner calls it; the persona display name is
    // what it calls itself to other people. Conflating them means renaming a
    // row in a list changes what an agent says it is.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const before = await agentsRepo.getActivePersona(fixture.agentId);

    await app.inject({ method: 'PATCH', url: `/api/agents/${fixture.agentId}`, headers: auth, payload: { name: 'Owner Facing Name' } });

    const after = await agentsRepo.getActivePersona(fixture.agentId);
    expect(after!.displayName).toBe(before!.displayName);
    expect(after!.version).toBe(before!.version);
  });

  it('refuses an empty name rather than accepting a nameless agent', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const attempt = await app.inject({ method: 'PATCH', url: `/api/agents/${fixture.agentId}`, headers: auth, payload: { name: '   ' } });
    expect(attempt.statusCode).toBe(422);
  });

  it('refuses to rename somebody else\'s agent', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    const auth = await signIn(mine.ownerEmail);
    const attempt = await app.inject({ method: 'PATCH', url: `/api/agents/${theirs.agentId}`, headers: auth, payload: { name: 'Mine now' } });
    expect(attempt.statusCode).toBe(403);
  });
});
