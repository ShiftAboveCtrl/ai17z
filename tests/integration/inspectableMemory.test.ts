import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { agents, chat, knowledge, memories, query } from '@xbam/database';
import { PolicyConfig, type MemoryRecord } from '@xbam/shared/contracts';
import { retrieveMemories } from '@xbam/memory';
import { ingestNormalizedEvent, registerIntrospectionCapabilities, saveFromChat } from '@xbam/runtime';
import { invokeCapability } from '@xbam/tools';
import { buildServer } from '../../apps/api/src/server';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();
let app: FastifyInstance;
beforeAll(async () => { registerIntrospectionCapabilities(); app = await buildServer(); await app.ready(); });
afterAll(async () => { await app?.close(); });
const data = <T>(r: { json(): unknown }): T => (r.json() as { data: T }).data;
async function auth(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${data<{ token: string }>(r).token}` };
}

describe('inspectable memory', () => {
  it('returns selected memories with recorded reasons and event evidence only to the owner', async () => {
    const f = await createFixture();
    await ingestNormalizedEvent({ accountId: null, onlyAgentId: f.agentId, event: mockEvent('Remember that my favorite number is 41.') });
    await drainJobs();
    const second = await ingestNormalizedEvent({ accountId: null, onlyAgentId: f.agentId, event: mockEvent('What is my favorite number?') });
    await drainJobs();
    const ctx = { agentId: f.agentId, jobId: null, accountId: null, config: {}, logger: console as never };
    const call = { id: 'agent.memory', input: { search: 'favorite number', scopes: ['USER'] } };
    const denied = await invokeCapability({ call, context: ctx, permission: { stored: null, paused: false } });
    expect(denied.outcome).toBe('REFUSED');
    const result = await invokeCapability({ call, context: { ...ctx, audience: 'OWNER' }, permission: { stored: null, paused: false } });
    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.output).toMatchObject({ total: 1, items: [{ scope: 'USER', reason: 'same remote user @alice', reasonJobId: second.jobs[0]!.job.id,
      evidence: expect.arrayContaining([expect.objectContaining({ kind: 'EVENT', text: 'Remember that my favorite number is 41.' })]) }] });
  });

  it('keeps chat evidence and the original message after deleting a saved fact from the next retrieval', async () => {
    const f = await createFixture();
    const conversation = await chat.createConversation({ ownerId: f.ownerId, kind: 'AGENT', title: 'Launch', agentIds: [f.agentId] });
    const { message } = await chat.postOwnerMessage({ conversationId: conversation.id, content: 'Heron launches Friday.', answerers: [] });
    const [save] = await saveFromChat({ ownerId: f.ownerId, conversationId: conversation.id, messageId: message.id, content: 'Heron launch day is Friday.', agentIds: [f.agentId], target: 'MEMORY' });
    const headers = await auth(f.ownerEmail);
    const url = `/api/agents/${f.agentId}/memories`;
    const page = data<{ items: { reason: string | null; evidence: { kind: string; text: string }[] }[] }>(await app.inject({ url, headers }));
    expect(page.items[0]).toMatchObject({ reason: null, evidence: [expect.objectContaining({ kind: 'CHAT', text: 'Heron launches Friday.' })] });
    const request = { agentId: f.agentId, policy: PolicyConfig.parse({}).memory, conversationId: null, remoteHandle: null, accountId: null, incomingText: 'Heron' };
    expect((await retrieveMemories(request)).memories.map((m) => m.memoryId)).toContain(save!.memoryId);
    expect((await app.inject({ method: 'DELETE', url: `${url}/${save!.memoryId}`, headers })).statusCode).toBe(200);
    expect((await retrieveMemories(request)).memories).toEqual([]);
    expect((await chat.listMessages(conversation.id))[0]!.content).toBe('Heron launches Friday.');
  });

  it('shows the knowledge document that taught a chunk and its recorded revision', async () => {
    const f = await createFixture();
    const source = await knowledge.createSource({ agentId: f.agentId, name: 'Heron handbook', kind: 'TEXT', location: 'Heron launches Friday.' });
    await memories.writeMemory({ agentId: f.agentId, scope: 'KNOWLEDGE', memoryType: 'DOCUMENT', content: 'Heron launches Friday.', knowledgeSourceId: source.id, origin: { path: 'launch.md', heading: 'Release', revision: 'r1' } });
    const page = data<{ items: { evidence: { label: string }[]; origin: unknown }[] }>(await app.inject({ url: `/api/agents/${f.agentId}/memories`, headers: await auth(f.ownerEmail) }));
    expect(page.items[0]).toMatchObject({ evidence: [expect.objectContaining({ kind: 'KNOWLEDGE', id: source.id, label: 'Heron handbook' })], origin: { path: 'launch.md', revision: 'r1' } });
  });

  it('refuses automatic pin writes while an owner can pin and automatic duplicates preserve that choice', async () => {
    const f = await createFixture();
    const input = { agentId: f.agentId, scope: 'KNOWLEDGE' as const, memoryType: 'FACT' as const, content: 'Heron launches Friday.' };
    await expect(memories.writeMemory({ ...input, pinned: true })).rejects.toThrow(/owner/i);
    const { memory } = await memories.writeMemory(input);
    expect(memory.pinned).toBe(false);
    await expect(memories.updateMemory(memory.id, { pinned: true })).rejects.toThrow(/owner/i);
    const headers = await auth(f.ownerEmail);
    const pinned = await app.inject({ method: 'PATCH', url: `/api/agents/${f.agentId}/memories/${memory.id}`, headers, payload: { pinned: true } });
    expect(data<MemoryRecord>(pinned).pinned).toBe(true);
    expect((await memories.writeMemory(input)).memory.pinned).toBe(true);
    const created = await app.inject({ method: 'POST', url: `/api/agents/${f.agentId}/memories`, headers, payload: { scope: 'PERSONA', content: 'An owner taught fact.', pinned: true } });
    expect(data<{ memory: MemoryRecord }>(created).memory.pinned).toBe(true);
  });

  it('pages all six scopes with provenance without leaking another agent and protects edits', async () => {
    const f = await createFixture();
    const other = await createFixture();
    for (const scope of ['THREAD', 'USER', 'PERSONA', 'ACCOUNT', 'KNOWLEDGE', 'EPISODIC'] as const) {
      await memories.writeMemory({ agentId: f.agentId, scope, memoryType: 'FACT', content: `Heron ${scope}`, origin: { path: 'guide.md', heading: 'Launch', revision: 'r1' } });
    }
    await memories.writeMemory({ agentId: other.agentId, scope: 'USER', memoryType: 'FACT', content: 'Heron private' });
    const headers = await auth(f.ownerEmail);
    const url = `/api/agents/${f.agentId}/memories?search=Heron&limit=2`;
    const ids = new Set<string>();
    for (const offset of [0, 2, 4]) {
      const page = data<{ total: number; items: (MemoryRecord & { reason: string | null })[] }>(await app.inject({ url: `${url}&offset=${offset}`, headers }));
      expect(page.total).toBe(6);
      for (const m of page.items) { expect(m.reason).toBeNull(); expect(m.origin).toMatchObject({ path: 'guide.md' }); ids.add(m.id); }
    }
    expect(ids.size).toBe(6);
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const denied = await app.inject({ method, url: `/api/agents/${f.agentId}/memories${method === 'GET' ? '' : `/${[...ids][0]}`}`, headers: await auth(other.ownerEmail), ...(method === 'PATCH' ? { payload: { pinned: true } } : {}) });
      expect(denied.statusCode).toBe(403);
    }
    expect(await agents.getAgent(f.agentId)).not.toBeNull();
    expect(await query('SELECT count(*)::int AS n FROM memories WHERE agent_id = $1', [f.agentId])).toEqual([{ n: 6 }]);
  });
});
