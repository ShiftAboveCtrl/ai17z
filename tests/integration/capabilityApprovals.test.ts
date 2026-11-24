import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { accounts, capabilityApprovals, capabilityInvocations, capabilityPermissions, query } from '@xbam/database';
import { defineCapability, registerCapability, resetCapabilitiesForTest } from '@xbam/tools';
import { buildServer } from '../../apps/api/src/server';
import { runCapabilityLoop } from '../../packages/runtime/src/capabilityLoop';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { sweepCapabilityApprovals } from '../../packages/runtime/src/capabilityApprovals';
import { setPauseAll } from '../../packages/runtime/src/killSwitch';

installHarness();
let app: FastifyInstance;
let runs = 0;
let received: unknown;
let receivedOrigin: unknown;
let receivedConfig: unknown;
let ready = true;
let duringReadiness: (() => Promise<void>) | undefined;
let failWrite = false;
beforeAll(async () => { app = await buildServer(); await app.ready(); });
afterAll(async () => { await app?.close(); resetCapabilitiesForTest(); });
beforeEach(() => {
  runs = 0;
  received = null;
  receivedOrigin = null;
  receivedConfig = null;
  ready = true;
  duringReadiness = undefined;
  failWrite = false;
  resetCapabilitiesForTest();
  registerCapability(defineCapability({
    id: 'test.publish', name: 'Publish report', description: 'Publish a report.',
    category: 'CREATE', effect: 'WRITE', risk: 'HIGH', modelCallable: true,
    input: z.object({ text: z.string(), apiKey: z.string().optional(),
      nested: z.object({ password: z.string() }).optional() }),
    output: z.object({ published: z.boolean() }), timeoutMs: 1000,
    async readiness() {
      await duringReadiness?.();
      return { status: ready ? 'AVAILABLE' as const : 'DEGRADED' as const, why: 'Quota is exhausted.' };
    },
    async run(input, context) {
      runs += 1; received = input; receivedOrigin = context.origin; receivedConfig = context.config;
      if (failWrite) throw new Error('private-provider-secret');
      return { published: true };
    },
  }));
});

async function proposal(autonomy?: 'THINK' | 'SUGGEST', ownerChat = false, input: unknown = { text: 'Exact report' }) {
  const f = await createFixture();
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.publish', permission: 'OWNER_APPROVAL' });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { email: f.ownerEmail, password: 'test-password-1234' } });
  expect(login.statusCode).toBe(200);
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  await runCapabilityLoop({
    agentId: f.agentId, accountId: null, jobId: null,
    messages: [{ role: 'user', content: 'Publish a report.' }],
    permissions: new Map([['test.publish', 'OWNER_APPROVAL']]), paused: false, maxSteps: 1,
    ...(ownerChat ? { audience: 'OWNER' as const, origin: {
      conversationId: 'owner-room', messageId: 'owner-message', ownerId: f.ownerId, text: 'private-owner-confirmation',
    } } : {}),
    ...(autonomy ? { goalPlan: {
      checkpoint: async () => ({ permissions: new Map([['test.publish', 'OWNER_APPROVAL' as const]]),
        configs: new Map(), paused: false, autonomy, enabled: true }),
      onStep: async () => {},
    } } : {}),
    generate: async messages => messages.some(m => m.content.includes('no more lookups'))
      ? 'Waiting for approval.' : `<use-capability>${JSON.stringify({ id: 'test.publish', input })}</use-capability>`,
  });
  return { ...f, headers, url: `/api/agents/${f.agentId}/mind/capability-approvals` };
}

async function pending(f: Awaited<ReturnType<typeof proposal>>) {
  const response = await app.inject({ url: f.url, headers: f.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data[0] as { id: string; status: string };
}

async function decide(f: Awaited<ReturnType<typeof proposal>>, decision = 'APPROVE', reason?: string) {
  const row = await pending(f);
  return app.inject({ method: 'POST', url: `${f.url}/${row.id}/decision`, headers: f.headers,
    payload: { decision, ...(reason ? { reason } : {}) } });
}

describe('owner capability approval queue', () => {
  it('uses the current configuration after readiness', async () => {
    const f = await proposal();
    await decide(f);
    duringReadiness = async () => {
      await capabilityPermissions.setConfig({ agentId: f.agentId, capabilityId: 'test.publish',
        permission: 'OWNER_APPROVAL', config: { destination: 'updated' } });
    };
    await sweepCapabilityApprovals();
    expect(receivedConfig).toEqual({ destination: 'updated' });
  });

  it('deduplicates identical calls without a job or owner message', async () => {
    const f = await proposal();
    const options = { agentId: f.agentId, accountId: null, jobId: null,
      messages: [{ role: 'user' as const, content: 'Publish another report.' }],
      permissions: new Map([['test.publish', 'OWNER_APPROVAL' as const]]), paused: false, maxSteps: 1,
      generate: async (messages: { content: string }[]) => messages.some(m => m.content.includes('no more lookups'))
        ? 'Waiting.' : '<use-capability>{"id":"test.publish","input":{"text":"Repeated report"}}</use-capability>',
    };
    await runCapabilityLoop(options);
    await runCapabilityLoop(options);
    expect(await query('SELECT count(*) AS count FROM capability_approvals')).toEqual([{ count: 2 }]);
  });

  it('shows the validated call with credential fields redacted in list and decision responses', async () => {
    const f = await proposal(undefined, false, {
      text: 'Exact report', apiKey: 'private-test-key', nested: { password: 'private-test-password' },
    });
    for (const response of [await app.inject({ url: f.url, headers: f.headers }), await decide(f)]) {
      const data = response.json().data;
      expect(JSON.parse(Array.isArray(data) ? data[0].inputPreview : data.inputPreview)).toEqual({
        text: 'Exact report', apiKey: '[redacted]', nested: { password: '[redacted]' },
      });
      expect(response.body).not.toContain('private-test-');
    }
  });

  it('caps an oversized redacted preview and labels its truncation', async () => {
    const f = await proposal(undefined, false, { text: 'x'.repeat(13000) });
    const response = await app.inject({ url: f.url, headers: f.headers });
    expect(response.json().data[0].inputPreview).toHaveLength(12000);
    expect(response.json().data[0].inputTruncated).toBe(true);
  });

  it('bounds concurrent pending proposals per agent', async () => {
    const f = await proposal();
    const row = (await capabilityApprovals.listForAgent(f.agentId))[0]!;
    await Promise.all(Array.from({ length: 25 }, (_, i) => capabilityApprovals.propose({
      ...row, sourceRef: `flood-${i}`, input: { text: `Report ${i}` },
    })));
    expect(await query("SELECT count(*) AS count FROM capability_approvals WHERE status='PENDING'")).toEqual([{ count: 20 }]);
  });

  it('keeps the successful outcome if invocation recording fails', async () => {
    const f = await proposal();
    await decide(f);
    const record = vi.spyOn(capabilityInvocations, 'recordInvocation').mockRejectedValueOnce(new Error('private-record-error'));
    try { await sweepCapabilityApprovals(); } finally { record.mockRestore(); }
    expect(runs).toBe(1);
    expect((await pending(f)).status).toBe('DONE');
    await sweepCapabilityApprovals();
    expect(runs).toBe(1);
  });

  it('retains approval history when its source account is deleted', async () => {
    const f = await proposal();
    const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'approval-history' });
    await query('UPDATE capability_approvals SET account_id=$1', [account.id]);
    await query('DELETE FROM accounts WHERE id=$1', [account.id]);
    const rows = await capabilityApprovals.listForAgent(f.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBeNull();
  });

  it('keeps an unapproved write refused and exposes a pending owner decision', async () => {
    const f = await proposal();
    expect(runs).toBe(0);
    const response = await app.inject({ url: f.url, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([expect.objectContaining({ capabilityId: 'test.publish', status: 'PENDING' })]);
  });

  it('executes exact input once after concurrent approvals and concurrent worker ticks', async () => {
    const f = await proposal();
    const responses = await Promise.all([decide(f), decide(f)]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(runs).toBe(0);
    await Promise.all([sweepCapabilityApprovals(), sweepCapabilityApprovals()]);
    expect(runs).toBe(1);
    expect(received).toEqual({ text: 'Exact report' });
    expect((await pending(f)).status).toBe('DONE');
    expect((await decide(f)).statusCode).toBe(409);
    await sweepCapabilityApprovals();
    expect(runs).toBe(1);
    const audits = await query("SELECT * FROM audit_events WHERE action='capability.approval.approved'");
    expect(audits).toHaveLength(1);
  });

  it.each(['THINK', 'SUGGEST'] as const)('makes a below-ACT %s proposal actionable', async autonomy => {
    const f = await proposal(autonomy);
    expect(runs).toBe(0);
    await decide(f);
    await sweepCapabilityApprovals();
    expect(runs).toBe(1);
  });

  it('retains owner chat provenance privately through execution', async () => {
    const f = await proposal(undefined, true);
    const response = await app.inject({ url: f.url, headers: f.headers });
    expect(response.json().data[0].source).toBe('OWNER_CHAT');
    expect(response.body).not.toContain('private-owner-confirmation');
    await decide(f);
    await sweepCapabilityApprovals();
    expect(runs).toBe(1);
    expect(receivedOrigin).toEqual({ conversationId: 'owner-room', messageId: 'owner-message',
      ownerId: f.ownerId, text: 'private-owner-confirmation' });
  });

  it('records a rejection reason and audits it without executing', async () => {
    const f = await proposal();
    expect((await decide(f, 'REJECT')).statusCode).toBe(422);
    expect((await decide(f, 'REJECT', 'Not appropriate now.')).statusCode).toBe(200);
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
    expect(await query('SELECT status, decision_reason FROM capability_approvals')).toEqual([
      { status: 'DENIED', decision_reason: 'Not appropriate now.' },
    ]);
    expect(await query("SELECT id FROM audit_events WHERE action='capability.approval.denied'")).toHaveLength(1);
  });

  it.each(['DISABLED', 'PAUSED', 'QUOTA', 'TAMPERED', 'EXPIRED'] as const)('refuses %s at execution permanently', async gate => {
    const f = await proposal();
    if (gate === 'EXPIRED') await query("UPDATE capability_approvals SET expires_at=now()-interval '1 second'");
    await decide(f);
    if (gate === 'DISABLED') await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.publish', permission: 'DISABLED' });
    if (gate === 'PAUSED') await setPauseAll({ paused: true, by: f.ownerId });
    if (gate === 'QUOTA') ready = false;
    if (gate === 'TAMPERED') await query(`UPDATE capability_approvals SET input='{"text":"changed"}'::jsonb`);
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
    expect((await pending(f)).status).toBe(gate === 'EXPIRED' ? 'EXPIRED' : 'FAILED');
    await setPauseAll({ paused: false, by: f.ownerId });
    ready = true;
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.publish', permission: 'OWNER_APPROVAL' });
    await decide(f);
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
  });

  it('never revives a grant disabled then re-enabled before approval', async () => {
    const f = await proposal();
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.publish', permission: 'DISABLED' });
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.publish', permission: 'OWNER_APPROVAL' });
    await decide(f);
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
    expect((await pending(f)).status).toBe('FAILED');
  });

  it('treats a removed permission row as permanent revocation', async () => {
    const f = await proposal();
    await capabilityPermissions.clear(f.agentId, 'test.publish');
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.publish', permission: 'OWNER_APPROVAL' });
    await decide(f);
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
    expect((await pending(f)).status).toBe('FAILED');
  });

  it('never retakes a committed execution claim after a worker crash', async () => {
    const f = await proposal();
    await decide(f);
    await query(`UPDATE capability_approvals SET execution_key=id,execution_started_at=now()-interval '11 minutes'`);
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
    expect((await pending(f)).status).toBe('FAILED');
    await decide(f);
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
  });

  it('rechecks revocation after asynchronous readiness', async () => {
    const f = await proposal();
    await decide(f);
    duringReadiness = async () => {
      await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'test.publish', permission: 'DISABLED' });
    };
    await sweepCapabilityApprovals();
    expect(runs).toBe(0);
    expect((await pending(f)).status).toBe('FAILED');
  });

  it('does not retry an unknown WRITE outcome or return provider errors', async () => {
    const f = await proposal();
    failWrite = true;
    await decide(f);
    await sweepCapabilityApprovals();
    await decide(f);
    await sweepCapabilityApprovals();
    expect(runs).toBe(1);
    const response = await app.inject({ url: f.url, headers: f.headers });
    expect(response.body).not.toContain('private-provider-secret');
    expect(JSON.parse(response.json().data[0].inputPreview)).toEqual({ text: 'Exact report' });
    expect(response.body).not.toContain('inputSha256');
    expect(response.json().data[0].status).toBe('FAILED');
  });

  it('requires authentication and ownership for listing and decisions', async () => {
    const f = await proposal();
    const other = await createFixture();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: other.ownerEmail, password: 'test-password-1234' } });
    const headers = { authorization: `Bearer ${login.json().data.token}` };
    expect((await app.inject({ url: f.url })).statusCode).toBe(401);
    expect((await app.inject({ url: f.url, headers })).statusCode).toBe(403);
    const row = await pending(f);
    expect((await app.inject({ method: 'POST', url: `${f.url}/${row.id}/decision`, headers,
      payload: { decision: 'APPROVE' } })).statusCode).toBe(403);
    expect(runs).toBe(0);
  });
});
