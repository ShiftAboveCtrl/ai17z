import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createLogger } from '@xbam/shared';
import { getPool } from './pool';

const log = createLogger('migrate');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  applied_at: string;
}

export function migrationsDir(): string {
  // packages/database/src/migrator.ts -> repo root -> migrations
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../migrations');
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(resolve(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function appliedMigrations(): Promise<AppliedMigration[]> {
  await ensureMigrationsTable();
  const res = await getPool().query('SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name');
  return res.rows as AppliedMigration[];
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  drifted: string[];
}

/**
 * Applies pending migrations, each inside its own transaction. Already-applied
 * files whose contents changed are reported as drift rather than re-run: editing
 * a shipped migration is a mistake, and silently ignoring it hides schema skew.
 */
export async function migrate(dir = migrationsDir()): Promise<MigrateResult> {
  await ensureMigrationsTable();
  const files = loadMigrations(dir);
  const applied = new Map((await appliedMigrations()).map((m) => [m.name, m.checksum]));
  const result: MigrateResult = { applied: [], skipped: [], drifted: [] };

  for (const file of files) {
    const existing = applied.get(file.name);
    if (existing) {
      result.skipped.push(file.name);
      if (existing !== file.checksum) {
        result.drifted.push(file.name);
        log.warn('migration file changed after it was applied', { name: file.name });
      }
      continue;
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
      await client.query('COMMIT');
      result.applied.push(file.name);
      log.info('applied migration', { name: file.name });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return result;
}

/** Destroys every XBAM table. Test helper only; refuses to run in production. */
export async function resetSchema(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSchema() is not permitted when NODE_ENV=production');
  }
  await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

/**
 * Where a database command is about to write, with no credentials in it.
 *
 * Printed before anything is applied, because the target comes from an
 * environment file that is edited rarely and read every time. A checkout whose
 * DATABASE_URL still pointed at a running installation applied three unreleased
 * migrations to it, and the output said "Applied 3 migration(s)" without ever
 * naming the database -- so there was nothing to notice.
 */
export function describeTarget(url = process.env.DATABASE_URL ?? ''): string {
  if (!url) return 'no DATABASE_URL set';
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '') || '(default)';
    // Never the username or password: this string is printed and logged.
    return `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
  } catch {
    // A malformed URL is worth saying so about rather than guessing at.
    return 'an unreadable DATABASE_URL';
  }
}
