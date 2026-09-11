import { describe, expect, it } from 'vitest';
import { PARSES_EXACTLY, exactInteger, parseExactJson, withDecimals } from '@xbam/upstream';

/**
 * Numbers that must survive being read.
 *
 * Solana returns u64: lamports, token supplies, rent epochs. `JSON.parse` turns
 * every number into a double and a u64 does not fit in one, so the naive read
 * silently changes the value. Measured against mainnet, not imagined --
 * `rentEpoch` arrived as 18446744073709551615 and parsed to
 * 18446744073709552000.
 *
 * A rounded balance is an invented number, and it is the kind somebody acts on.
 */

describe('the runtime this actually runs on', () => {
  it('can parse JSON without rounding large whole numbers', () => {
    // Node 22 (CI and all three images) and Node 24 (development) both can. If
    // this ever fails, `parseExactJson` refuses rather than degrading -- but it
    // should fail loudly here first.
    expect(PARSES_EXACTLY).toBe(true);
  });
});

describe('reading a u64', () => {
  it('keeps a number too large for a double, exactly', () => {
    const text = '{"rentEpoch":18446744073709551615}';
    // What the naive read does, stated so the test says why it exists.
    expect(JSON.parse(text).rentEpoch).toBe(18446744073709552000);
    expect((parseExactJson(text, 'a test') as { rentEpoch: string }).rentEpoch).toBe('18446744073709551615');
  });

  it('leaves numbers that fit as numbers', () => {
    // A slot, a decimals field and an array length are all more useful as
    // numbers and are nowhere near the limit.
    const parsed = parseExactJson('{"slot":446036105,"decimals":6,"lamports":533858884382}', 'a test') as {
      slot: number;
      decimals: number;
      lamports: number;
    };
    expect(parsed.slot).toBe(446036105);
    expect(parsed.decimals).toBe(6);
    expect(parsed.lamports).toBe(533858884382);
  });

  it('does not mangle a string that happens to contain digits', () => {
    const parsed = parseExactJson('{"amount":"7937704767085421","note":"12345678901234567890"}', 'a test') as {
      amount: string;
      note: string;
    };
    expect(parsed.amount).toBe('7937704767085421');
    expect(parsed.note).toBe('12345678901234567890');
  });

  it('leaves fractions alone', () => {
    const parsed = parseExactJson('{"uiAmount":7937704767.085421}', 'a test') as { uiAmount: number };
    expect(parsed.uiAmount).toBe(7937704767.085421);
  });
});

describe('an amount becoming text', () => {
  it('accepts a whole number in either form and refuses anything else', () => {
    expect(exactInteger(533858884382)).toBe('533858884382');
    expect(exactInteger('18446744073709551615')).toBe('18446744073709551615');
    expect(exactInteger(1.5)).toBeNull();
    expect(exactInteger('not a number')).toBeNull();
    expect(exactInteger(null)).toBeNull();
    // A number that arrived as a double and is already past the safe range
    // cannot be trusted, so it is refused rather than reported.
    expect(exactInteger(18446744073709552000)).toBeNull();
  });
});

describe('rendering an amount with its decimals', () => {
  it('does it as text, because dividing is the thing being avoided', () => {
    expect(withDecimals('533858884382', 9)).toBe('533.858884382');
    expect(withDecimals('7937704767085421', 6)).toBe('7937704767.085421');
    // The cases that break a naive implementation.
    expect(withDecimals('1', 9)).toBe('0.000000001');
    expect(withDecimals('0', 9)).toBe('0');
    expect(withDecimals('1000000000', 9)).toBe('1');
    expect(withDecimals('1500000000', 9)).toBe('1.5');
    expect(withDecimals('123', 0)).toBe('123');
  });

  it('stays exact past where a double stops counting by ones', () => {
    const lamports = '18446744073709551615';
    expect(withDecimals(lamports, 9)).toBe('18446744073.709551615');

    // What the obvious implementation gives instead. Written through `Number`
    // rather than as a literal because `no-loss-of-precision` refuses to let
    // that literal into the file at all -- which is the argument for this
    // module, made by the linter.
    expect(String(Number(lamports) / 1e9)).not.toBe('18446744073.709551615');
  });

  it('refuses what it cannot render rather than guessing', () => {
    expect(() => withDecimals('1.5', 9)).toThrow();
    expect(() => withDecimals('abc', 9)).toThrow();
    expect(() => withDecimals('1', -1)).toThrow();
  });
});
