import { describe, expect, it } from 'vitest';
import { BaseUnits } from '@xbam/shared/contracts';

/**
 * The one rule about money, and the way it stopped being a rule.
 *
 * Every amount in AI17Z goes through `BaseUnits`: a wallet transfer, every
 * ceiling in a trading mandate, a trade intent's size, the shared utility
 * surface's `maxIn`. So a way of breaking it breaks all of them at once, which
 * is what happened.
 *
 * zod runs every check on a string and collects the issues rather than
 * stopping at the first failure, so the `BigInt` comparison ran on input the
 * regex had already rejected. `BigInt('1.5')` throws a SyntaxError, and a
 * throw out of a validator is not a validation failure: `safeParse` threw
 * rather than returning one, and the API answered 500. Somebody typing a
 * decimal point into a limit was told "Internal Server Error" instead of what
 * an amount is.
 *
 * These are a contract test rather than a regression test for one field,
 * because the next amount somebody adds inherits whichever behaviour this has.
 */
describe('an amount is a whole number of the smallest unit', () => {
  it('accepts digits, and nothing else', () => {
    for (const good of ['1', '12', '1000000000000000000', '9'.repeat(78)]) {
      expect(BaseUnits.safeParse(good).success, good).toBe(true);
    }
  });

  it('refuses rather than throwing, for every shape that is not digits', () => {
    // The list is the point. Each of these used to reach `BigInt`, and the
    // first two threw straight out of validation.
    for (const bad of ['1.5', 'abc', '1e18', ' 12', '12 ', '+1', '-1', '', '0', '0x10', '1_000', '9'.repeat(79)]) {
      // `safeParse` must not throw. Written as its own expectation because a
      // throw here would otherwise fail the test with the thrown error and
      // read as a broken test rather than as the defect it is.
      expect(() => BaseUnits.safeParse(bad), bad).not.toThrow();
      expect(BaseUnits.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('says what an amount is, rather than what a regular expression wanted', () => {
    const failure = BaseUnits.safeParse('1.5');
    expect(failure.success).toBe(false);
    if (failure.success) return;
    // A person reads this. "An amount is a whole number of the smallest unit"
    // is actionable; a pattern is not.
    expect(failure.error.issues[0]!.message).toMatch(/whole number of the smallest unit/);
  });

  it('refuses zero, because an amount of nothing is not an amount', () => {
    expect(BaseUnits.safeParse('0').success).toBe(false);
    expect(BaseUnits.safeParse('000').success).toBe(false);
  });
});
