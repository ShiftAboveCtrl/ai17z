import { describe, expect, it } from 'vitest';
import { CONSTRAINED_ENUMS, discoverConstrainedEnums, query } from '@xbam/database';
import { installHarness } from '../support/harness';

installHarness();

/**
 * The enum and its CHECK constraint have to agree, in both directions.
 *
 * This is the failure the project has already paid for: migration 0020 added
 * seven account states and taught the code to write them while the constraint
 * still listed the old five. Every sign-in died at the database, and no test
 * noticed -- the unit tests never touched Postgres and the integration tests
 * only wrote values that already existed.
 *
 * `statusConstraints.test.ts` guards that by writing real rows, which is the
 * stronger check and the reason it exists. But it covered six vocabularies out
 * of forty-six, and each one was hand-written, so the guard only ever grew when
 * somebody remembered to grow it.
 *
 * This walks a registry instead, and fails in both directions:
 *
 *   a value in the registry the column would reject  -> enum grew, migration did not
 *   a constrained column missing from the registry   -> new vocabulary, no coverage
 *
 * Neither can be satisfied by remembering.
 */
describe('every constrained vocabulary agrees with its column', () => {
  it('accepts exactly the values the registry declares', async () => {
    const discovered = await discoverConstrainedEnums((sql) => query(sql));
    const byColumn = new Map(discovered.map((d) => [`${d.table}.${d.column}`, d]));

    const disagreements: string[] = [];
    for (const entry of CONSTRAINED_ENUMS) {
      const key = `${entry.table}.${entry.column}`;
      const actual = byColumn.get(key);
      if (!actual) {
        disagreements.push(`${key}: registered, but the database has no such CHECK`);
        continue;
      }
      const missingFromDb = entry.values.filter((v) => !actual.values.includes(v));
      const missingFromRegistry = actual.values.filter((v) => !entry.values.includes(v as never));
      if (missingFromDb.length > 0) {
        // The expensive direction: the code can produce these and the column
        // will refuse them, at runtime, on whichever path writes one first.
        disagreements.push(`${key}: the column would reject ${missingFromDb.join(', ')} -- a migration is missing`);
      }
      if (missingFromRegistry.length > 0) {
        disagreements.push(`${key}: the column allows ${missingFromRegistry.join(', ')}, which nothing declares`);
      }
    }

    expect(disagreements, disagreements.join('\n')).toEqual([]);
  });

  it('has an entry for every enum-like CHECK in the database', async () => {
    const discovered = await discoverConstrainedEnums((sql) => query(sql));
    const registered = new Set(CONSTRAINED_ENUMS.map((e) => `${e.table}.${e.column}`));

    const unregistered = discovered
      .map((d) => `${d.table}.${d.column}`)
      .filter((key) => !registered.has(key));

    // A constrained column nobody registered is a vocabulary that can drift
    // without anything noticing, which is the whole problem.
    expect(unregistered, `unregistered constrained columns: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('covers substantially more than the six vocabularies that were hand-written', async () => {
    const discovered = await discoverConstrainedEnums((sql) => query(sql));
    // Not a target to game: it fails if coverage silently shrinks, which is the
    // shape of somebody deleting registry entries to make the suite pass.
    expect(CONSTRAINED_ENUMS.length).toBe(discovered.length);
    expect(CONSTRAINED_ENUMS.length).toBeGreaterThanOrEqual(40);
  });

  it('declares no duplicate or empty vocabularies', () => {
    const keys = CONSTRAINED_ENUMS.map((e) => `${e.table}.${e.column}`);
    expect(new Set(keys).size, 'a column is registered twice').toBe(keys.length);
    for (const entry of CONSTRAINED_ENUMS) {
      expect(entry.values.length, `${entry.table}.${entry.column} has no values`).toBeGreaterThan(0);
      expect(new Set(entry.values).size, `${entry.table}.${entry.column} repeats a value`).toBe(entry.values.length);
    }
  });
});
