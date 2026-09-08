import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const EASY = 'apps/web/src/routes/EasySetup.tsx';
const ADVANCED = 'apps/web/src/routes/CreateAgent.tsx';
const INTELLIGENCE = 'apps/web/src/routes/sections/IntelligenceSection.tsx';

/**
 * Easy and Advanced are two sets of questions over one configuration system.
 *
 * They ask different things and lay themselves out differently, and that is the
 * point -- Advanced can express settings Easy has no word for. What they must
 * not have is two implementations of the same write, because that is how the
 * copies drift: Advanced created an agent and went straight to its page while
 * Easy checked whether it could actually run, so leaving the model blank in
 * Advanced was first reported by a failed job.
 *
 * These pin the shared half. They are source assertions rather than behaviour,
 * on purpose: the behaviour is covered end to end in `tests/e2e/setup.spec.ts`,
 * and what a unit test can add is a reason the next person does not quietly
 * write the second copy.
 */
describe('one setup engine behind two wizards', () => {
  it('writes through the shared layer rather than posting for itself', () => {
    for (const file of [EASY, ADVANCED]) {
      const source = read(file);
      expect(source, file).toContain("from '@app/lib/setup'");
      // Creating the agent, attaching a model and connecting an account were
      // each written twice. The endpoints are what the copies had in common.
      expect(source, file).not.toContain("post<{ id: string }>('/api/agents'");
      expect(source, file).not.toMatch(/put\(`\/api\/agents\/\$\{[^}]+\}\/models`/);
      expect(source, file).not.toContain("post<{ id: string }>('/api/accounts'");
    }
  });

  it('keeps the trigger defaults in the contract, not in a wizard', () => {
    // Defaulting a link to `["MENTION"]` alone once meant two of the four radar
    // monitors had every REPLY they found dropped at ingest. The default lives
    // in contracts/enums.ts and nowhere else, and a wizard writing its own list
    // is exactly how a second one appears.
    for (const file of [EASY, ADVANCED]) {
      expect(read(file), file).not.toContain('DEFAULT_TRIGGER_EVENT_TYPES');
    }
    expect(read('apps/web/src/lib/setup.ts')).toContain('DEFAULT_TRIGGER_EVENT_TYPES');
  });

  it('asks the same readiness question from both wizards', () => {
    // Easy always did. Advanced never did, which is the asymmetry this closes:
    // both now say what is missing before sending somebody to the agent page.
    expect(read(EASY)).toContain('startAgent(');
    expect(read(ADVANCED)).toContain('preflightAgent(');
    for (const file of [EASY, ADVANCED]) {
      expect(read(file), file).toContain('<Blockers');
    }
  });

  it('chooses a model the same way everywhere', () => {
    // Three fields for one decision: a considered select on the agent page and
    // a datalist in each wizard -- so the screen where somebody picks a model
    // for the first time behaved worst. A datalist shows nothing until you
    // click a control most people never find and never says whether what you
    // typed is real.
    for (const file of [EASY, ADVANCED, INTELLIGENCE]) {
      const source = read(file);
      expect(source, file).toContain('<ModelChooser');
      expect(source, file).not.toContain('<datalist');
      expect(source, file).not.toMatch(/list="[a-z-]*model/i);
    }
  });

  it('keeps a stored model that the provider never listed', () => {
    // The select used to render empty for a model named before the list was
    // fetched or released after it was, and saving from there replaced a
    // working model with nothing.
    const chooser = read('apps/web/src/components/ModelChooser.tsx');
    expect(chooser).toContain('value && !models.includes(value)');
  });
});
