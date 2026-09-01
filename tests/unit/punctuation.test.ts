import { describe, expect, it } from 'vitest';
import { PolicyConfig } from '@xbam/shared/contracts';
import { removeEmDashes } from '@xbam/runtime';
import { describeDisclosure } from '@xbam/prompts';

/**
 * No em dashes, ever, from anybody.
 *
 * The single most reliable tell that a machine wrote something. Almost nobody
 * types one on a phone, and models reach for them constantly, so a timeline of
 * otherwise convincing replies gives itself away on punctuation alone.
 *
 * There is no policy field for this and no Easy Mode control, deliberately: an
 * option somebody can switch off is an option that will be on by accident.
 */
describe('taking the em dashes out', () => {
  it('turns a pair around a clause into commas', () => {
    const { text, replaced } = removeEmDashes('The fee — which nobody reads — is the point.');
    expect(text).toBe('The fee, which nobody reads, is the point.');
    expect(replaced).toBe(2);
  });

  it('turns a single break into a comma', () => {
    expect(removeEmDashes('It works, mostly — until it does not.').text).toBe(
      'It works, mostly, until it does not.',
    );
  });

  it('uses a colon where an explanation follows', () => {
    // "because" after a dash is doing a colon's job, and a comma there reads
    // like a run-on.
    expect(removeEmDashes('Nobody shipped it — because the fees made it pointless.').text).toBe(
      'Nobody shipped it: because the fees made it pointless.',
    );
  });

  it('leaves a numeric range alone', () => {
    // 1914–1918 is a dash doing arithmetic, not punctuation.
    expect(removeEmDashes('The 2020–2021 cycle was different.').text).toBe('The 2020–2021 cycle was different.');
  });

  it('does nothing to text that never had one', () => {
    const clean = 'Low fees are a moat only once volume makes them self-sustaining.';
    const { text, replaced } = removeEmDashes(clean);
    expect(text).toBe(clean);
    expect(replaced).toBe(0);
  });

  it('is idempotent', () => {
    // The validator can repair a message more than once, and a second pass must
    // not keep adding commas.
    const once = removeEmDashes('A — B — C, and then D — E.').text;
    expect(removeEmDashes(once).text).toBe(once);
  });

  it('does not leave doubled commas behind', () => {
    expect(removeEmDashes('Fees, — and this is the part people miss — are a subsidy.').text).not.toMatch(/,\s*,/);
  });

  it('handles en dashes and horizontal bars too', () => {
    // Models produce all three, and a rule that catches one of them catches
    // nothing.
    for (const dash of ['—', '–', '―']) {
      expect(removeEmDashes(`before ${dash} after`).text).not.toContain(dash);
    }
  });
});

describe('the rule reaches the prompt as well as the validator', () => {
  it('is in every disclosure block, however permissive the policy', () => {
    // Enforcement alone produces text that had to be repaired, because the
    // model chose its clause structure around a dash it could not have.
    const permissive = PolicyConfig.parse({ identity: { mayDenyBeingAI: true, disclosure: 'NONE' } }).identity;
    for (const policy of [PolicyConfig.parse({}).identity, permissive]) {
      expect(describeDisclosure(policy)).toMatch(/em dash/i);
    }
  });
});
