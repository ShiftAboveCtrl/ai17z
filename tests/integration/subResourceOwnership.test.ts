import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { content as contentRepo, stances as stancesRepo } from '@xbam/database';
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
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${(r.json() as { data: { token: string } }).data.token}` };
}

/**
 * Owning an agent is permission to act on that agent, not on a row id.
 *
 * Every route under /api/agents/:id checks the caller owns :id, and most then
 * fetch the sub-resource and check it belongs to that agent. Three did not:
 * ideas, predictions and commitments were written by id alone, so a signed-in
 * owner who guessed or saw an id could discard a stranger's backlog or judge
 * their predictions. The agent is part of the key now, in the SQL, so the
 * write cannot reach the row whatever a route forgets.
 */
describe('acting on another owner\u2019s rows', () => {
  it('cannot change an idea belonging to somebody else', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    const idea = await contentRepo.addIdea({ agentId: theirs.agentId, summary: 'Their idea, not mine.' });
    const auth = await signIn(mine.ownerEmail);

    const response = await app.inject({
      method: 'PATCH',
      // My agent id, their idea id: the shape an id-only write cannot tell apart.
      url: `/api/agents/${mine.agentId}/ideas/${idea.id}`,
      headers: auth,
      payload: { status: 'discarded' },
    });

    expect(response.statusCode).toBe(404);
    const after = await contentRepo.listIdeas(theirs.agentId);
    expect(after.find((i) => i.id === idea.id)!.status).toBe('unused');
  });

  it('cannot judge a prediction belonging to somebody else', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    await stancesRepo.recordPrediction({ agentId: theirs.agentId, claim: 'It will rain.' });
    const predictions = (await stancesRepo.listPredictions(theirs.agentId)) as { id: string; outcome: string | null }[];
    const [prediction] = predictions;
    const auth = await signIn(mine.ownerEmail);

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${mine.agentId}/predictions/${prediction!.id}`,
      headers: auth,
      payload: { outcome: 'WRONG', note: '' },
    });

    expect(response.statusCode).toBe(404);
    const after = (await stancesRepo.listPredictions(theirs.agentId)) as { outcome: string | null }[];
    expect(after[0]!.outcome).not.toBe('WRONG');
  });

  it('cannot close a commitment belonging to somebody else', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    await stancesRepo.recordCommitment({ agentId: theirs.agentId, promise: 'I will follow up.' });
    const commitments = (await stancesRepo.listCommitments(theirs.agentId)) as { id: string }[];
    const [commitment] = commitments;
    const auth = await signIn(mine.ownerEmail);

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${mine.agentId}/commitments/${commitment!.id}`,
      headers: auth,
      payload: { status: 'DROPPED' },
    });

    expect(response.statusCode).toBe(404);
    expect((await stancesRepo.listCommitments(theirs.agentId)).length).toBe(1);
  });

  it('still lets an owner act on their own', async () => {
    // The check has to be a check, not a refusal.
    const mine = await createFixture();
    const idea = await contentRepo.addIdea({ agentId: mine.agentId, summary: 'My own idea.' });
    const auth = await signIn(mine.ownerEmail);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${mine.agentId}/ideas/${idea.id}`,
      headers: auth,
      payload: { status: 'discarded' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect((await contentRepo.listIdeas(mine.agentId, 'discarded')).map((i) => i.id)).toContain(idea.id);
  });
});
