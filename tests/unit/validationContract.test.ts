import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONA_LIMITS, PersonaDraft } from '@xbam/shared/contracts';

const root = resolve(__dirname, '../..');

/**
 * One set of numbers, used by the schema that rejects a save and by the
 * interface that counts towards it.
 *
 * Two copies drift, and a counter that disagrees with the rule is worse than no
 * counter: it is confidently wrong, and the person trusts it right up to the
 * moment the save fails.
 */
describe('the validation contract has one source', () => {
  it('the schema enforces exactly the published limits', () => {
    for (const [field, limit] of [
      ['personality', PERSONA_LIMITS.personality],
      ['tone', PERSONA_LIMITS.tone],
      ['biography', PERSONA_LIMITS.biography],
      ['styleGuidelines', PERSONA_LIMITS.styleGuidelines],
      ['customInstructions', PERSONA_LIMITS.customInstructions],
    ] as const) {
      const atLimit = PersonaDraft.safeParse({ displayName: 'x', [field]: 'a'.repeat(limit) });
      expect(atLimit.success, `${field} refused a value exactly at its limit`).toBe(true);

      const overLimit = PersonaDraft.safeParse({ displayName: 'x', [field]: 'a'.repeat(limit + 1) });
      expect(overLimit.success, `${field} accepted one character over its limit`).toBe(false);
    }
  });

  it('the interface reads the limits rather than repeating them', () => {
    const ui = readFileSync(resolve(root, 'apps/web/src/routes/sections/IdentitySection.tsx'), 'utf8');
    expect(ui).toContain('PERSONA_LIMITS');
    // A hardcoded limit next to a counter is the drift this prevents.
    expect(ui).not.toMatch(/limit=\{\d{3,}\}/);
  });

  it('every limit is a number somebody could plausibly reach', () => {
    for (const [field, limit] of Object.entries(PERSONA_LIMITS)) {
      expect(limit, field).toBeGreaterThan(0);
      expect(Number.isInteger(limit), field).toBe(true);
    }
  });
});
