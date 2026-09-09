import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, EasySetup } from '@xbam/shared/contracts';
import { toPolicy } from '@xbam/runtime';

const root = resolve(__dirname, '../..');
const advanced = readFileSync(resolve(root, 'apps/web/src/routes/CreateAgent.tsx'), 'utf8');

/**
 * What Easy Mode makes when nobody changes any of its eleven answers.
 *
 * The answers themselves are the wizard's starting draft. Only the fields
 * these tests are about are written out; everything else comes from the
 * schema, which is where an unanswered question is supposed to be decided.
 */
const easyPolicy = toPolicy(
  EasySetup.parse({
    character: { name: 'Default', preset: 'CONCISE' },
    operation: 'REVIEW_FIRST',
  }),
  DEFAULT_POLICY,
);

/** The Advanced wizard's starting draft, read out of its own INITIAL. */
function advancedDefault(field: string): string {
  const initial = advanced.slice(advanced.indexOf('const INITIAL: Draft = {'), advanced.indexOf('const IDENTITY_HELP'));
  const match = initial.match(new RegExp(`\\n  ${field}: ([^,\\n]+),`));
  expect(match, `${field} is not in INITIAL`).toBeTruthy();
  return (match![1] ?? '').replace(/'/g, '').trim();
}

/**
 * The two wizards must not disagree about what an unanswered question means.
 *
 * They found a way to. Both started an agent on REVIEW_BEFORE_ACTION, and
 * Advanced also defaulted dry run on -- so the mode whose own description says
 * it "waits for you to approve or edit before anything is sent" approved
 * things and sent nothing. Two safety nets, the second quietly defeating the
 * first, and only on one of the two ways in.
 */
describe('what the two wizards start an agent as', () => {
  it('agrees about how much an agent may do on its own', () => {
    expect(easyPolicy.automation.mode).toBe('REVIEW_BEFORE_ACTION');
    expect(advancedDefault('automation')).toBe('REVIEW_BEFORE_ACTION');
  });

  it('agrees that review means a real action, approved', () => {
    /*
      Easy has always had this off, with the reason written beside it: review
      means a person approves a real action, not that the action is pretended.
      Dry run is a separate, deliberate thing, and its toggle is on the same
      Advanced screen for anybody who wants both.
    */
    expect(easyPolicy.automation.dryRunDefault).toBe(false);
    expect(advancedDefault('dryRunDefault')).toBe('false');
  });

  it('says on screen that the two interact', () => {
    // The half that makes leaving it available safe: somebody switching dry
    // run on while in review mode should know what they have just done.
    const toggle = advanced.slice(advanced.indexOf('label="Dry run by default"'));
    expect(toggle.slice(0, 400)).toMatch(/Approving a held reply will not send it/i);
  });

  it('starts an agent that has not been let loose', () => {
    // Whatever else changes, neither may default to AUTONOMOUS. A first agent
    // that replies to strangers before anybody has read a draft is the one
    // outcome no default is allowed to produce.
    expect(easyPolicy.automation.mode).not.toBe('AUTONOMOUS');
    expect(advancedDefault('automation')).not.toBe('AUTONOMOUS');
  });
});
