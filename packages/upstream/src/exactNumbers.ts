import { UpstreamFailure } from './failures';

/**
 * Parsing JSON without quietly destroying large integers.
 *
 * `JSON.parse` turns every number into a double, and a u64 does not fit in one.
 * Solana returns lamports, token supplies and rent epochs as u64, so this is not
 * a hypothetical: probing mainnet, `rentEpoch` came back as
 * `18446744073709551615` on the wire and `18446744073709552000` after parsing.
 * The total supply of SOL in lamports is about 6e17, comfortably past the
 * 9.007e15 where doubles stop counting by ones, and a large token supply passes
 * it easily.
 *
 * A rounded balance is not a rounded balance. It is **an invented number**, and
 * one that would be quoted to somebody about to act on it.
 *
 * ### How
 *
 * The reviver's third argument carries the original source text for each
 * primitive -- exactly what this problem needs, and standard since Node 21. Any
 * integer that does not survive the round trip is replaced by its source text,
 * so it arrives as an exact decimal string instead of a wrong number. Integers
 * that do fit are left as numbers, because a slot, a decimals field and an array
 * length are more useful as numbers and are never near the limit.
 *
 * ### When the runtime cannot do it
 *
 * It says so and refuses, rather than falling back to the lossy parse. A silent
 * fallback here would reintroduce exactly the bug this exists to prevent, on
 * whichever runtime happened to lack the feature. Checked against Node 22 --
 * what CI and all three images run -- and Node 24.
 */

/**
 * The reviver signature with the third argument.
 *
 * Declared here rather than cast away, because the point of this file is that
 * the source text is present -- a cast to `never` would type-check just as well
 * on a runtime where it is not.
 */
type ExactReviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

const parseWith = JSON.parse as (text: string, reviver: ExactReviver) => unknown;

/** Whether this runtime hands the reviver the original source text. */
export const PARSES_EXACTLY: boolean = (() => {
  try {
    let seen = false;
    parseWith('{"n":1}', (_key, value, context) => {
      if (context && typeof context.source === 'string') seen = true;
      return value;
    });
    return seen;
  } catch {
    return false;
  }
})();

/**
 * Parses JSON, keeping integers too large for a double as exact strings.
 *
 * Throws rather than degrading: a caller asking for this wants exactness, and
 * the lossy answer is the one it is trying to avoid.
 */
export function parseExactJson(text: string, what: string): unknown {
  if (!PARSES_EXACTLY) {
    throw new UpstreamFailure(
      'BAD_CONFIGURATION',
      `This runtime (${process.version}) cannot parse JSON without rounding large whole numbers, ` +
        `so ${what} cannot be read accurately. Nothing was returned rather than a number that might be wrong.`,
    );
  }
  return parseWith(text, (_key, value, context) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return value;
    const source = context?.source;
    // Kept as a number when it round-trips, which every slot, epoch and decimals
    // field does. Replaced by its exact text when it does not.
    if (typeof source === 'string' && source !== String(value)) return source;
    return value;
  });
}

/**
 * A whole number as an exact decimal string, or null if it is not one.
 *
 * The single place a lamport count or a token amount becomes text, so the rule
 * that they never travel as doubles has one implementation to check.
 */
export function exactInteger(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  return null;
}

/**
 * An integer amount rendered with its decimal places, exactly.
 *
 * Done as text rather than by dividing, because dividing is the thing this file
 * exists to avoid: 533858884382 lamports is 533.858884382 SOL, and the obvious
 * `n / 1e9` is only right until it is not.
 */
export function withDecimals(amount: string, decimals: number): string {
  if (!/^-?\d+$/.test(amount)) throw new Error(`"${amount}" is not a whole number.`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`${decimals} is not a usable number of decimal places.`);
  }
  const negative = amount.startsWith('-');
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A hex quantity as an exact decimal string.
 *
 * EVM JSON-RPC returns every quantity as hex, and a `uint256` balance is far
 * past what a double can hold -- so it goes through BigInt and comes out as
 * text, never as a number. Shared here rather than written per family: the
 * chain capabilities had their own copy, and a second chain adapter would have
 * written a third.
 *
 * `0x` on its own is what some nodes answer for zero.
 */
export function hexToExactInteger(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
  return BigInt(value === '0x' ? '0x0' : value).toString(10);
}

/**
 * The sum of exact integers, as an exact integer.
 *
 * Adding through `Number` is the obvious way and the wrong one: a total of
 * satoshis or lamports can pass the safe range even when no single amount does.
 */
export function sumExact(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}
