import { describe, expect, it } from 'vitest';
import { knowledge as knowledgeRepo, learning as learningRepo, query } from '@xbam/database';
import { agentSetupCheck, describeLearning, settingHref } from '@xbam/runtime';
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
