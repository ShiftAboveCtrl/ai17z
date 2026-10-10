import { describe, expect, it } from 'vitest';
import { carryOut, parseCommands, STALE_COMMAND_MS, STUDIO_COMMANDS, type StudioCommand } from '../../packages/runtime/src/studioControl';

/**
 * The control channel from AI17Z Studio. What is pinned: the list of verbs is
 * closed and exact; a command Studio sent too long ago is answered and not
 * carried out; resuming goes through the same preflight as Start and repeats
 * its refusal; an agent that was never set up is not started from a phone;
 * and a malformed answer from Studio produces no command at all.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';

function fakeEffects(agent: { id: string; name: string; state: string } | null, resume: { ok: true } | { ok: false; why: string } = { ok: true }) {
  const calls: string[] = [];
  return {
    calls,
    effects: {
      agent: async () => agent,
      pause: async (id: string) => void calls.push(`pause:${id}`),
      resume: async (id: string) => {
        calls.push(`resume:${id}`);
        return resume;
      },
      pauseAll: async (paused: boolean) => void calls.push(`pauseAll:${paused}`),
      audit: async (action: string) => void calls.push(`audit:${action}`),
    },
  };
}

const command = (kind: string, extra: Partial<StudioCommand> = {}): StudioCommand => ({ id: ID, kind, agentId: AGENT, ageMs: 1_000, ...extra });

describe('Studio commands', () => {
  it('is exactly six verbs, none of which writes anything an agent says or types into a page', () => {
    expect([...STUDIO_COMMANDS]).toEqual(['PAUSE_AGENT', 'RESUME_AGENT', 'PAUSE_ALL', 'RESUME_ALL', 'START_VIEW', 'STOP_VIEW']);
  });

  it('shows a browser only where something can show one', async () => {
    const { effects } = fakeEffects({ id: AGENT, name: 'Scout', state: 'ACTIVE' });
    expect(await carryOut(command('START_VIEW'), effects)).toMatchObject({ ok: false, sentence: expect.stringMatching(/does not run the browser/) });
    const shown: string[] = [];
    const withBrowser = { ...effects, startView: async (id: string, name: string) => (shown.push(id), { ok: true, sentence: `Showing ${name}'s browser.` }), stopView: async () => true };
    expect(await carryOut(command('START_VIEW'), withBrowser)).toMatchObject({ ok: true, sentence: "Showing Scout's browser." });
    expect(shown).toEqual([AGENT]);
    expect(await carryOut(command('STOP_VIEW'), withBrowser)).toMatchObject({ ok: true, sentence: "Stopped showing Scout's browser." });
  });

  it('refuses a verb it does not know, and touches nothing', async () => {
    const { calls, effects } = fakeEffects({ id: AGENT, name: 'Scout', state: 'ACTIVE' });
    const result = await carryOut(command('POST_REPLY'), effects);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('answers a stale command without carrying it out', async () => {
    const { calls, effects } = fakeEffects({ id: AGENT, name: 'Scout', state: 'ACTIVE' });
    const result = await carryOut(command('PAUSE_AGENT', { ageMs: STALE_COMMAND_MS + 1 }), effects);
    expect(result).toMatchObject({ ok: false, sentence: expect.stringMatching(/too long after/) });
    expect(calls).toEqual([]);
    // An age Studio did not state is not assumed to be fresh.
    expect((await carryOut(command('PAUSE_ALL', { ageMs: Number.POSITIVE_INFINITY }), effects)).ok).toBe(false);
  });

  it('pauses an agent and audits it, and says so plainly when it was already paused', async () => {
    const running = fakeEffects({ id: AGENT, name: 'Scout', state: 'ACTIVE' });
    expect(await carryOut(command('PAUSE_AGENT'), running.effects)).toMatchObject({ ok: true, sentence: 'Scout is paused.' });
    expect(running.calls).toEqual([`pause:${AGENT}`, 'audit:agent.paused']);
    const paused = fakeEffects({ id: AGENT, name: 'Scout', state: 'PAUSED' });
    expect(await carryOut(command('PAUSE_AGENT'), paused.effects)).toMatchObject({ ok: true, sentence: 'Scout was already paused.' });
    expect(paused.calls).toEqual([]);
  });

  it('resumes through the preflight and repeats its refusal', async () => {
    const refused = fakeEffects({ id: AGENT, name: 'Scout', state: 'PAUSED' }, { ok: false, why: 'Not started: No AI model is connected. Choose a provider and a model.' });
    expect(await carryOut(command('RESUME_AGENT'), refused.effects)).toMatchObject({ ok: false, sentence: expect.stringMatching(/No AI model/) });
    expect(refused.calls).toEqual([`resume:${AGENT}`]);
  });

  it('never starts an agent that was never set up', async () => {
    const draft = fakeEffects({ id: AGENT, name: 'Scout', state: 'DRAFT' });
    expect((await carryOut(command('RESUME_AGENT'), draft.effects)).ok).toBe(false);
    expect(draft.calls).toEqual([]);
  });

  it('pauses everything through the one kill switch', async () => {
    const { calls, effects } = fakeEffects(null);
    expect((await carryOut(command('PAUSE_ALL', { agentId: null }), effects)).ok).toBe(true);
    expect(calls).toEqual(['pauseAll:true', 'audit:studio.command.pause_all']);
  });

  it('reads only well formed commands off an answer', () => {
    expect(parseCommands(null)).toEqual([]);
    expect(parseCommands({ commands: 'PAUSE_ALL' })).toEqual([]);
    const parsed = parseCommands({
      commands: [
        { id: ID, kind: 'PAUSE_AGENT', agent_id: AGENT, age_seconds: 4 },
        { id: 'not-an-id', kind: 'PAUSE_ALL', age_seconds: 1 },
        { id: ID, kind: 'PAUSE_AGENT', agent_id: '../etc', age_seconds: 1 },
      ],
    });
    expect(parsed).toEqual([
      { id: ID, kind: 'PAUSE_AGENT', agentId: AGENT, ageMs: 4_000 },
      { id: ID, kind: 'PAUSE_AGENT', agentId: null, ageMs: 1_000 },
    ]);
  });
});
