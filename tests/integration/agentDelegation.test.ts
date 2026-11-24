import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agents, capabilityPermissions, chat, deliberation, jobs, memories, query } from '@xbam/database';
import { answerNextChatTurn, DELEGATION_TIMEOUT_MS, registerIntrospectionCapabilities, registerDelegationCapability, runCapabilityLoop, setPauseAll } from '@xbam/runtime';
import { getCapability, invokeCapability } from '@xbam/tools';
import { roomDelegation } from '../../packages/runtime/src/roomDelegation';
import { mockAdapter } from '../../packages/models/src/providers/mock';
import { generate } from '@xbam/models';
import { DEFAULT_POLICY, type PolicyConfig } from '@xbam/shared/contracts';
import { createFixture } from '../support/fixtures';
import { installHarness } from '../support/harness';

installHarness();
beforeAll(() => { registerIntrospectionCapabilities(); registerDelegationCapability(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setupRoom(policy: Partial<PolicyConfig> = {}) {
  const first = await createFixture({ model: 'mock-delegator' });
  const second = await createFixture({ model: 'mock-delegate',
    policy: { tools: { ...DEFAULT_POLICY.tools, capabilityLoop: true }, ...policy } });
  await query('UPDATE agents SET owner_id = $1 WHERE id = $2', [first.ownerId, second.agentId]);
  for (const id of [first.agentId, second.agentId]) {
    await agents.updateAgent(id, { state: 'ACTIVE' });
    await deliberation.setWake(id, { enabled: true, autonomy: 'ACT' });
  }
  await capabilityPermissions.set({ agentId: first.agentId, capabilityId: 'room.delegate', permission: 'ALLOWED' });
  const room = await chat.createConversation({ ownerId: first.ownerId, kind: 'ROOM', title: 'Research', agentIds: [first.agentId, second.agentId] });
  const { pending } = await chat.postOwnerMessage({ conversationId: room.id, content: 'Delegate a bounded question to the other agent.', answerers: [first.agentId] });
  return { first, second, room, answer: pending[0]! };
}

function call(id: string, input: Record<string, unknown> = {}): string {
  return `<use-capability>${JSON.stringify({ id, input })}</use-capability>`;
}

function scripted(agentId: string, delegate: (prompt: string) => string | Promise<string>, repeat = false) {
  vi.spyOn(mockAdapter, 'generate').mockImplementation(async request => {
    const prompt = request.messages.map(m => m.content).join('\n');
    const text = request.model === 'mock-delegate' ? await delegate(prompt)
      : !repeat && /room.delegate (?:returned|did not run):/.test(prompt) ? 'The delegated attempt has ended.'
      : call('room.delegate', { agentId, task: 'What is your setup?' });
    return { text, requestId: 'delegation-test', promptTokens: 10, completionTokens: 10, raw: {} };
  });
}

async function delegateMessage(roomId: string, agentId: string) {
  return (await chat.listMessages(roomId)).find(m => m.agentId === agentId);
}

describe('room delegation', () => {
  it('answers as the delegate with its own memory, never the delegator memory, and queues nothing', async () => {
    const first = await createFixture({ model: 'mock-delegator' });
    const second = await createFixture({ model: 'mock-delegate', persona: { biography: 'I am the room researcher.' }, policy: { tools: { ...DEFAULT_POLICY.tools, capabilityLoop: true } } });
    await query('UPDATE agents SET owner_id = $1 WHERE id = $2', [first.ownerId, second.agentId]);
    for (const id of [first.agentId, second.agentId]) {
      await agents.updateAgent(id, { state: 'ACTIVE' });
      await deliberation.setWake(id, { enabled: true, autonomy: 'ACT' });
    }
    await capabilityPermissions.set({ agentId: first.agentId, capabilityId: 'room.delegate', permission: 'ALLOWED' });
    await memories.writeMemory({ agentId: first.agentId, scope: 'KNOWLEDGE', memoryType: 'FACT', content: 'The launch codename is Heron.', importance: 1 });
    await memories.writeMemory({ agentId: second.agentId, scope: 'KNOWLEDGE', memoryType: 'FACT', content: 'The launch codename is Kestrel.', importance: 1 });
    const room = await chat.createConversation({ ownerId: first.ownerId, kind: 'ROOM', title: 'Research', agentIds: [first.agentId, second.agentId] });
    await chat.postOwnerMessage({ conversationId: room.id, content: 'Delegate the launch codename question to the other agent.', answerers: [first.agentId] });
    const seen: string[] = [];
    const senderSeen: string[] = [];
    vi.spyOn(mockAdapter, 'generate').mockImplementation(async request => {
      const prompt = request.messages.map(m => m.content).join('\n');
      const isDelegate = request.model === 'mock-delegate';
      if (isDelegate) seen.push(prompt);
      else senderSeen.push(prompt);
      const targets = JSON.parse(prompt.match(/ROOM DELEGATION TARGETS:\n([^\n]+)/)?.[1] ?? '[]') as { agentId: string }[];
      const text = isDelegate ? 'My launch codename is Kestrel.'
        : prompt.includes('room.delegate returned:') ? 'The researcher answered the bounded question.'
        : call('room.delegate', { agentId: targets[0]?.agentId ?? '00000000-0000-0000-0000-000000000000', task: 'What is the launch codename?' });
      return { text, requestId: 'delegation-test', promptTokens: 10, completionTokens: 10, raw: {} };
    });

    expect(await answerNextChatTurn('delegation-worker')).toBe(true);
    const messages = await chat.listMessages(room.id);
    const delegated = messages.find(m => m.agentId === second.agentId);
    expect(delegated?.status).toBe('DONE');
    expect(delegated?.content).toContain('Kestrel');
    expect(seen.join('\n')).toContain('Kestrel');
    expect(seen.join('\n')).toContain('I am the room researcher.');
    expect(seen.join('\n')).not.toContain('Heron');
    expect(senderSeen[0]).toContain('Heron');
    expect(senderSeen[0]).not.toContain('Kestrel');
    expect(messages.filter(m => m.authorKind === 'AGENT')).toHaveLength(2);
    expect(await answerNextChatTurn('delegation-worker')).toBe(false);
    const traces = await query<{ agent_id: string; job_id: string; message: string; data: { otherJobId: string } }>(
      "SELECT * FROM trace_events WHERE data->>'capabilityId' = 'room.delegate' ORDER BY id",
    );
    expect(traces.map(t => t.agent_id).sort()).toEqual([first.agentId, second.agentId].sort());
    expect(traces[0]!.job_id).toBe(traces[1]!.data.otherJobId);
    expect(traces.every(t => /own state and gates\./.test(t.message))).toBe(true);
    expect(await jobs.claimJobs('unrelated-worker', 10, 60_000)).toEqual([]);
    const parentEvidence = messages.find(m => m.agentId === first.agentId)!.evidence;
    expect(JSON.stringify(parentEvidence.memories)).not.toContain('Kestrel');
  });

  it('allows only one delegation even when the model asks repeatedly', async () => {
    const { second, room } = await setupRoom();
    scripted(second.agentId, () => 'One bounded answer.', true);
    await answerNextChatTurn('worker');
    expect((await chat.listMessages(room.id)).filter(m => m.agentId === second.agentId)).toHaveLength(1);
    expect(await query('SELECT id FROM jobs WHERE agent_id = $1', [second.agentId])).toHaveLength(1);
    expect(await answerNextChatTurn('worker')).toBe(false);
  });

  it('refuses nested delegation even if the delegate invents the call', async () => {
    const { first, second, room } = await setupRoom();
    await capabilityPermissions.set({ agentId: second.agentId, capabilityId: 'room.delegate', permission: 'ALLOWED' });
    scripted(second.agentId, () => call('room.delegate', { agentId: first.agentId, task: 'Delegate again.' }));
    await answerNextChatTurn('worker');
    const message = await delegateMessage(room.id, second.agentId);
    expect(message?.status).toBe('FAILED');
    expect(message?.error).toMatch(/not offered/);
    expect(await query('SELECT id FROM jobs')).toHaveLength(2);
    expect(await answerNextChatTurn('worker')).toBe(false);
    expect(await chat.requeueAnswer(first.ownerId, message!.id)).toBeNull();
  });

  it.each(['DISABLED', 'OWNER_APPROVAL'] as const)('respects the delegator permission %s', async permission => {
    const { first, second, room } = await setupRoom();
    await capabilityPermissions.set({ agentId: first.agentId, capabilityId: 'room.delegate', permission });
    scripted(second.agentId, () => 'Must not run.');
    await answerNextChatTurn('worker');
    expect(await delegateMessage(room.id, second.agentId)).toBeUndefined();
    expect(await query('SELECT id FROM model_calls WHERE agent_id = $1', [second.agentId])).toEqual([]);
  });

  it.each(['DISABLED', 'OWNER_APPROVAL'] as const)('uses the delegate own capability permission %s', async permission => {
    const { second, room } = await setupRoom();
    await capabilityPermissions.set({ agentId: second.agentId, capabilityId: 'agent.self_state', permission });
    scripted(second.agentId, () => call('agent.self_state'));
    await answerNextChatTurn('worker');
    const message = await delegateMessage(room.id, second.agentId);
    expect(message?.status).toBe('FAILED');
    expect(message?.error).toMatch(permission === 'DISABLED' ? /not offered/ : /approval/);
    const invocations = await query<{ outcome: string }>('SELECT outcome FROM capability_invocations WHERE agent_id = $1', [second.agentId]);
    expect(invocations[0]?.outcome).toBe('REFUSED');
  });

  it('runs an allowed delegate capability through the existing loop and records it on its job', async () => {
    const { second, room } = await setupRoom();
    scripted(second.agentId, prompt => prompt.includes('agent.self_state returned:') ? 'I checked my own setup.' : call('agent.self_state'));
    await answerNextChatTurn('worker');
    expect((await delegateMessage(room.id, second.agentId))?.content).toBe('I checked my own setup.');
    const rows = await query<{ job_id: string; outcome: string }>('SELECT job_id, outcome FROM capability_invocations WHERE agent_id = $1', [second.agentId]);
    expect(rows[0]).toMatchObject({ outcome: 'SUCCEEDED', job_id: expect.stringMatching(/^[a-f0-9-]+$/) });
  });

  it.each(['OBSERVE', 'THINK', 'SUGGEST'] as const)('refuses delegate autonomy %s before spending a model call', async autonomy => {
    const { second, room } = await setupRoom();
    await deliberation.setWake(second.agentId, { autonomy });
    scripted(second.agentId, () => 'Must not run.');
    await answerNextChatTurn('worker');
    expect((await delegateMessage(room.id, second.agentId))?.status).toBe('FAILED');
    expect(await query('SELECT id FROM model_calls WHERE agent_id = $1', [second.agentId])).toEqual([]);
  });

  it('honors delegate policy and validates its output before either agent can use it', async () => {
    const { second, room } = await setupRoom({ output: { ...DEFAULT_POLICY.output, bannedPhrases: ['forbidden launch'] } });
    scripted(second.agentId, () => 'The forbidden launch is tomorrow.');
    await answerNextChatTurn('worker');
    const message = await delegateMessage(room.id, second.agentId);
    expect(message?.status).toBe('FAILED');
    expect(message?.content).toBe('');
    expect(message?.error).toMatch(/banned phrase/);
  });

  it.each(['disabled-loop', 'manual-policy', 'disabled-wake', 'paused', 'budget'] as const)('holds delegated work at its own %s gate', async gate => {
    const policy: Partial<PolicyConfig> = gate === 'disabled-loop' ? { tools: { ...DEFAULT_POLICY.tools, capabilityLoop: false } }
      : gate === 'manual-policy' ? { automation: { ...DEFAULT_POLICY.automation, mode: 'MANUAL_ONLY' } }
      : gate === 'budget' ? { budget: { ...DEFAULT_POLICY.budget, maxModelCallsPerDay: 1 } } : {};
    const { second, room } = await setupRoom(policy);
    if (gate === 'disabled-wake') await deliberation.setWake(second.agentId, { enabled: false });
    if (gate === 'paused') await setPauseAll({ paused: true, by: null });
    if (gate === 'budget') await generate({ agentId: second.agentId, jobId: null, purpose: 'CHAT',
      messages: [{ role: 'user', content: 'Use the one allowed call.' }], maxCalls: 1 });
    scripted(second.agentId, () => 'Must not run.');
    await answerNextChatTurn('worker');
    const message = await delegateMessage(room.id, second.agentId);
    if (gate === 'paused') expect(message).toBeUndefined();
    else {
      expect(message?.status).toBe('FAILED');
      const reason = gate === 'disabled-loop' ? /capability loop is disabled/
        : gate === 'manual-policy' ? /AUTONOMOUS/ : gate === 'disabled-wake' ? /wake is disabled/ : /Daily model call limit/;
      expect(message?.error).toMatch(reason);
    }
    expect(await query('SELECT id FROM model_calls WHERE agent_id = $1', [second.agentId])).toHaveLength(gate === 'budget' ? 1 : 0);
  });

  it('stops on PAUSE ALL changed during the delegate model call', async () => {
    const { second, room } = await setupRoom();
    scripted(second.agentId, async () => {
      await setPauseAll({ paused: true, by: null });
      return call('agent.self_state');
    });
    await answerNextChatTurn('worker');
    const message = await delegateMessage(room.id, second.agentId);
    expect(message?.status).toBe('FAILED');
    expect(message?.error).toMatch(/paused/i);
    expect(await query('SELECT id FROM capability_invocations WHERE agent_id = $1', [second.agentId])).toEqual([]);
  });

  it('rechecks a revoked permission after the delegate chooses a capability', async () => {
    const { second, room } = await setupRoom();
    scripted(second.agentId, async () => {
      await capabilityPermissions.set({ agentId: second.agentId, capabilityId: 'agent.self_state', permission: 'DISABLED' });
      return call('agent.self_state');
    });
    await answerNextChatTurn('worker');
    expect((await delegateMessage(room.id, second.agentId))?.error).toMatch(/switched off/);
  });

  it('charges every delegate model call against its own budget', async () => {
    const { second, room } = await setupRoom({ budget: { ...DEFAULT_POLICY.budget, maxModelCallsPerDay: 1 } });
    scripted(second.agentId, prompt => prompt.includes('agent.self_state returned:') ? 'Must not spend a second call.' : call('agent.self_state'));
    await answerNextChatTurn('worker');
    expect((await delegateMessage(room.id, second.agentId))?.status).toBe('FAILED');
    expect(await query('SELECT id FROM model_calls WHERE agent_id = $1', [second.agentId])).toHaveLength(1);
  });

  it('is never offered or invocable on a public turn', async () => {
    const fixture = await createFixture();
    const loop = await runCapabilityLoop({ agentId: fixture.agentId, jobId: null, accountId: null,
      messages: [{ role: 'user', content: 'Delegate a room question.' }], generate: async () => 'A public answer.',
      permissions: new Map(), paused: false });
    expect(loop.shortlist.offered.map(c => c.id)).not.toContain('room.delegate');
    const result = await invokeCapability({ call: { id: 'room.delegate', input: { agentId: fixture.agentId, task: 'Read memory.' } },
      context: { agentId: fixture.agentId, jobId: null, accountId: null, config: {}, logger: console as never },
      permission: { stored: 'ALLOWED', paused: false } });
    expect(result.outcome).toBe('REFUSED');
    expect(result.detail).toMatch(/owner/);
    expect(getCapability('room.delegate')?.audience).toBe('OWNER');
  });

  it('refuses an agent outside the room and self delegation', async () => {
    const { first, room } = await setupRoom();
    const outside = await createFixture();
    const foreign = await createFixture();
    await query('UPDATE agents SET owner_id = $1 WHERE id = $2', [first.ownerId, outside.agentId]);
    for (const id of [outside.agentId, foreign.agentId, first.agentId]) {
      scripted(id, () => 'Must not run.');
      await answerNextChatTurn('worker');
      vi.restoreAllMocks();
      if (id !== first.agentId) await chat.postOwnerMessage({ conversationId: room.id, content: 'Delegate a question.', answerers: [first.agentId] });
    }
    expect(await query('SELECT id FROM jobs')).toEqual([]);
    expect((await chat.listMessages(room.id)).filter(m => m.authorKind === 'AGENT')).toHaveLength(3);
  });

  it('times out an uncooperative model and never publishes its late answer', async () => {
    const { second, room } = await setupRoom();
    let release: ((text: string) => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    scripted(second.agentId, () => {
      entered!();
      return new Promise<string>(resolve => { release = resolve; });
    });
    // Fake only the deadline timers after fixtures exist; Postgres keeps its
    // real I/O scheduling and the provider deliberately ignores cancellation.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const turn = answerNextChatTurn('worker');
    await started;
    await vi.advanceTimersByTimeAsync(DELEGATION_TIMEOUT_MS);
    vi.useRealTimers();
    await turn;
    expect((await delegateMessage(room.id, second.agentId))?.error).toMatch(/timed out/);
    release!('This late answer must never appear.');
    // Waiting for the actual provider call to settle proves cancellation is
    // enforced after generation, rather than trusting the provider to stop.
    await vi.waitFor(async () => {
      const rows = await query("SELECT id FROM model_calls WHERE agent_id = $1 AND status = 'STARTED'", [second.agentId]);
      expect(rows).toEqual([]);
    });
    expect((await delegateMessage(room.id, second.agentId))?.content).toBe('');
    expect(await answerNextChatTurn('worker')).toBe(false);
  });

  it('persists the one-turn claim across a worker retry', async () => {
    const { first, second, room, answer } = await setupRoom();
    const claimed = await chat.claimNextAnswer('worker', 60_000);
    expect(claimed?.id).toBe(answer.id);
    expect(await chat.claimDelegation(answer.id, second.agentId)).toBe(true);
    await chat.settleAnswer(answer.id, 'worker', { status: 'FAILED', content: '', evidence: {}, error: 'Interrupted.' });
    await chat.requeueAnswer(first.ownerId, answer.id);
    const retried = await chat.claimNextAnswer('worker', 60_000);
    await expect(roomDelegation(retried!, { mayResearch: false }).run(second.agentId, 'What is your setup?', new AbortController().signal)).rejects.toThrow(/already used/);
    expect((await chat.listMessages(room.id)).filter(m => m.agentId === second.agentId)).toEqual([]);
  });
});
