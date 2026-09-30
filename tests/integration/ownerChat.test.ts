import { beforeAll, describe, expect, it } from 'vitest';
import { accounts as accountsRepo, chat as chatRepo, memories as memoriesRepo, providers, query, workers as workersRepo } from '@xbam/database';
import {
  answerNextChatTurn,
  addressedAgents,
  chatLookups,
  ingestNormalizedEvent,
  registerIntrospectionCapabilities,
  runCapabilityLoop,
  saveFromChat,
  shortlistCapabilities,
} from '@xbam/runtime';
import { getCapability, invokeCapability, listModelCallable, registerBuiltinCapabilities } from '@xbam/tools';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

beforeAll(() => {
  // Idempotent: the registry refuses only a different object under one id.
  try {
    registerBuiltinCapabilities();
  } catch {
    // Already registered by another file in this process.
  }
  try {
    registerIntrospectionCapabilities();
  } catch {
    // Already registered by another file in this process.
  }
});

async function linkedAccount(agentId: string, ownerId: string, triggers: string[] = ['MENTION']) {
  const account = await accountsRepo.createAccount({ ownerId, channel: 'mock', handle: `chat_${uniqueSuffix()}` });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({ agentId, accountId: account.id, triggerEventTypes: triggers as never, actionType: 'REPLY' });
  return account;
}

async function useModel(fixture: { agentId: string; providerId: string }, model: string) {
  await providers.setModelConfig({ agentId: fixture.agentId, role: 'primary', providerCredentialId: fixture.providerId, model, parameters: {} });
}

describe('owner introspection capabilities', () => {
  it('are refused outside an owner conversation, and never on a public menu', async () => {
    const fixture = await createFixture();
    const ctx = { agentId: fixture.agentId, jobId: null, accountId: null, config: {}, logger: console as never };

    const publicCall = await invokeCapability({
      call: { id: 'agent.self_state', input: {} },
      context: ctx,
      permission: { stored: null, paused: false },
    });
    expect(publicCall.outcome).toBe('REFUSED');
    expect(publicCall.detail).toMatch(/owner/);

    const ownerCall = await invokeCapability({
      call: { id: 'agent.self_state', input: {} },
      context: { ...ctx, audience: 'OWNER' },
      permission: { stored: null, paused: false },
    });
    expect(ownerCall.outcome).toBe('SUCCEEDED');

    const loop = await runCapabilityLoop({
      agentId: fixture.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: "what's broken, why didn't you answer, what are you learning" }],
      generate: async () => 'fine',
      permissions: new Map(),
      paused: false,
    });
    expect(loop.shortlist.offered.map((c) => c.id).filter((id) => getCapability(id)?.audience === 'OWNER')).toEqual([]);
  });

  it.each([
    ["why didn't you answer https://x.com/alice/status/1234567890123 ?", 'agent.explain_silence'],
    ['why did you reply to that post?', 'agent.explain_action'],
    ["what's broken right now?", 'agent.health_report'],
    ['what are you learning at the moment?', 'agent.learning_status'],
    ['how have you grown this week?', 'agent.growth_summary'],
    ['what are your goals?', 'agent.current_goals'],
  ])('routes "%s" to %s', (question, id) => {
    const offered = shortlistCapabilities(listModelCallable(), question).offered.map((c) => c.id);
    expect(offered).toContain(id);
  });

  it('explains a silence from the reason ingest recorded, not a guess', async () => {
    const fixture = await createFixture();
    // Linked for mentions only, so a reply is set aside at the door.
    const account = await linkedAccount(fixture.agentId, fixture.ownerId, ['MENTION']);
    const event = mockEvent('replying to your post about queues', { type: 'REPLY' });
    await ingestNormalizedEvent({ accountId: account.id, event });

    const result = await invokeCapability({
      call: { id: 'agent.explain_silence', input: { ref: event.remoteEventId } },
      context: { agentId: fixture.agentId, jobId: null, accountId: null, config: {}, logger: console as never, audience: 'OWNER' },
      permission: { stored: null, paused: false },
    });
    expect(result.outcome).toBe('SUCCEEDED');
    const output = result.output as { found: boolean; status: string; steps: { detail: string }[] };
    expect(output.found).toBe(true);
    expect(output.status).toBe('NOT_QUEUED');
    expect(output.steps[0]!.detail).toMatch(/not triggered by REPLY/);
  });

  it('says a post was never seen rather than inventing a reason', async () => {
    const fixture = await createFixture();
    const result = await invokeCapability({
      call: { id: 'agent.explain_silence', input: { ref: 'https://x.com/someone/status/1234567890123' } },
      context: { agentId: fixture.agentId, jobId: null, accountId: null, config: {}, logger: console as never, audience: 'OWNER' },
      permission: { stored: null, paused: false },
    });
    expect((result.output as { found: boolean; what: string }).found).toBe(false);
    expect((result.output as { what: string }).what).toMatch(/never saw/);
  });
});

describe('owner chat', () => {
  it('answers with the real agent, using its own state when asked about itself', async () => {
    const fixture = await createFixture();
    await useModel(fixture, 'mock-uses:agent.self_state');
    const conversation = await chatRepo.createConversation({ ownerId: fixture.ownerId, kind: 'AGENT', title: 't', agentIds: [fixture.agentId] });
    await chatRepo.postOwnerMessage({ conversationId: conversation.id, content: 'what is your setup and state right now?', answerers: [fixture.agentId] });

    expect(await answerNextChatTurn('test-worker')).toBe(true);
    const [, answer] = await chatRepo.listMessages(conversation.id);
    expect(answer!.status).toBe('DONE');
    expect(answer!.content).toMatch(/^Checked agent\.self_state/);
    const evidence = answer!.evidence as { usedLiveState: boolean; capabilities: { id: string; outcome: string }[] };
    expect(evidence.usedLiveState).toBe(true);
    expect(evidence.capabilities[0]).toMatchObject({ id: 'agent.self_state', outcome: 'SUCCEEDED' });

    // Nothing the owner said became a memory.
    expect(await query('SELECT count(*)::int AS n FROM memories WHERE agent_id = $1', [fixture.agentId])).toEqual([{ n: 0 }]);
  });

  it('answers in room order, never lets an answer queue another, and keeps each agent to its own memory', async () => {
    const owner = await createFixture();
    const second = await createFixture();
    // Put the second agent under the first owner so both can share a room.
    await query('UPDATE agents SET owner_id = $1 WHERE id = $2', [owner.ownerId, second.agentId]);
    await memoriesRepo.writeMemory({ agentId: second.agentId, scope: 'KNOWLEDGE', memoryType: 'FACT', content: 'The secret launch codename is Heron.', importance: 0.9 });

    const conversation = await chatRepo.createConversation({ ownerId: owner.ownerId, kind: 'ROOM', title: 'r', agentIds: [owner.agentId, second.agentId] });
    const participants = await chatRepo.participants(conversation.id);
    expect(addressedAgents('both of you, summarise the launch', participants, null)).toEqual([owner.agentId, second.agentId]);
    const second_ = participants[1]!;
    expect(addressedAgents(`@${second_.slug} what is the launch codename?`, participants, null)).toEqual([second.agentId]);

    await chatRepo.postOwnerMessage({ conversationId: conversation.id, content: 'what is the launch codename?', answerers: [owner.agentId, second.agentId] });
    let turns = 0;
    while (await answerNextChatTurn('test-worker')) turns += 1;
    expect(turns).toBe(2);

    const messages = await chatRepo.listMessages(conversation.id);
    expect(messages.map((m) => m.authorKind)).toEqual(['OWNER', 'AGENT', 'AGENT']);
    expect(messages[1]!.agentId).toBe(owner.agentId);
    expect(messages[2]!.agentId).toBe(second.agentId);
    // The first agent was given none of the second agent's memories.
    const firstMemories = (messages[1]!.evidence as { memories: { text: string }[] }).memories.map((m) => m.text).join(' ');
    expect(firstMemories).not.toMatch(/Heron/);
    const secondMemories = (messages[2]!.evidence as { memories: { text: string }[] }).memories.map((m) => m.text).join(' ');
    expect(secondMemories).toMatch(/Heron/);
    // Nothing further is waiting: answers never create answers.
    expect(await answerNextChatTurn('test-worker')).toBe(false);
  });

  it('saves only what the owner chose, to the agents they chose, and a deleted conversation keeps it', async () => {
    const fixture = await createFixture();
    const conversation = await chatRepo.createConversation({ ownerId: fixture.ownerId, kind: 'AGENT', title: 'keep', agentIds: [fixture.agentId] });
    const { message } = await chatRepo.postOwnerMessage({ conversationId: conversation.id, content: 'Our launch moved to Friday.', answerers: [] });

    await expect(
      saveFromChat({ ownerId: fixture.ownerId, conversationId: conversation.id, messageId: null, // Assembled here so no secret scanner reads a fixture as a leaked key.
        content: `key ${['sk', 'ant', 'api03', 'x'.repeat(40)].join('-')}`, agentIds: [fixture.agentId], target: 'MEMORY' }),
    ).rejects.toThrow(/secret/);

    const [save] = await saveFromChat({
      ownerId: fixture.ownerId,
      conversationId: conversation.id,
      messageId: message.id,
      content: 'Our launch moved to Friday.',
      agentIds: [fixture.agentId],
      target: 'MEMORY',
    });
    expect(save!.memoryId).toBeTruthy();
    expect(await chatRepo.deleteConversation(fixture.ownerId, conversation.id)).toBe(true);
    expect(await memoriesRepo.getMemory(save!.memoryId!)).not.toBeNull();
  });

  it('is owner scoped: another owner cannot open or save into it', async () => {
    const a = await createFixture();
    const b = await createFixture();
    const conversation = await chatRepo.createConversation({ ownerId: a.ownerId, kind: 'AGENT', title: 'mine', agentIds: [a.agentId] });
    expect(await chatRepo.getConversation(b.ownerId, conversation.id)).toBeNull();
    await expect(
      saveFromChat({ ownerId: b.ownerId, conversationId: conversation.id, messageId: null, content: 'x', agentIds: [a.agentId], target: 'MEMORY' }),
    ).rejects.toThrow();
    // Creating a conversation with somebody else's agent quietly adds nobody.
    const stolen = await chatRepo.createConversation({ ownerId: b.ownerId, kind: 'AGENT', title: 'theirs', agentIds: [a.agentId] });
    expect(await chatRepo.participants(stolen.id)).toEqual([]);
  });
});

describe('owner chat looking things up', () => {
  const question = 'what happened with the Robinhood Chain mainnet launch today?';

  it('decides what to look up exactly as a reply would', async () => {
    const fixture = await createFixture();
    const policy = (await import('@xbam/database')).agents.getActivePolicy(fixture.agentId);
    const lookups = chatLookups(question, (await policy)!.config as never);
    expect(lookups.some((l) => l.kind === 'search')).toBe(true);
    expect(chatLookups('what is your setup right now?', (await policy)!.config as never)).toEqual([]);
  });

  it('hands a turn that needs the web to a worker with a browser, and no other worker takes it', async () => {
    const fixture = await createFixture();
    await workersRepo.heartbeat({ id: `browser-${uniqueSuffix()}`, role: 'browser', browserCapable: true, jobsCapable: false });
    const conversation = await chatRepo.createConversation({ ownerId: fixture.ownerId, kind: 'AGENT', title: 'q', agentIds: [fixture.agentId] });
    await chatRepo.postOwnerMessage({ conversationId: conversation.id, content: question, answerers: [fixture.agentId] });

    expect(await answerNextChatTurn('jobs-worker', { mayResearch: false })).toBe(false);
    const [, held] = await chatRepo.listMessages(conversation.id);
    expect(held!.status).toBe('PENDING');
    // Not claimable again by a worker without a browser.
    expect(await chatRepo.claimNextAnswer('jobs-worker', 60_000, false)).toBeNull();
    // A browser worker takes it.
    const claimed = await chatRepo.claimNextAnswer('browser-worker', 60_000, true);
    expect(claimed?.id).toBe(held!.id);
  });

  it('answers without the web when no browser worker runs, and says what it could not check', async () => {
    const fixture = await createFixture();
    await query('DELETE FROM workers');
    const conversation = await chatRepo.createConversation({ ownerId: fixture.ownerId, kind: 'AGENT', title: 'q', agentIds: [fixture.agentId] });
    await chatRepo.postOwnerMessage({ conversationId: conversation.id, content: question, answerers: [fixture.agentId] });
    expect(await answerNextChatTurn('jobs-worker', { mayResearch: false })).toBe(true);
    const [, answer] = await chatRepo.listMessages(conversation.id);
    expect(answer!.status).toBe('DONE');
    const research = (answer!.evidence as { research: { failed: { reason: string }[] } | null }).research;
    expect(research?.failed.map((f) => f.reason).join(' ')).toMatch(/X account|browser/);
  });
});
