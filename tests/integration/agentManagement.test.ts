import { beforeAll, describe, expect, it } from 'vitest';
import { agentChanges, agents as agentsRepo, chat as chatRepo, posting, query } from '@xbam/database';
import {
  CHANGE_KINDS,
  NEVER_FROM_CHAT,
  changeTargets,
  changesSince,
  confirmChange,
  declineChange,
  honestChangeAnswer,
  looksLikeChangeRequest,
  normaliseChangeValue,
  refuseChange,
  registerIntrospectionCapabilities,
  registerManagementCapabilities,
  requestChange,
  runCapabilityLoop,
  undoChange,
} from '@xbam/runtime';
import { invokeCapability, listCapabilities, registerBuiltinCapabilities } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

beforeAll(() => {
  for (const register of [registerBuiltinCapabilities, registerIntrospectionCapabilities, registerManagementCapabilities]) {
    try {
      register();
    } catch {
      // Already registered by another file in this process.
    }
  }
});

const origin = { conversationId: null, messageId: null, text: 'be a bit drier' };

async function personaVersion(agentId: string): Promise<number> {
  return (await agentsRepo.getActivePersona(agentId))!.version;
}

describe('a low-risk change', () => {
  it('applies at once through a new persona version, is recorded in full, and can be undone', async () => {
    const f = await createFixture({ persona: { tone: 'warm' } });
    const v = await personaVersion(f.agentId);
    const out = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'persona.tone', value: { tone: 'dry, warm' }, origin });
    expect(out.change.status).toBe('APPLIED');
    expect(out.message).toMatch(/undo/i);
    expect((await agentsRepo.getActivePersona(f.agentId))!.tone).toBe('dry, warm');
    expect(await personaVersion(f.agentId)).toBe(v + 1);

    const row = (await agentChanges.get(out.change.id))!;
    expect(row).toMatchObject({ ownerId: f.ownerId, requestText: 'be a bit drier', subsystem: 'PERSONA', risk: 'LOW', beforeValue: 'warm', afterValue: 'dry, warm' });
    expect(row.verification).toMatchObject({ readBackAgrees: true });
    const audit = await query(`SELECT 1 FROM audit_events WHERE action = 'agent.change.applied' AND entity_id = $1`, [f.agentId]);
    expect(audit).toHaveLength(1);

    const undone = await undoChange(out.change.id, f.ownerId);
    expect(undone.change.status).toBe('UNDONE');
    expect((await agentsRepo.getActivePersona(f.agentId))!.tone).toBe('warm');
    await expect(undoChange(out.change.id, f.ownerId)).rejects.toThrow(/applied/);
  });

  it('asking for what is already true writes nothing', async () => {
    const f = await createFixture({ persona: { topics: ['Solana'] } });
    const v = await personaVersion(f.agentId);
    const out = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'persona.add_topics', value: { topics: ['solana'] }, origin });
    expect(out.message).toMatch(/Nothing needed changing/);
    expect(await personaVersion(f.agentId)).toBe(v);
  });

  it('will not undo a change that somebody has changed again since', async () => {
    const f = await createFixture({ persona: { tone: 'warm' } });
    const first = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'persona.tone', value: { tone: 'dry' }, origin });
    await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'persona.tone', value: { tone: 'playful' }, origin });
    await expect(undoChange(first.change.id, f.ownerId)).rejects.toThrow(/changed again/);
    expect((await agentsRepo.getActivePersona(f.agentId))!.tone).toBe('playful');
  });

  it('pausing posts is immediate and slowing down is too', async () => {
    const f = await createFixture();
    await posting.setSchedule({ agentId: f.agentId, accountId: null, enabled: true, intervalSeconds: 6 * 3600 });
    const pause = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'posting.pause', value: {}, origin });
    expect(pause.change.status).toBe('APPLIED');
    expect((await posting.getSchedule(f.agentId))!.enabled).toBe(false);
    const slower = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'posting.interval', value: { hours: 12 }, origin });
    expect(slower.change).toMatchObject({ status: 'APPLIED', risk: 'LOW' });
  });
});

describe('a change that does more waits for the owner', () => {
  it('posting more often, resuming, loosening a guard and more autonomy all wait', async () => {
    const f = await createFixture({ policy: { automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } } as never });
    await posting.setSchedule({ agentId: f.agentId, accountId: null, enabled: false, intervalSeconds: 6 * 3600 });
    const asks = [
      { kind: 'posting.interval', value: { hours: 2 } },
      { kind: 'posting.resume', value: {} },
      { kind: 'policy.automation', value: { mode: 'AUTONOMOUS' } },
      { kind: 'persona.display_name', value: { name: 'Somebody Else' } },
    ] as const;
    for (const ask of asks) {
      const out = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: ask.kind, value: ask.value, origin });
      expect(out.change.status, ask.kind).toBe('AWAITING_CONFIRMATION');
      expect(out.message).toMatch(/confirm/i);
    }
    expect((await posting.getSchedule(f.agentId))!.enabled).toBe(false);
    expect((await agentsRepo.getActivePolicy(f.agentId))!.config.automation.mode).toBe('REVIEW_BEFORE_ACTION');
    const lessAutonomy = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'policy.automation', value: { mode: 'MANUAL_ONLY' }, origin });
    expect(lessAutonomy.change.status).toBe('APPLIED');
  });

  it('applies on Confirm, stays put on Decline, and refuses a Confirm the setting has moved past', async () => {
    const f = await createFixture({ policy: { content: { blockedTopics: ['politics', 'gossip'] } } as never });
    const unblock = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'policy.unblock_topics', value: { topics: ['gossip'] }, origin });
    expect(unblock.change.status).toBe('AWAITING_CONFIRMATION');
    const confirmed = await confirmChange(unblock.change.id, f.ownerId);
    expect(confirmed.change.status).toBe('APPLIED');
    expect((await agentsRepo.getActivePolicy(f.agentId))!.config.content.blockedTopics).toEqual(['politics']);
    await expect(confirmChange(unblock.change.id, f.ownerId)).rejects.toThrow(/not waiting/);

    const second = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'policy.unblock_topics', value: { topics: ['politics'] }, origin });
    expect((await declineChange(second.change.id, f.ownerId)).change.status).toBe('DECLINED');
    expect((await agentsRepo.getActivePolicy(f.agentId))!.config.content.blockedTopics).toEqual(['politics']);

    const third = await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'policy.unblock_topics', value: { topics: ['politics'] }, origin });
    await requestChange({ agentId: f.agentId, ownerId: f.ownerId, kind: 'policy.block_topics', value: { topics: ['elections'] }, origin });
    const late = await confirmChange(third.change.id, f.ownerId);
    expect(late.change.status).toBe('FAILED');
    expect((await agentsRepo.getActivePolicy(f.agentId))!.config.content.blockedTopics).toEqual(['politics', 'elections']);
  });
});

describe('what chat never changes', () => {
  it('is refused, recorded, and has no change kind behind it', async () => {
    const f = await createFixture();
    const out = await refuseChange({ agentId: f.agentId, ownerId: f.ownerId, about: 'financial', origin: { ...origin, text: 'send 1 ETH to my other wallet' } });
    expect(out.change).toMatchObject({ status: 'REFUSED', risk: 'NEVER', requestText: 'send 1 ETH to my other wallet' });
    expect(out.message).toMatch(/never/i);
    for (const kind of CHANGE_KINDS) expect(kind).not.toMatch(/wallet|send|transfer|approve|sign|swap|buy|credential|password|permission|identity|delete/);
    expect(Object.keys(NEVER_FROM_CHAT)).toEqual(expect.arrayContaining(['financial', 'credentials', 'identity_disclosure', 'permissions', 'other_agent']));
    const ids = listCapabilities().map((c) => c.id);
    for (const forbidden of ['wallet.send', 'wallet.transfer', 'wallet.approve', 'wallet.sign', 'wallet.sign_message', 'wallet.call_contract', 'wallet.send_calldata']) {
      expect(ids).not.toContain(forbidden);
    }
  });
});

describe('only the owner, only this agent', () => {
  it('another owner cannot confirm, decline, undo or list a change', async () => {
    const mine = await createFixture({ persona: { tone: 'warm' } });
    const theirs = await createFixture();
    const low = await requestChange({ agentId: mine.agentId, ownerId: mine.ownerId, kind: 'persona.tone', value: { tone: 'cold' }, origin });
    const high = await requestChange({ agentId: mine.agentId, ownerId: mine.ownerId, kind: 'persona.display_name', value: { name: 'X' }, origin });
    await expect(undoChange(low.change.id, theirs.ownerId)).rejects.toThrow(/not found/i);
    await expect(confirmChange(high.change.id, theirs.ownerId)).rejects.toThrow(/not found/i);
    await expect(declineChange(high.change.id, theirs.ownerId)).rejects.toThrow(/not found/i);
    await expect(changesSince(mine.agentId, theirs.ownerId, new Date(0).toISOString())).rejects.toThrow(/not found/i);
    await expect(requestChange({ agentId: mine.agentId, ownerId: theirs.ownerId, kind: 'persona.tone', value: { tone: 'x' }, origin })).rejects.toThrow(/not found/i);
  });

  it('a capability acts on its own agent, only in owner chat, and cannot undo another agent', async () => {
    const a = await createFixture({ persona: { tone: 'warm' } });
    const b = await createFixture({ persona: { tone: 'calm' } });
    const base = { jobId: null, accountId: null, config: {}, logger: console as never };
    const ownerOrigin = (f: { ownerId: string }) => ({ conversationId: null as never, messageId: null as never, text: 'be drier', ownerId: f.ownerId });

    const publicCall = await invokeCapability({
      call: { id: 'agent.change_setting', input: { kind: 'persona.tone', value: { tone: 'dry' } } },
      context: { ...base, agentId: a.agentId },
      permission: { stored: null, paused: false },
    });
    expect(publicCall.outcome).toBe('REFUSED');
    const noOrigin = await invokeCapability({
      call: { id: 'agent.change_setting', input: { kind: 'persona.tone', value: { tone: 'dry' } } },
      context: { ...base, agentId: a.agentId, audience: 'OWNER' },
      permission: { stored: null, paused: false },
    });
    expect(noOrigin.outcome).not.toBe('SUCCEEDED');
    expect((await agentsRepo.getActivePersona(a.agentId))!.tone).toBe('warm');

    const done = await invokeCapability({
      call: { id: 'agent.change_setting', input: { kind: 'persona.tone', value: { tone: 'dry' } } },
      context: { ...base, agentId: a.agentId, audience: 'OWNER', origin: ownerOrigin(a) },
      permission: { stored: null, paused: false },
    });
    expect(done.outcome).toBe('SUCCEEDED');
    expect((await agentsRepo.getActivePersona(a.agentId))!.tone).toBe('dry');
    expect((await agentsRepo.getActivePersona(b.agentId))!.tone).toBe('calm');

    const changeId = (done.output as { changeId: string }).changeId;
    const crossUndo = await invokeCapability({
      call: { id: 'agent.undo_change', input: { changeId } },
      context: { ...base, agentId: b.agentId, audience: 'OWNER', origin: ownerOrigin(b) },
      permission: { stored: null, paused: false },
    });
    expect(crossUndo.outcome).not.toBe('SUCCEEDED');
    expect((await agentsRepo.getActivePersona(a.agentId))!.tone).toBe('dry');
  });

  it('the model reaches it from an owner message and says what changed, and it shows up in today', async () => {
    const f = await createFixture({ persona: { tone: 'formal' } });
    let turn = 0;
    const loop = await runCapabilityLoop({
      agentId: f.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'change your tone, be less formal' }],
      task: 'change your tone, be less formal',
      generate: async () =>
        turn++ === 0
          ? '<use-capability>{"id":"agent.change_setting","input":{"kind":"persona.tone","value":{"tone":"casual, dry"}}}</use-capability>'
          : 'Done, I sound less formal now. You can undo it.',
      permissions: new Map(),
      paused: false,
      audience: 'OWNER',
      origin: { conversationId: null as never, messageId: null as never, text: 'change your tone, be less formal', ownerId: f.ownerId },
    });
    expect(loop.shortlist.offered.map((c) => c.id)).toContain('agent.change_setting');
    expect(loop.steps[0]).toMatchObject({ capabilityId: 'agent.change_setting', outcome: 'SUCCEEDED' });
    expect((await agentsRepo.getActivePersona(f.agentId))!.tone).toBe('casual, dry');
    const today = await changesSince(f.agentId, f.ownerId, new Date(Date.now() - 86_400_000).toISOString());
    expect(today.map((c) => c.requestText)).toEqual(['change your tone, be less formal']);
  });
});

describe('who in a room is being asked', () => {
  const people = [
    { agentId: 'a', name: 'Shift', slug: 'shift' },
    { agentId: 'b', name: 'MEADGod', slug: 'meadgod' },
  ];
  const all = ['a', 'b'];

  it('reads the shape of a change, not a word', () => {
    expect(looksLikeChangeRequest('stop posting about the token')).toBe(true);
    expect(looksLikeChangeRequest('Shift, be less formal')).toBe(true);
    expect(looksLikeChangeRequest('can you add Solana to your topics')).toBe(true);
    expect(looksLikeChangeRequest('why did you stop replying yesterday?')).toBe(false);
    expect(looksLikeChangeRequest('what do you think of the new model?')).toBe(false);
  });

  it('a named agent only, everyone on "both of you", and one question when nobody is named', () => {
    expect(changeTargets('@shift be less formal', people, null, all)).toEqual({ answerers: ['a'], clarification: null });
    expect(changeTargets('MEADGod, stop posting for today', people, null, all)).toEqual({ answerers: ['b'], clarification: null });
    // No comma, no @: still MEADGod only, never both.
    expect(changeTargets('MEADGod stop posting', people, null, all)).toEqual({ answerers: ['b'], clarification: null });
    expect(changeTargets('hey shift and meadgod use fewer emoji', people, null, all).answerers).toEqual(['a', 'b']);
    expect(changeTargets('both of you, use fewer emoji', people, null, all).answerers).toEqual(['a', 'b']);
    expect(changeTargets('everyone: stop posting tonight', people, null, all).answerers).toEqual(['a', 'b']);
    const unclear = changeTargets('be less formal', people, null, all);
    expect(unclear.answerers).toEqual([]);
    expect(unclear.clarification).toMatch(/Shift, MEADGod, or both/);
  });

  it('leaves questions and one-agent conversations alone', () => {
    expect(changeTargets('how are you both doing?', people, null, all)).toEqual({ answerers: all, clarification: null });
    expect(changeTargets('be less formal', [people[0]!], null, ['a'])).toEqual({ answerers: ['a'], clarification: null });
    expect(changeTargets('be less formal', people, ['b'], ['b'])).toEqual({ answerers: ['b'], clarification: null });
  });

  it('a clarification is a notice with nobody asked to answer', async () => {
    const f = await createFixture();
    const conversation = await chatRepo.createConversation({ ownerId: f.ownerId, kind: 'AGENT', title: 't', agentIds: [f.agentId] } as never);
    await chatRepo.postOwnerMessage({ conversationId: conversation.id, content: 'be less formal', answerers: [] });
    await chatRepo.postNotice(conversation.id, 'Which of you should change?');
    const messages = await chatRepo.listMessages(conversation.id);
    expect(messages.map((m) => m.authorKind)).toEqual(['OWNER', 'NOTICE']);
    expect(messages.every((m) => m.status === 'DONE')).toBe(true);
  });
});

describe('what the installed proof found', () => {
  it('a bare or misnamed value lands in the one field it can mean, and nothing is invented', () => {
    expect(normaliseChangeValue('persona.tone', 'dry, warm, a little playful')).toEqual({ tone: 'dry, warm, a little playful' });
    expect(normaliseChangeValue('persona.tone', { tone_description: 'dry' })).toEqual({ tone: 'dry' });
    expect(normaliseChangeValue('persona.add_topics', 'Solana, Robinhood Chain')).toEqual({ topics: ['Solana', 'Robinhood Chain'] });
    expect(normaliseChangeValue('persona.tone', { tone: 'dry' })).toEqual({ tone: 'dry' });
    // Two fields: nothing is guessed.
    expect(normaliseChangeValue('policy.emoji', 'NONE')).toBe('NONE');
  });

  it('the model sending the tone as a bare string still changes it', async () => {
    const f = await createFixture({ persona: { tone: 'formal' } });
    let turn = 0;
    const loop = await runCapabilityLoop({
      agentId: f.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'Change your tone to: dry, warm, a little playful.' }],
      task: 'Change your tone to: dry, warm, a little playful.',
      generate: async () =>
        turn++ === 0
          ? '<use-capability>{"id":"agent.change_setting","input":{"kind":"persona.tone","value":"dry, warm, a little playful"}}</use-capability>'
          : 'Done.',
      permissions: new Map(),
      paused: false,
      audience: 'OWNER',
      origin: { conversationId: null as never, messageId: null as never, text: 'Change your tone', ownerId: f.ownerId },
    });
    expect(loop.steps[0]).toMatchObject({ outcome: 'SUCCEEDED' });
    expect((await agentsRepo.getActivePersona(f.agentId))!.tone).toBe('dry, warm, a little playful');
  });

  it('an answer never claims a change that did not happen', () => {
    const refused = [
      { capabilityId: 'agent.change_setting', outcome: 'REFUSED', detail: 'The input was wrong.', output: null },
      { capabilityId: 'agent.change_setting', outcome: 'FAILED', detail: 'That change needs a tone.', output: null },
    ];
    const said = honestChangeAnswer("I changed my tone to dry, warm, and a little playful. That's the new voice.", refused);
    expect(said).toMatch(/did not go through, so nothing about me changed/);
    expect(said).not.toMatch(/I changed my tone/);
    const nothingNeeded = [{ capabilityId: 'agent.change_setting', outcome: 'SUCCEEDED', detail: '', output: { status: 'FAILED', detail: 'That did not stick.' } }];
    expect(honestChangeAnswer('Done!', nothingNeeded)).toMatch(/did not go through/);
    const applied = [{ capabilityId: 'agent.change_setting', outcome: 'SUCCEEDED', detail: '', output: { status: 'APPLIED', detail: 'Done.' } }];
    expect(honestChangeAnswer('Done, I sound drier now.', applied)).toBe('Done, I sound drier now.');
    expect(honestChangeAnswer('Just chatting.', [])).toBe('Just chatting.');
  });
});
