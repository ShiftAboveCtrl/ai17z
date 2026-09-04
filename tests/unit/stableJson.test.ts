import { describe, expect, it } from 'vitest';
import { sameContent, stableJson } from '@xbam/shared';

/**
 * The actual defect this exists for: a policy written as
 * `{ use, allowed, maxPerMessage, messagesPercent }` came back out of jsonb as
 * `{ use, maxPerMessage, allowed, messagesPercent }`. Nothing had changed, but
 * a string comparison said it had, so opening Easy Mode and pressing save cut
 * a new policy version every time and the history stopped meaning anything.
 */
describe('comparing configuration by content', () => {
  it('ignores the order the keys were written in', () => {
    const written = { use: 'MINIMAL', allowed: [], maxPerMessage: 1, messagesPercent: 25 };
    const readBack = { use: 'MINIMAL', maxPerMessage: 1, allowed: [], messagesPercent: 25 };
    expect(JSON.stringify(written)).not.toBe(JSON.stringify(readBack));
    expect(sameContent(written, readBack)).toBe(true);
  });

  it('still sees a real difference', () => {
    expect(sameContent({ a: 1, b: 2 }, { b: 2, a: 3 })).toBe(false);
    expect(sameContent({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameContent({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('keeps array order, because in a list order is content', () => {
    expect(sameContent(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameContent([{ x: 1, y: 2 }], [{ y: 2, x: 1 }])).toBe(true);
  });

  it('sorts nested objects too', () => {
    expect(sameContent({ o: { z: 1, a: { q: 1, b: 2 } } }, { o: { a: { b: 2, q: 1 }, z: 1 } })).toBe(true);
  });

  it('treats an unset field as absent, exactly as JSON does', () => {
    expect(sameContent({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameContent({ a: 1, b: null }, { a: 1 })).toBe(false);
  });

  it('handles the values JSON.stringify returns nothing for', () => {
    expect(stableJson(undefined)).toBe('null');
    expect(stableJson(null)).toBe('null');
    expect(stableJson(3)).toBe('3');
    expect(stableJson('s')).toBe('"s"');
  });
});
