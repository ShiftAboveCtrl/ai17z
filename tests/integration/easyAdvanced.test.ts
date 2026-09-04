import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { agents as agentsRepo } from '@xbam/database';
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
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-1234' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}

const body = <T>(response: { json: () => unknown }): T => (response.json() as { data: T }).data;

/** The eleven answers Easy Mode asks for. */
function easySetup(over: Record<string, unknown> = {}) {
  return {
    character: {
      name: 'Scratch',
      description: 'An agent that answers questions about the product.',
      personality: 'Exact, unhurried, comfortable saying it does not know.',
      preset: 'CUSTOM',
      tone: 'Plain and level.',
      speaksLike: 'Short sentences. The answer first.',
      caresAbout: ['local-first software', 'testing'],
      examples: ['I do not know. I would rather say that than guess.'],
      language: 'MIRROR',
    },
    replies: { audience: 'EVERYONE', selectivity: 'BALANCED' },
    posting: { enabled: false, frequency: 'OCCASIONALLY' },
    operation: 'REVIEW_FIRST',
    ...over,
  };
}

/**
 * Easy and Advanced are two views over one configuration, and the way that
 * claim fails is silently: a save from one view quietly resetting something the
 * other view owns. There is no error to notice, and the setting is gone.
 *
 * So these go through the real API in both directions, and check the fields
 * each view cannot see as much as the ones it can.
 */
describe('Easy and Advanced configure the same agent', () => {
  it('what Easy writes, Advanced reads back', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/easy`,
      headers: auth,
      payload: easySetup(),
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const persona = await agentsRepo.getActivePersona(fixture.agentId);
    expect(persona!.displayName).toBe('Scratch');
    expect(persona!.personality).toContain('Exact');
    expect(persona!.styleGuidelines).toContain('The answer first');
    expect(persona!.styleExamples).toContain('I do not know. I would rather say that than guess.');
    expect(persona!.topics).toEqual(['local-first software', 'testing']);
  });

  it('what Advanced writes, Easy reads back', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: easySetup() });

    const edited = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: {
        identityKind: 'FICTIONAL',
        displayName: 'Renamed In Advanced',
        biography: 'Rewritten in the advanced screen.',
        personality: 'Changed there too.',
        tone: 'Drier.',
        styleGuidelines: 'One sentence, then stop.',
        styleExamples: ['Numbers or it did not happen.'],
        topics: ['browsers'],
        languagePolicy: '',
        responseLength: 'SHORT',
        prohibitedBehaviors: ['Never predicts a price'],
        customInstructions: 'The contract address is recorded here.',
        changeNote: 'advanced edit',
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const { view } = body<{ view: { setup: { character: { name: string; personality: string; caresAbout: string[] } } } }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/easy`, headers: auth }),
    );
    expect(view.setup.character.name).toBe('Renamed In Advanced');
    expect(view.setup.character.personality).toBe('Changed there too.');
    expect(view.setup.character.caresAbout).toEqual(['browsers']);
  });

  it('an Easy save does not reset what only Advanced can set', async () => {
    // The failure this whole file exists for. Nothing errors; the setting is
    // simply gone, and the next reply is written without it.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: {
        identityKind: 'BRAND',
        displayName: 'Scratch',
        biography: 'Set in advanced.',
        personality: 'Set in advanced.',
        tone: '',
        styleGuidelines: '',
        styleExamples: [],
        topics: [],
        languagePolicy: '',
        responseLength: 'SHORT',
        prohibitedBehaviors: ['Never predicts a price', 'Never uses emoji'],
        customInstructions: 'The contract address is 0x0000000000000000000000000000000000000001.',
        changeNote: 'advanced only',
      },
    });

    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: easySetup() });

    const persona = await agentsRepo.getActivePersona(fixture.agentId);
    expect(persona!.customInstructions).toContain('0x0000000000000000000000000000000000000001');
    expect(persona!.prohibitedBehaviors).toEqual(['Never predicts a price', 'Never uses emoji']);
    expect(persona!.identityKind).toBe('BRAND');
  });

  it('Easy says out loud what it is not showing', async () => {
    // Silently carrying a setting forward is only half of it. Somebody editing
    // in Easy has to be told there is more, or they will believe what they see
    // is everything the agent is.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: {
        identityKind: 'FICTIONAL',
        displayName: 'Scratch',
        biography: 'x',
        personality: 'x',
        tone: '',
        styleGuidelines: '',
        styleExamples: [],
        topics: [],
        languagePolicy: '',
        responseLength: 'SHORT',
        prohibitedBehaviors: [],
        customInstructions: 'Standing instructions Easy has no field for.',
        changeNote: 'advanced only',
      },
    });

    const { view } = body<{ view: { exact: boolean; beyondEasyMode: string[] } }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/easy`, headers: auth }),
    );
    expect(view.exact).toBe(false);
    expect(view.beyondEasyMode.join(' ')).toMatch(/instruction/i);
  });

  it('saving Easy twice with no edits changes nothing', async () => {
    // Opening a screen and pressing save is not an edit, and must not read as
    // one: a new persona version every time somebody looks makes the version
    // history useless for finding when something actually changed.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: easySetup() });
    const first = await agentsRepo.getActivePersona(fixture.agentId);

    const { view } = body<{ view: { setup: Record<string, unknown> } }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/easy`, headers: auth }),
    );
    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: view.setup });
    const second = await agentsRepo.getActivePersona(fixture.agentId);

    expect(second!.displayName).toBe(first!.displayName);
    expect(second!.personality).toBe(first!.personality);
    expect(second!.styleGuidelines).toBe(first!.styleGuidelines);
    expect(second!.topics).toEqual(first!.topics);
    expect(second!.customInstructions).toBe(first!.customInstructions);
  });

  it('the runtime uses what the interface displays', async () => {
    // A view that shows one thing while the agent runs on another is worse
    // than no view. The active persona is what the pipeline loads.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/easy`,
      headers: auth,
      payload: easySetup({ character: { ...easySetup().character, name: 'Displayed Name' } }),
    });

    const { view } = body<{ view: { setup: { character: { name: string } } } }>(
      await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/easy`, headers: auth }),
    );
    const active = await agentsRepo.getActivePersona(fixture.agentId);
    expect(active!.displayName).toBe(view.setup.character.name);
  });

  it('switching agents does not carry one agent\'s answers to another', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const second = body<{ id: string }>(
      await app.inject({ method: 'POST', url: '/api/agents', headers: auth, payload: { name: 'Second Agent' } }),
    );

    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: easySetup() });

    const other = body<{ view: { setup: { character: { name: string } } } | null }>(
      await app.inject({ method: 'GET', url: `/api/agents/${second.id}/easy`, headers: auth }),
    );
    expect(other.view?.setup.character.name ?? '(none)').not.toBe('Scratch');
  });
});
