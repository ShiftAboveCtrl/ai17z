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
 * Removes test databases nobody is connected to.
 *
 * A process cannot drop the database it is using, and one that is killed never
 * gets the chance, so runs leak them. Having no connections is the honest test
 * for "finished": a run still going always holds at least one.
 *
 * Done at the start rather than the end for the same reason -- the run that
 * made the mess is exactly the one that cannot clean it up.
 *
 * The subtlety is the window. A database that has just been created and not yet
 * connected to *also* has no connections, so a second run sweeping at that
 * moment deletes a database the first run is about to migrate into. The error
 * lands later and elsewhere -- `database "xbam_test_150_e0d460" does not exist`
 * from four unrelated suites -- and names nothing that would lead anybody here.
 * The advisory lock below closes that window, so this only ever sees databases
 * whose owner has finished with them.
 */
async function dropFinished(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ datname: string }>(
    `SELECT d.datname FROM pg_database d
      WHERE d.datname LIKE 'xbam_test_%'
        AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
  );
  for (const row of rows) {
    await client.query(`DROP DATABASE IF EXISTS "${row.datname}"`).catch(() => undefined);
  }
}

/**
 * The mutex.
 *
 * Any number, as long as every run picks the same one. Taken on a connection to
 * the *base* database, which every run shares, so it is a lock across runs
 * rather than one within a database that does not exist yet.
 */
const SETUP_LOCK = 8_417_231;

export async function setupTestDatabase(): Promise<void> {
  if (owned) return;

  const base = baseUrl();
  const name = `xbam_test_${process.pid}_${randomBytes(3).toString('hex')}`;

  const admin = await adminClient();
  try {
    // Held across the sweep, the create, and the first connection -- because
    // the gap between creating a database and connecting to it is exactly when
    // another run's sweep would decide it is finished with.
    await admin.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);
    await dropFinished(admin).catch(() => undefined);
    await admin.query(`CREATE DATABASE "${name}"`);
    owned = name;

    process.env.DATABASE_URL = base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
    if (!process.env.XBAM_MASTER_KEY) {
      process.env.XBAM_MASTER_KEY = randomBytes(32).toString('base64');
    }
    // Inside the lock: this is the connection that makes the new database
    // visibly in use, and until it exists the database looks abandoned.
    await migrate();
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
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

/**
 * Closes the pool between files, and keeps the database.
 *
 * `afterAll` runs once per file, not once per run, so dropping here made a new
 * database for every file -- sixty-odd per run, none of them cleaned up,
 * because the process that owns one is the one that cannot drop it. The pool
 * reopens on the next query against the same URL, so closing it is all this
 * needs to do; the database is dropped by the next run's `dropFinished`, once
 * nobody is connected to it.
 */
export async function teardownTestDatabase(): Promise<void> {
  await closePool();
}

export const uniqueSuffix = (): string => randomBytes(4).toString('hex');
