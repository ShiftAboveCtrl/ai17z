import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A pool with no trades and a payload nobody could read are different answers.
 *
 * The candle reader took `attributes.ohlcv_list ?? []`, so a source that
 * answered without that field produced an empty candle list and a successful
 * result. An agent handed that says the pool has no price history, about a pool
 * that may have plenty, and nothing downstream can tell it was a guess.
 *
 * This is the same discipline the X reading layer states for itself: absent is
 * never zero, and a parser that cannot see a number reports none rather than
 * nought. It had not been applied here.
 */
const source = readFileSync(resolve(__dirname, '../../packages/runtime/src/marketCapabilities.ts'), 'utf8');

describe('reading a pool price history', () => {
  it('refuses rather than reporting an empty history it did not measure', () => {
    // The shape that made the two indistinguishable.
    expect(source).not.toContain('?.attributes?.ohlcv_list ?? []');
    // A missing list is a change in the source, said as one.
    expect(source).toContain("'ohlcv_shape_changed'");
    expect(source).toContain('rather than a pool with no trades');
  });

  it('counts rows it could not read instead of dropping them quietly', () => {
    // A format change that halves the answer has to be visible in the answer,
    // not inferred from it being shorter than expected.
    expect(source).toContain('unreadableRows');
    expect(source).toContain('const unreadable = list.length - usable.length;');
  });

  it('still treats a genuinely empty list as a measurement', () => {
    /*
      The distinction only works in both directions. A pool that really has no
      candles answers with an empty array, and that is an answer: the refusal is
      for the list being absent, never for it being empty.
    */
    expect(source).toContain('if (!Array.isArray(list))');
    expect(source).not.toMatch(/if \(list\.length === 0\)\s*\{\s*throw/);
  });
});
