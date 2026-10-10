import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts as accountsRepo } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { buildServer } from '../../apps/api/src/server';
import { installHarness, mockEvent } from '../support/harness';
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

/**
 * The inbox carries its triage. Each row arrives with a priority, the factors
 * behind it and a suggestion; the list keeps the order things happened in, so
 * triage informs an owner and reorders nothing on its own.
 */
describe('the inbox over the API', () => {
  it('carries a triage with its reasons on every row, in arrival order', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: `triage_${uniqueSuffix()}` });
    await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
    await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, triggerEventTypes: ['MENTION', 'REPLY'], actionType: 'REPLY' });

    await ingestNormalizedEvent({ accountId: account.id, event: mockEvent('how does the bridge work?', { remoteAuthorHandle: 'asks_first' }) });
    await ingestNormalizedEvent({ accountId: account.id, event: mockEvent('gm', { remoteAuthorHandle: 'says_second' }) });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
    const token = (login.json() as { data: { token: string } }).data.token;
    const response = await app.inject({ method: 'GET', url: `/api/mentions?agentId=${fixture.agentId}`, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode, response.body).toBe(200);
    const { items } = (response.json() as { data: { items: { authorHandle: string; triage: { suggestion: string; factors: { reason: string }[]; summary: string } }[] } }).data;

    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(['ANSWER', 'REVIEW', 'LEAVE', 'NOTHING']).toContain(item.triage.suggestion);
      expect(item.triage.factors.length).toBeGreaterThan(0);
      expect(item.triage.summary.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
