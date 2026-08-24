import { randomBytes } from 'node:crypto';
import { loadEnv } from '@xbam/shared';
import { closePool, migrate, query } from '@xbam/database';

/**
 * Integration tests run against a real Postgres database, never a mock.
 *
 * The schema is the contract for most of this system (unique indexes carry the
 * idempotency guarantees), so testing it against anything else would test the
 * wrong thing.
 */
export async function setupTestDatabase(): Promise<void> {
  loadEnv();
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL must be set to run integration tests.');
  // Point at the sibling test database rather than the working one.
  process.env.DATABASE_URL = base.replace(/\/[^/?]+(\?|$)/, '/xbam_test$1');
  if (!process.env.XBAM_MASTER_KEY) {
    process.env.XBAM_MASTER_KEY = randomBytes(32).toString('base64');
  }
  await migrate();
}

/** Empties every domain table, leaving the schema and catalogue seeds intact. */
export async function truncateAll(): Promise<void> {
  const rows = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations')`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function teardownTestDatabase(): Promise<void> {
  await closePool();
}

export const uniqueSuffix = (): string => randomBytes(4).toString('hex');
