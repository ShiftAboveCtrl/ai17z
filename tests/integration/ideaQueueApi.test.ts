import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { content, posting, query } from '@xbam/database';
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

interface QueueView {
  counts: Record<string, number>;
  items: { id: string; summary: string; score: number; effectiveScore: number; attempts: number; lastError: string }[];
  schedule: { enabled: boolean; lastReason: string; updatedAt: string } | null;
}

const backdate = (id: string, days: number) =>
  query('UPDATE content_ideas SET created_at = now() - make_interval(days => $2) WHERE id = $1', [id, days]);

/**
 * The screen has to show the queue the agent will actually use.
 *
 * The list was ordered by the raw score while the claim ordered by the aged one,
 * so the top of the owner's list was not what would be posted next -- a list
 * that answers a question nobody asked.
 */
describe('the idea queue an owner sees', () => {
  it('is in the order the agent will take them', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    const stale = await content.addIdea({ agentId: fixture.agentId, summary: 'A strong thought from a fortnight ago.', score: 90 });
    await backdate(stale.id, 10);
    const fresh = await content.addIdea({ agentId: fixture.agentId, summary: 'An ordinary thought from today.', score: 55 });

    const response = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/ideas`, headers: auth });
    const view = (response.json() as { data: QueueView }).data;

    expect(view.items[0]!.id).toBe(fresh.id);
    // And that really is what the agent takes next, which is the point.
    expect((await content.claimBestIdea(fixture.agentId))!.id).toBe(fresh.id);
  });

  it('shows what an idea is worth now, not only what it was worth when captured', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought captured five days ago.', score: 60 });
    await backdate(idea.id, 5);

    const response = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/ideas`, headers: auth });
    const item = (response.json() as { data: QueueView }).data.items.find((i) => i.id === idea.id)!;

    expect(item.score).toBe(60);
    expect(item.effectiveScore).toBeLessThan(60);
  });

  it('carries the schedule, because that is half the answer to "why has it not posted"', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await posting.setSchedule({ agentId: fixture.agentId, accountId: null, enabled: true, intervalSeconds: 21_600 });
    await posting.recordAttempt(fixture.agentId, 'Nothing in the idea backlog was worth posting.', null);

    const response = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/ideas`, headers: auth });
    const view = (response.json() as { data: QueueView }).data;

    expect(view.schedule?.enabled).toBe(true);
    expect(view.schedule?.lastReason).toContain('worth posting');
    // When it looked, without which the reason contradicts the count beside it.
    expect(view.schedule?.updatedAt).toBeTruthy();
  });

  it('carries why an idea has not published yet', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought that keeps being refused.' });
    await query("UPDATE content_ideas SET attempts = 2, last_error = 'The reply was held for review.' WHERE id = $1", [idea.id]);

    const response = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/ideas`, headers: auth });
    const item = (response.json() as { data: QueueView }).data.items.find((i) => i.id === idea.id)!;

    expect(item.attempts).toBe(2);
    expect(item.lastError).toContain('held for review');
  });
});
