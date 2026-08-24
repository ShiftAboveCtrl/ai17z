import pg from 'pg';
import { createLogger, envInt, loadEnv } from '@xbam/shared';

const log = createLogger('db');

// Postgres returns bigint/numeric as strings by default to avoid precision loss.
// XBAM only uses them for counts and small costs, so parse them into numbers.
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10)); // int8
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v)); // numeric

export type QueryParam = unknown;

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: QueryParam[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  loadEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and start Postgres with `npm run db:up`.');
  }
  pool = new pg.Pool({
    connectionString,
    max: envInt('XBAM_DB_POOL_MAX', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: envInt('XBAM_DB_CONNECT_TIMEOUT_MS', 10_000),
  });
  pool.on('error', (err) => log.error('idle client error', { message: err.message }));
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: QueryParam[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}

export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: QueryParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export interface Tx extends Queryable {
  one<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T | null>;
  many<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T[]>;
}

/**
 * Runs `fn` inside a single transaction. Any throw rolls back. Every multi-table
 * write in XBAM goes through this so a crash can never leave half a job behind.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const tx: Tx = {
    query: (text, params) => client.query(text, (params ?? []) as never[]) as never,
    async many(text, params = []) {
      const res = await client.query(text, params as never[]);
      return res.rows as never[];
    },
    async one(text, params = []) {
      const res = await client.query(text, params as never[]);
      return (res.rows[0] ?? null) as never;
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      log.error('rollback failed', { message: (rollbackError as Error).message });
    }
    throw error;
  } finally {
    client.release();
  }
}

/** True when the error is a unique-constraint violation on the given index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  if (e?.code !== '23505') return false;
  return constraint ? e.constraint === constraint : true;
}

export async function pingDatabase(): Promise<{ ok: boolean; detail: string }> {
  try {
    const rows = await query<{ version: string }>('SELECT version() AS version');
    return { ok: true, detail: (rows[0]?.version ?? 'postgres').split(',')[0] ?? 'postgres' };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
