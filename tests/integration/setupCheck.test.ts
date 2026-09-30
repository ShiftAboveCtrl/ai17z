import { describe, expect, it } from 'vitest';
import { knowledge as knowledgeRepo, learning as learningRepo, query } from '@xbam/database';
import { agentSetupCheck, describeLearning, settingHref, sortFailures, topicCovered } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

describe('agent setup check', () => {
  it('reports a fresh agent as not set up, never as broken, and links every fix', async () => {
    const fixture = await createFixture();
    const report = await agentSetupCheck(fixture.agentId);
    const checks = report.sections.flatMap((s) => s.checks.map((c) => ({ ...c, section: s.key })));

    expect(checks.filter((c) => c.state === 'PROBLEM').map((c) => `${c.section}: ${c.sentence}`)).toEqual([]);
    expect(checks.find((c) => c.section === 'knowledge' && c.key === 'none')?.state).toBe('NOT_SET_UP');
    expect(checks.find((c) => c.section === 'account')?.state).toBe('NOT_SET_UP');
    for (const check of checks) if (check.fix) expect(check.fix.href.startsWith('/')).toBe(true);
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(checks.length);
  });

  it('names a failed knowledge source and a subject it talks about with nothing to read', async () => {
    const fixture = await createFixture({ persona: { topics: ['Pons', 'bonding curves'] } });
    const source = await knowledgeRepo.createSource({ agentId: fixture.agentId, name: 'Pons docs', kind: 'URL', location: 'https://docs.example.test' });
    await query(`UPDATE knowledge_sources SET error_kind = 'FAILED', last_error = 'timed out', last_attempt_at = now() WHERE id = $1`, [source.id]);

    const report = await agentSetupCheck(fixture.agentId);
    const knowledge = report.sections.find((s) => s.key === 'knowledge')!.checks;
    const failed = knowledge.find((c) => c.key === 'failed')!;
    expect(failed.state).toBe('PROBLEM');
    expect(failed.sentence).toMatch(/Pons docs/);
    expect(failed.fix?.href).toBe(`/agents/${fixture.agentId}#knowledge`);
    // Pons is named by a source; bonding curves is not.
    const uncovered = knowledge.find((c) => c.key === 'uncovered')!;
    expect(uncovered.sentence).toMatch(/bonding curves/);
    expect(uncovered.sentence).not.toMatch(/Pons/);
  });

  it('treats an account the owner disconnected as not in use, never as broken', async () => {
    const fixture = await createFixture();
    const { accounts } = await import('@xbam/database');
    const account = await accounts.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: 'parked' });
    await accounts.updateAccount(account.id, { status: 'DISCONNECTED', enabled: false });
    await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, triggerEventTypes: ['MENTION'], actionType: 'REPLY' });
    const report = await agentSetupCheck(fixture.agentId);
    const check = report.sections.find((s) => s.key === 'account')!.checks.find((c) => c.key === account.id)!;
    expect(check.state).toBe('NOT_SET_UP');
  });

  it('sends Social Radar to the account it reads through', () => {
    expect(settingHref('a', 'radar', 'acc')).toBe('/settings?account=acc&focus=radar');
    expect(settingHref('a', 'radar', null)).toBe('/settings#accounts');
    expect(settingHref('a', 'beliefs')).toBe('/agents/a#beliefs');
  });
});

describe('learning, as an owner reads it', () => {
  it('says how far a running trial has got and what the learner can never change', async () => {
    const fixture = await createFixture();
    await learningRepo.startTrial({ agentId: fixture.agentId, dimension: 'asking', arm: 'ASK', hypothesis: 'Asking a question gets more replies.' });
    const view = await describeLearning(fixture.agentId);
    const trial = view.trials.find((t) => t.status === 'RUNNING')!;
    expect(trial.samples).toMatchObject({ withChange: 0, control: 0, neededWithChange: 8, neededControl: 3 });
    expect(view.rules.neverTouches).toEqual(expect.arrayContaining(['identity', 'permissions', 'do not contact', 'financial policy']));
    expect(view.rules.controlWhileTesting).toMatch(/one decision in 5/);
  });
});

describe('reading a real installation fairly', () => {
  it('counts a topic as covered by any distinctive word, and never flags generic ones', () => {
    const sources = [{ name: 'PONS', location: null }, { name: 'AI17Z README', location: null }];
    expect(topicCovered('Pons launchpad', sources)).toBe(true);
    expect(topicCovered('open source', sources)).toBe(true);
    expect(topicCovered('bonding curves', sources)).toBe(false);
  });

  it('tells a failure from a reply waiting for review and from work stopped on purpose', () => {
    const at = new Date().toISOString();
    const { real, held, onPurpose } = sortFailures([
      { status: 'PERMANENT_FAILURE', lastError: '@grok is blocked for this agent.', lastAt: at },
      { status: 'PERMANENT_FAILURE', lastError: 'The source post no longer exists on X.', lastAt: at },
      { status: 'REVIEW_REQUIRED', lastError: 'Does not sound like this agent', lastAt: at },
      { status: 'PERMANENT_FAILURE', lastError: 'Google Chrome could not be found.', lastAt: at },
    ]);
    expect(real.map((f) => f.lastError)).toEqual(['Google Chrome could not be found.']);
    expect(held).toHaveLength(1);
    expect(onPurpose).toHaveLength(2);
  });
});
