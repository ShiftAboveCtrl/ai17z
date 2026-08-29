import { describe, expect, it } from 'vitest';
import { EasySetup, type PolicyConfig } from '@xbam/shared/contracts';
import { agents, posting } from '@xbam/database';
import { postIntervalSeconds, readEasyView, toPersona, toPolicy, toRadarSourceKinds } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Easy Mode through real storage, not just through the pure functions.
 *
 * The unit tests prove the projection is correct in memory. This proves the
 * versioned round trip: save from Easy, read the persisted persona and policy
 * back, and get the same answers. A projection that is right in a function and
 * wrong after a database write would be worse than no projection.
 */

const setup = EasySetup.parse({
  character: {
    name: 'Atlas',
    description: 'Watches protocol governance.',
    personality: 'Sceptical, patient.',
    caresAbout: ['governance'],
    examples: ['Distribution changed. The vote did not.'],
    preset: 'OPINIONATED',
  },
  replies: { audience: 'EXCEPT_SPAM', selectivity: 'ONLY_WHEN_USEFUL' },
  posting: { enabled: true, frequency: 'DAILY' },
  operation: 'AUTOMATIC',
});

/** Everything the Easy endpoint does, without going through HTTP. */
async function saveEasy(agentId: string, ownerId: string, answers = setup) {
  const [persona, policy] = await Promise.all([
    agents.getActivePersona(agentId),
    agents.getActivePolicy(agentId),
  ]);
  await agents.savePersonaVersion(agentId, toPersona(answers, persona ?? undefined), ownerId);
  await agents.savePolicyVersion(agentId, toPolicy(answers, policy?.config), 'Easy Mode', ownerId);
  const interval = postIntervalSeconds(answers);
  await posting.setSchedule({
    agentId,
    accountId: null,
    enabled: interval !== null,
    intervalSeconds: interval ?? 21_600,
  });
}

async function loadEasy(agentId: string) {
  const [persona, policy, schedule] = await Promise.all([
    agents.getActivePersona(agentId),
    agents.getActivePolicy(agentId),
    posting.getSchedule(agentId),
  ]);
  return readEasyView({
    persona: persona!,
    policy: policy!.config,
    postIntervalSeconds: schedule?.enabled ? schedule.intervalSeconds : null,
    radarSourceKinds: toRadarSourceKinds(setup),
  });
}

describe('saving from Easy Mode and reading it back', () => {
  it('produces the same answers after a database round trip', async () => {
    const fixture = await createFixture();
    await saveEasy(fixture.agentId, fixture.ownerId);

    const view = await loadEasy(fixture.agentId);
    expect(view.exact).toBe(true);
    expect(view.setup.character.name).toBe('Atlas');
    expect(view.setup.character.preset).toBe('OPINIONATED');
    expect(view.setup.character.caresAbout).toEqual(['governance']);
    expect(view.setup.replies.selectivity).toBe('ONLY_WHEN_USEFUL');
    expect(view.setup.posting).toEqual({ enabled: true, frequency: 'DAILY' });
    expect(view.setup.operation).toBe('AUTOMATIC');
  });

  it('writes ordinary versions the advanced screens can read', async () => {
    const fixture = await createFixture();
    const before = await agents.getActivePolicy(fixture.agentId);
    await saveEasy(fixture.agentId, fixture.ownerId);

    const persona = await agents.getActivePersona(fixture.agentId);
    const policy = await agents.getActivePolicy(fixture.agentId);
    // Not a special row, not a separate table: the next version of the same
    // documents, with the same history behind them.
    expect(policy!.version).toBe((before?.version ?? 0) + 1);
    expect(persona!.tone).toContain('Has a view');
    expect(persona!.responseLength).toBe('SHORT');
    expect(policy!.config.automation.mode).toBe('AUTONOMOUS');
    expect(policy!.config.engagement.minimumReplyValue).toBe(60);
  });

  it('leaves an advanced setting alone and then reports it', async () => {
    const fixture = await createFixture();
    const existing = await agents.getActivePolicy(fixture.agentId);
    const advanced: PolicyConfig = {
      ...existing!.config,
      output: { ...existing!.config.output, bannedPhrases: ['as an AI'], maxCharacters: 180 },
      identity: { ...existing!.config.identity, disclosure: 'ALWAYS' },
    };
    await agents.savePolicyVersion(fixture.agentId, advanced, 'set in Advanced', fixture.ownerId);

    await saveEasy(fixture.agentId, fixture.ownerId);
    const after = await agents.getActivePolicy(fixture.agentId);

    // Untouched by an Easy Mode save.
    expect(after!.config.output.bannedPhrases).toEqual(['as an AI']);
    expect(after!.config.output.maxCharacters).toBe(180);
    expect(after!.config.identity.disclosure).toBe('ALWAYS');

    // And reported rather than hidden.
    const view = await loadEasy(fixture.agentId);
    expect(view.exact).toBe(false);
    expect(view.beyondEasyMode.join(' ')).toContain('banned phrase');
  });

  it('saving twice changes nothing the second time', async () => {
    // Someone opening the screen and pressing save must not alter their agent.
    const fixture = await createFixture();
    await saveEasy(fixture.agentId, fixture.ownerId);
    const first = await agents.getActivePolicy(fixture.agentId);
    const firstPersona = await agents.getActivePersona(fixture.agentId);

    const view = await loadEasy(fixture.agentId);
    await saveEasy(fixture.agentId, fixture.ownerId, view.setup);

    const second = await agents.getActivePolicy(fixture.agentId);
    const secondPersona = await agents.getActivePersona(fixture.agentId);
    expect(second!.config).toEqual(first!.config);
    expect({ ...secondPersona, id: null, version: null, createdAt: null }).toEqual({
      ...firstPersona,
      id: null,
      version: null,
      createdAt: null,
    });
  });

  it('turning posting off clears the appointment', async () => {
    const fixture = await createFixture();
    await saveEasy(fixture.agentId, fixture.ownerId);
    expect((await posting.getSchedule(fixture.agentId))?.enabled).toBe(true);

    await saveEasy(fixture.agentId, fixture.ownerId, {
      ...setup,
      posting: { enabled: false, frequency: 'DAILY' },
    });
    const schedule = await posting.getSchedule(fixture.agentId);
    expect(schedule?.enabled).toBe(false);
    expect(schedule?.nextPostAt).toBeNull();
  });
});
