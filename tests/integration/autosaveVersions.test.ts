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
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${(r.json() as { data: { token: string } }).data.token}` };
}

const persona = (over: Record<string, unknown> = {}) => ({
  identityKind: 'FICTIONAL',
  displayName: 'Scratch',
  biography: '',
  personality: 'Exact and unhurried.',
  tone: '',
  styleGuidelines: '',
  styleExamples: [],
  topics: [],
  languagePolicy: '',
  responseLength: 'SHORT',
  prohibitedBehaviors: [],
  customInstructions: '',
  changeNote: '',
  ...over,
});

const versionCount = async (agentId: string) => (await agentsRepo.listPersonaVersions(agentId)).length;

/**
 * Version history exists to answer one question: when did this actually change.
 *
 * Autosaving every pause in typing destroys that answer -- an afternoon of
 * editing leaves forty versions, none of them a decision anybody made. So does
 * cutting a version when somebody opens a screen and presses save without
 * touching anything.
 */
describe('what creates a persona version', () => {
  it('saving an unchanged persona creates nothing', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const active = await agentsRepo.getActivePersona(fixture.agentId);
    const before = await versionCount(fixture.agentId);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({
        identityKind: active!.identityKind,
        displayName: active!.displayName,
        biography: active!.biography,
        personality: active!.personality,
        tone: active!.tone,
        styleGuidelines: active!.styleGuidelines,
        styleExamples: active!.styleExamples,
        topics: active!.topics,
        languagePolicy: active!.languagePolicy,
        responseLength: active!.responseLength,
        prohibitedBehaviors: active!.prohibitedBehaviors,
        customInstructions: active!.customInstructions,
        // A different note describing the same content is not a change to the
        // agent, and treating it as one would make every save an edit.
        changeNote: 'a different note about the same content',
      }),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await versionCount(fixture.agentId)).toBe(before);
  });

  it('a real change creates one version', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const before = await versionCount(fixture.agentId);

    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({ personality: 'Something genuinely different.' }),
    });

    expect(await versionCount(fixture.agentId)).toBe(before + 1);
    expect((await agentsRepo.getActivePersona(fixture.agentId))!.personality).toBe('Something genuinely different.');
  });

  it('a burst of autosaves leaves one version, not one each', async () => {
    // Typing a sentence is one edit, however many pauses it contains.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const before = await versionCount(fixture.agentId);

    for (const text of ['A', 'An ex', 'An exact', 'An exact and unhurried agent.']) {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/agents/${fixture.agentId}/persona?autosave=1`,
        headers: auth,
        payload: persona({ personality: text }),
      });
      expect(r.statusCode, r.body).toBe(200);
    }

    expect(await versionCount(fixture.agentId)).toBe(before + 1);
    expect((await agentsRepo.getActivePersona(fixture.agentId))!.personality).toBe('An exact and unhurried agent.');
  });

  it('an explicit save after autosaves is its own version', async () => {
    // The deliberate act is worth recording separately from the typing that
    // led to it, so the history has a point somebody chose.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona?autosave=1`,
      headers: auth,
      payload: persona({ personality: 'Draft in progress.' }),
    });
    const afterAutosave = await versionCount(fixture.agentId);

    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({ personality: 'Finished.', changeNote: 'done' }),
    });

    expect(await versionCount(fixture.agentId)).toBe(afterAutosave + 1);
  });

  it('autosaving back to what it already said creates nothing', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await app.inject({
      method: 'PUT',
      url: `/api/agents/${fixture.agentId}/persona`,
      headers: auth,
      payload: persona({ personality: 'Settled.' }),
    });
    const before = await versionCount(fixture.agentId);

    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: 'PUT',
        url: `/api/agents/${fixture.agentId}/persona?autosave=1`,
        headers: auth,
        payload: persona({ personality: 'Settled.' }),
      });
    }
    expect(await versionCount(fixture.agentId)).toBe(before);
  });

  it('the active version is always what was last saved', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    for (const text of ['one', 'two', 'three']) {
      await app.inject({
        method: 'PUT',
        url: `/api/agents/${fixture.agentId}/persona?autosave=1`,
        headers: auth,
        payload: persona({ personality: text }),
      });
    }
    expect((await agentsRepo.getActivePersona(fixture.agentId))!.personality).toBe('three');
  });
});

/**
 * Easy Mode writes both the persona and the policy on every save, so the same
 * rule has to hold on both sides: opening the screen and pressing save is not
 * an edit, and an agent nobody changed must not collect a version every time
 * somebody looks at it.
 */
describe('saving from Easy Mode', () => {
  const easySetup = () => ({
    character: {
      name: 'Scratch',
      description: 'd',
      personality: 'p',
      preset: 'CUSTOM',
      tone: 't',
      speaksLike: 's',
      caresAbout: ['a'],
      examples: ['one two three four'],
      language: 'MIRROR',
    },
    replies: { audience: 'EVERYONE', selectivity: 'BALANCED' },
    posting: { enabled: false, frequency: 'OCCASIONALLY' },
    operation: 'REVIEW_FIRST',
  });

  it('creates no version at all when nothing was changed', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);

    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: easySetup() });
    const personas = await versionCount(fixture.agentId);
    const policies = (await agentsRepo.listPolicyVersions(fixture.agentId)).length;

    // Save the identical answers again, which is what pressing save on an
    // unchanged screen does.
    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: easySetup() });

    expect(await versionCount(fixture.agentId)).toBe(personas);
    expect((await agentsRepo.listPolicyVersions(fixture.agentId)).length).toBe(policies);
  });

  it('still records a version when something did change', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: easySetup() });
    const before = await versionCount(fixture.agentId);

    const changed = easySetup();
    changed.character.personality = 'Something genuinely different.';
    await app.inject({ method: 'PUT', url: `/api/agents/${fixture.agentId}/easy`, headers: auth, payload: changed });

    expect(await versionCount(fixture.agentId)).toBe(before + 1);
  });
});
