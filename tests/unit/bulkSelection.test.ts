import { describe, expect, it } from 'vitest';
import { boundedSelection } from '../../apps/web/src/lib/selection';

const ids = Array.from({ length: 180 }, (_, index) => `job-${String(index + 1).padStart(3, '0')}`);

describe('bounded owner selection', () => {
  it.each([10, 25, 50])('selects the first %i in deterministic current order', (amount) => {
    expect(boundedSelection(ids, amount)).toEqual(ids.slice(0, amount));
  });

  it('accepts a safe custom amount', () => {
    expect(boundedSelection(ids, 37)).toEqual(ids.slice(0, 37));
  });

  it('bounds select-all commands and never invents ids', () => {
    const many = Array.from({ length: 700 }, (_, index) => `job-${index}`);
    expect(boundedSelection(many, many.length)).toEqual(many.slice(0, 500));
    expect(boundedSelection(ids, 999)).toEqual(ids);
  });
});
