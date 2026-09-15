import { describe, expect, it } from 'vitest';
import { CONSTRAINED_ENUMS } from '@xbam/database';
import { X_READ_OUTCOMES } from '@xbam/channels';

/**
 * The vocabularies that exist in two places, held against each other.
 *
 * `tests/integration/constrainedEnums.test.ts` already walks the registry
 * against the database in both directions, and that is the check that matters.
 * What it cannot see is a vocabulary whose *real* source lives somewhere the
 * database layer is not allowed to import from.
 *
 * `x_account_observations.outcome` is one. The list belongs to the X
 * intelligence layer, in `packages/channels`; the database package sits
 * underneath the channels and importing upwards would invert that. So the list
 * is written out twice, which is one implementation more than the rule allows,
 * and this is the test that makes the duplication safe rather than merely
 * regrettable -- the same argument the release-name grammar makes about being
 * implemented once in TypeScript and once in ISPP.
 *
 * The failure without it is the quiet kind: a new outcome is added to the
 * layer, every unit test passes, and the first read that produces it dies at
 * the database on a path nobody exercised.
 */

describe('vocabularies that exist in two places', () => {
  it('records X read outcomes exactly as the intelligence layer names them', () => {
    const registered = CONSTRAINED_ENUMS.find(
      (entry) => entry.table === 'x_account_observations' && entry.column === 'outcome',
    );
    expect(registered, 'the outcome column must be registered as a constrained enum').toBeDefined();
    expect([...registered!.values].sort()).toEqual([...X_READ_OUTCOMES].sort());
  });
});
