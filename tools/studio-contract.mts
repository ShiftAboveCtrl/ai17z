/**
 * Proves AI17Z core against a running AI17Z Studio.
 *
 *   node tools/studio-contract.mts <path to ai17z-studio> [--admin-url postgres://.../postgres]
 *
 * Makes a throwaway `ai17z_studio_contract` database, migrates and seeds it
 * with Studio's own scripts, starts Studio's server on a loopback port,
 * runs tests/integration/studioContract.test.ts against it with core's
 * development-origin escape pointed there, then stops the server and drops
 * the database. Every secret it generates lives only for the run.
 *
 * Nothing is published and no money moves. Purchases are prepared exactly as
 * for a wallet, and the transactions they describe are put on a stand-in
 * chain the test runs, which Studio reads to confirm them.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const studioDir = args[0] ? resolve(args[0]) : null;
if (!studioDir) {
  process.stderr.write('Usage: node tools/studio-contract.mts <path to ai17z-studio> [--admin-url postgres://user:pass@host:port/postgres]\n');
  process.exit(2);
}
const adminFlag = args.indexOf('--admin-url');
const adminUrl = adminFlag >= 0 ? args[adminFlag + 1]! : 'postgres://ai17z:ai17z@localhost:55439/postgres';
const DB = 'ai17z_studio_contract';
const PORT = 3310;
// A dotted name, because a Plugin manifest may only name one, that needs no
// hosts file entry: every name under .localhost is loopback (RFC 6761).
const ORIGIN = `http://studio.localhost:${PORT}`;

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const databaseUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${DB}`;
  return url.toString();
})();

const leaseKey = JSON.stringify({
  ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
  kid: `contract-${randomBytes(4).toString('hex')}`,
});
const studioEnv: Record<string, string> = {
  DATABASE_URL: databaseUrl,
  SITE_URL: ORIGIN,
  NEXT_PUBLIC_SITE_URL: ORIGIN,
  SESSION_SECRET: randomBytes(48).toString('base64'),
  STUDIO_SECRETS_KEY: randomBytes(48).toString('base64'),
  STUDIO_LEASE_SIGNING_JWK: leaseKey,
  AI17Z_MARKETPLACE_PAID_ENABLED: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
  // The test hosts a stand-in chain and DexScreener on this port (tests/support/fakeChain.ts),
  // so a reported transaction is confirmed by reading it, exactly as on the real chain.
  ROBINHOOD_CHAIN_RPC_URL: 'http://127.0.0.1:8547',
  DEXSCREENER_API_BASE: 'http://127.0.0.1:8547/dex',
  // The reference hosted backend the test starts, reachable only because Studio is served over http here.
  STUDIO_UNSAFE_DEV_PRIVATE_UPSTREAMS: 'http://127.0.0.1:8795',
  CONTRACT_PROPRIETARY_UPSTREAM: 'http://127.0.0.1:8795/',
};

function step(label: string, command: string, commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  process.stdout.write(`\n== ${label}\n`);
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

async function waitForHealth(server: ChildProcess): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 300_000) {
    if (server.exitCode !== null) throw new Error(`Studio exited early with code ${server.exitCode}.`);
    try {
      const response = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        // Compile the routes the test uses before it starts timing them.
        for (const path of ['/api/v1/plugins', '/api/v1/lease-keys']) await fetch(`${ORIGIN}${path}`).catch(() => undefined);
        return;
      }
    } catch {
      // Not listening yet; this loop is the wait.
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error('Studio did not answer /api/health within five minutes.');
}

function stop(server: ChildProcess | null): void {
  if (!server?.pid || server.exitCode !== null) return;
  // The dev server starts children of its own; the tree has to go.
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-server.pid, 'SIGTERM');
}

let server: ChildProcess | null = null;
const scratch = mkdtempSync(join(tmpdir(), 'ai17z-contract-'));
let code = 1;
try {
  await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${DB}`);
  const env = { ...process.env, ...studioEnv, NODE_ENV: 'development' };
  step('migrate Studio', process.execPath, ['scripts/migrate.mjs'], studioDir, env);
  step('seed Studio', process.execPath, ['scripts/seed.mjs'], studioDir, env);

  process.stdout.write(`\n== start Studio on ${ORIGIN}\n`);
  server = spawn(process.execPath, [join(studioDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(PORT)], {
    cwd: studioDir,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: process.platform !== 'win32',
  });
  await waitForHealth(server);

  const envFile = join(scratch, 'studio-env.json');
  writeFileSync(envFile, JSON.stringify(studioEnv));
  const vitest = spawnSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/integration/studioContract.test.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, STUDIO_CONTRACT_URL: ORIGIN, STUDIO_CONTRACT_DIR: studioDir, STUDIO_CONTRACT_ENV: envFile },
      stdio: 'inherit',
    },
  );
  code = vitest.status ?? 1;
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  code = 1;
} finally {
  stop(server);
  rmSync(scratch, { recursive: true, force: true });
  await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
}
process.stdout.write(code === 0 ? '\nstudio contract: PASSED\n' : '\nstudio contract: FAILED\n');
process.exit(code);
