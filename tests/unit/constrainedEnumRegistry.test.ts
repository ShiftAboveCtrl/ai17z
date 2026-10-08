import { describe, expect, it } from 'vitest';
import { CONSTRAINED_ENUMS, columnOf } from '@xbam/database';
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

describe('which column a CHECK is about', () => {
  it('reads an ordinary one', () => {
    expect(columnOf(`CHECK ((status = ANY (ARRAY['A'::text, 'B'::text])))`)).toBe('status');
    expect(columnOf(`CHECK (("status" = ANY (ARRAY['A'::text])))`)).toBe('status');
  });

  it('reads a nullable one, which Postgres writes differently', () => {
    // The shape this did not understand. A nullable constrained column is
    // written `col IS NULL OR col IN (...)`, and the anchored match that used
    // to be here failed on it: the column came back as `?`, so the constraint
    // was reported as unregistered and as missing from the database at the
    // same time. Every future nullable vocabulary would have done the same,
    // silently, which is the drift the registry exists to catch.
    expect(
      columnOf(`CHECK (((last_outcome IS NULL) OR (last_outcome = ANY (ARRAY['FILLED'::text, 'ERROR'::text]))))`),
    ).toBe('last_outcome');
  });

  it('refuses to name one column when a CHECK constrains two', () => {
    // Not one vocabulary, so recording it as one would register half of it.
    // `?` makes the registry test say so out loud instead.
    expect(columnOf(`CHECK (((a = ANY (ARRAY['x'::text])) AND (b = ANY (ARRAY['y'::text]))))`)).toBe('?');
  });

  it('names nothing when there is nothing to name', () => {
    expect(columnOf(`CHECK ((length(btrim(label)) > 0))`)).toBe('?');
    expect(columnOf('')).toBe('?');
  });
});
