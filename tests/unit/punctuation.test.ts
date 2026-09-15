import { describe, expect, it } from 'vitest';
import { PolicyConfig } from '@xbam/shared/contracts';
import { NO_EM_DASHES, removeEmDashes } from '@xbam/runtime';
import { NO_EM_DASHES_RULE, describeDisclosure } from '@xbam/prompts';

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

/*
  The same rhetorical pause, typed on a keyboard that has no em dash.

  A model told not to use an em dash reaches for a double hyphen or a spaced
  hyphen instead, and the result reads exactly as machine-written. Both are the
  same offence.

  The other half of this, and the half that is easy to get wrong, is everything
  a hyphen legitimately does. Stripping hyphens generally would break version
  tags, compound adjectives, command-line flags and URLs, which is worse than
  the problem it solves.
*/
describe('the ASCII forms of the same pause', () => {
  it('replaces a double hyphen used as a dash', () => {
    const got = removeEmDashes("That's clever -- but I don't think it solves the hard part.");
    expect(got.text).toBe("That's clever, but I don't think it solves the hard part.");
    expect(got.replaced).toBe(1);
  });

  it('replaces a hyphen with spaces around it', () => {
    const got = removeEmDashes("That's clever - but I don't think it solves the hard part.");
    expect(got.text).toBe("That's clever, but I don't think it solves the hard part.");
    expect(got.replaced).toBe(1);
  });

  it('treats a pair of double hyphens as a parenthetical', () => {
    const got = removeEmDashes('The fee -- which nobody reads -- is the interesting part.');
    expect(got.text).toBe('The fee, which nobody reads, is the interesting part.');
  });

  it('says what it did', () => {
    expect(removeEmDashes('a -- b').reason).toMatch(/rhetorical dash/);
  });

  it('is idempotent, like the rest of the repair', () => {
    const once = removeEmDashes('It works, mostly -- until it does not.');
    const twice = removeEmDashes(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.replaced).toBe(0);
  });
});

describe('what a hyphen is still allowed to do', () => {
  it.each([
    'The next one is v1.0.0-beta.24 and it ships tonight.',
    'It is read-only, and structurally so.',
    'That is an owner-configured token, not one of ours.',
    'Try the command-line flag instead.',
    'See https://github.com/ShiftAboveCtrl/ai17z/releases/tag/v1.0.0-beta.23 for the notes.',
    'The x-ray of that heap is not pretty.',
    'Use --dry-run first.',
    'A well-known failure mode, sadly.',
    'e-mail me about it',
  ])('leaves this alone: %s', (sentence) => {
    const got = removeEmDashes(sentence);
    expect(got.text).toBe(sentence);
    expect(got.replaced).toBe(0);
  });

  it('leaves the npm argument separator alone', () => {
    // `npm run verify:install -- --twice` has whitespace on both sides of the
    // double hyphen and is a command somebody pasted, not a sentence.
    const command = 'Run npm run verify:install -- --twice and see.';
    expect(removeEmDashes(command).text).toBe(command);
  });

  it('leaves a numeric range alone', () => {
    const range = 'It ran 3-4pm and again 1914-1918.';
    expect(removeEmDashes(range).text).toBe(range);
  });

  it('does not touch a hyphen at the start of a line', () => {
    // A bullet is not a rhetorical pause, whatever else it is.
    const list = 'Two things:\n- the first\n- the second';
    expect(removeEmDashes(list).text).toBe(list);
  });
});

describe('a reply that uses every form at once', () => {
  it('comes out reading like a person typed it', () => {
    const got = removeEmDashes(
      "Nice — that's the read-only path -- which is the bit I'd keep - and v1.0.0-beta.24 ships it.",
    );
    // Every rhetorical dash gone.
    expect(got.text).not.toMatch(/[—–―]/);
    expect(got.text).not.toMatch(/\s--\s/);
    expect(got.text).not.toMatch(/\w\s-\s\w/);
    // Every structural hyphen still there.
    expect(got.text).toContain('read-only');
    expect(got.text).toContain('v1.0.0-beta.24');
  });
});

describe('the rule is said in every place text is written', () => {
  it('tells the prompt about the forms a keyboard can type', () => {
    // A model told only about em dashes reaches for `--` instead, which reads
    // exactly as machine-written and is the same offence.
    for (const said of [NO_EM_DASHES_RULE, NO_EM_DASHES]) {
      expect(said).toMatch(/double hyphen/);
      expect(said).toMatch(/spaces around it/);
      // And says what is still allowed, so a model does not start avoiding
      // hyphens in version numbers and compound words.
      expect(said).toMatch(/read-only/);
    }
  });
});
