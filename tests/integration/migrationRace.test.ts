import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '@xbam/database';
import { installHarness } from '../support/harness';

installHarness();

const run = promisify(execFile);
const root = resolve(__dirname, '../..');
const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const migrateCli = resolve(root, 'packages/database/src/cli/migrate.ts');

/**
 * Two migrators, one new database.
 *
 * An installed AI17Z starts both within a second of each other: the API
 * container migrates on boot because `XBAM_RUN_MIGRATIONS` is set, and the
 * launcher migrates because a native worker needs the schema too. On a database
 * that already has the schema they both no-op, which is why this went unnoticed
 * for as long as it did. On a new one they raced through the same list and
 * collided inside Postgres's own catalogue:
 *
 *   Migration 0031_stances.sql failed: duplicate key value violates unique
 *   constraint "pg_type_typname_nsp_index"
 *
 * That is two `CREATE TYPE`s for one name arriving together. It made the very
 * first thing a new installation did a failure -- and running it again worked,
 * because by then the schema existed, which is the shape of bug that survives
 * every test written after the fact.
 *
 * Two real processes rather than two calls, because the pool is a singleton and
 * two `migrate()` calls in one process would serialise on it for the wrong
 * reason and prove nothing.
 */
const created: string[] = [];

function urlFor(database: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url.replace(/\/[^/?]+(\?|$)/, `/${database}$1`);
}

async function freshDatabase(): Promise<string> {
  const name = `xbam_race_${process.pid}_${randomBytes(3).toString('hex')}`;
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
  } finally {
    await admin.end().catch(() => undefined);
  }
  return name;
}

/** One migrator, in its own process, against one database. */
function migrator(database: string) {
  return run(process.execPath, [tsx, migrateCli], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: urlFor(database) },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function appliedCount(database: string): Promise<number> {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    const { rows } = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations');
    return Number(rows[0]!.count);
  } finally {
    await client.end().catch(() => undefined);
  }
}

afterAll(async () => {
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect().catch(() => undefined);
  for (const name of created) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  }
  await admin.end().catch(() => undefined);
});

describe('two migrators starting on one new database', () => {
  it('both succeed', async () => {
    const database = await freshDatabase();

    const results = await Promise.allSettled([migrator(database), migrator(database)]);
    const failed = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String((r.reason as { stderr?: string; message?: string }).stderr || r.reason?.message));

    expect(failed, 'a migrator failed, which is the bug this exists for').toEqual([]);
  }, 180_000);

  it('applies every migration exactly once between them', async () => {
    const database = await freshDatabase();
    await Promise.all([migrator(database), migrator(database)]);

    expect(await appliedCount(database)).toBe(loadMigrations().length);

    const client = new Client({ connectionString: urlFor(database) });
    await client.connect();
    try {
      // The primary key already forbids duplicates. Asserted anyway, because
      // the failure being guarded against happens in Postgres's catalogue,
      // where a constraint on this table would never have seen it.
      const dupes = await client.query('SELECT name FROM schema_migrations GROUP BY name HAVING count(*) > 1');
      expect(dupes.rows).toEqual([]);
    } finally {
      await client.end().catch(() => undefined);
    }
  }, 180_000);

  it('waits rather than failing, and says so', async () => {
    const database = await freshDatabase();
    const [first, second] = await Promise.all([migrator(database), migrator(database)]);

    // Whichever lost the lock waited for the winner and then found the work
    // done. Both outputs name the database, and neither reports a failure.
    const output = `${first.stdout}${first.stderr}${second.stdout}${second.stderr}`;
    expect(output).toContain(database);
    expect(output).not.toContain('failed');
  }, 180_000);
});
