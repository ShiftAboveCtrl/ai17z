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

describe('a hex quantity', () => {
  it('survives a uint256, which is the whole point of not using a number', async () => {
    const { hexToExactInteger } = await import('@xbam/upstream');
    // 2^256 - 1. A double cannot hold a millionth of this.
    const max = '0x' + 'f'.repeat(64);
    expect(hexToExactInteger(max)).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    );
    // One ether in wei, already past the safe range.
    expect(hexToExactInteger('0xde0b6b3a7640000')).toBe('1000000000000000000');
  });

  it('reads the empty quantity some nodes answer for zero', async () => {
    const { hexToExactInteger } = await import('@xbam/upstream');
    expect(hexToExactInteger('0x')).toBe('0');
    expect(hexToExactInteger('0x0')).toBe('0');
  });

  it('refuses anything that is not one, rather than guessing', async () => {
    const { hexToExactInteger } = await import('@xbam/upstream');
    expect(hexToExactInteger('123')).toBeNull();
    expect(hexToExactInteger('0xnothex')).toBeNull();
    expect(hexToExactInteger(null)).toBeNull();
    expect(hexToExactInteger(42)).toBeNull();
  });
});

describe('summing exact integers', () => {
  it('stays exact where adding through a number would not', async () => {
    const { sumExact } = await import('@xbam/upstream');
    // Three amounts, each individually safe, whose total is not.
    const parts = ['9007199254740991', '9007199254740991', '9007199254740991'];
    expect(sumExact(parts)).toBe('27021597764222973');
    // What the obvious implementation gives instead.
    expect(String(parts.reduce((total, part) => total + Number(part), 0))).not.toBe('27021597764222973');
  });

  it('sums nothing to nought', async () => {
    const { sumExact } = await import('@xbam/upstream');
    expect(sumExact([])).toBe('0');
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
