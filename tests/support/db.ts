import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadEnv } from '@xbam/shared';
import { closePool, migrate, query, withTransaction } from '@xbam/database';

/**
 * Integration tests run against a real Postgres database, never a mock.
 *
 * The schema is the contract for most of this system (unique indexes carry the
 * idempotency guarantees), so testing it against anything else would test the
 * wrong thing.
 *
 * Each test process gets its own database rather than sharing one.
 *
 * Sharing cost an afternoon. `beforeEach` empties every table, which needs an
 * AccessExclusiveLock on all of them at once, so anything else touching that
 * database at the same moment either deadlocks or has its rows pulled out from
 * under it. And something else usually is: vitest keeps its fork alive for a
 * moment after reporting, so two consecutive runs overlap. The failures land in
 * whichever test happens to be running -- a foreign key here, a deadlock there,
 * a different one each time -- and read exactly like a concurrency bug in the
 * code under test.
 *
 * A database per process is the cheap version of the fix: the migration runs
 * once per process, not once per file, and no two runs can see each other.
 */

let owned: string | null = null;

function baseUrl(): string {
  loadEnv();
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL must be set to run integration tests.');
  return base;
}

/** A connection to the server rather than to a particular database, for CREATE/DROP. */
async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: baseUrl() });
  await client.connect();
  return client;
}

/**
 * Removes databases left behind by runs that were killed.
 *
 * A dropped connection cannot drop its own database, so an interrupted run
 * leaks one. Left alone they accumulate for as long as somebody keeps
 * interrupting test runs, which is to say indefinitely. Anything older than an
 * hour cannot belong to a run still going.
 */
async function dropAbandoned(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ datname: string }>(
    `SELECT datname FROM pg_database
      WHERE datname LIKE 'xbam_test_%'
        AND (pg_stat_file('base/' || oid || '/PG_VERSION', true)).modification < now() - interval '1 hour'`,
  );
  for (const row of rows) {
    await client.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`).catch(() => undefined);
  }
}

export async function setupTestDatabase(): Promise<void> {
  if (owned) return;

  const base = baseUrl();
  const name = `xbam_test_${process.pid}_${randomBytes(3).toString('hex')}`;

  const admin = await adminClient();
  try {
    await dropAbandoned(admin).catch(() => undefined);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end().catch(() => undefined);
  }
  owned = name;

  process.env.DATABASE_URL = base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  if (!process.env.XBAM_MASTER_KEY) {
    process.env.XBAM_MASTER_KEY = randomBytes(32).toString('base64');
  }
  await migrate();
}

/**
 * Empties every domain table, leaving the schema and catalogue seeds intact.
 *
 * Retried, and under a lock timeout, because the pipeline starts writes that
 * finish after the call which started them -- recording an exchange, harvesting
 * an idea, writing a trace. A test can await everything it asked for and still
 * have one land a moment later.
 *
 * Both statements have to be on one connection: `SET` is per session and every
 * pooled query can be a different session, so setting the timeout on one
 * connection and truncating on another does nothing at all.
 */
export async function truncateAll(): Promise<void> {
  const rows = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations')`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await withTransaction(async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '4s'`);
        await tx.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function teardownTestDatabase(): Promise<void> {
  await closePool();
  if (!owned) return;
  const name = owned;
  owned = null;

  // Best effort. A database left behind is tidied by the next run rather than
  // failing this one, which has already reported its results.
  const admin = await adminClient().catch(() => null);
  if (!admin) return;
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } catch {
    // Ignored on purpose: see above.
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export const uniqueSuffix = (): string => randomBytes(4).toString('hex');
