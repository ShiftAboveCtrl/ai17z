#!/usr/bin/env tsx
/**
 * Refuses to let a tenant runtime start against somebody else's anything.
 *
 * This is the check at the moment it matters. Every rule it enforces is
 * written down elsewhere, and written-down rules are enforced at the point a
 * process starts or they are enforced nowhere: a runtime that boots against
 * the shared development database has already read another tenant's rows
 * before any later check could have an opinion.
 *
 * It asks four questions and refuses on any of them.
 *
 * Is this runtime's database its own? `connectionIsIsolated` derives the name
 * from the runtime id rather than trusting a configured one, for the same
 * reason `resolveProfileDir` derives a browser profile path: a name written by
 * one machine and read by another is a second, empty thing that looks exactly
 * like the first.
 *
 * Is its master key its own? One global key across hosted customers means one
 * compromise is every compromise.
 *
 * Does the server agree? A GRANT that was generated is not a GRANT that ran,
 * so the catalogue is read rather than the intention.
 *
 * And is it allowed to act at all? A suspended runtime that starts and begins
 * posting is the lifecycle enforced in four places and forgotten in a fifth.
 *
 *   npx tsx tools/tenant-preflight.mts                 reads AI17Z_RUNTIME_ID
 *   npx tsx tools/tenant-preflight.mts --runtime rt-1
 *   npx tsx tools/tenant-preflight.mts --json
 *
 * Exit 0 means start. Anything else means do not, and the reason is printed.
 */
import { createHash } from 'node:crypto';
import { hosting, query } from '@xbam/database';
import { runtimeMayAct } from '@xbam/shared/contracts';
import {
  connectionIsIsolated,
  observedIsolationProblems,
  spendPermissionFor,
  tenantDatabasePlan,
  type ObservedDatabase,
  type ObservedRole,
} from '@xbam/runtime';

type Outcome = 'PASS' | 'FAIL' | 'UNAVAILABLE';

interface Finding {
  check: string;
  outcome: Outcome;
  detail: string;
}

const findings: Finding[] = [];
const record = (check: string, outcome: Outcome, detail: string): void => void findings.push({ check, outcome, detail });

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const runtimeId = ((): string => {
  const at = argv.indexOf('--runtime');
  if (at >= 0 && argv[at + 1]) return argv[at + 1]!;
  return process.env.AI17Z_RUNTIME_ID?.trim() ?? '';
})();

/**
 * The master key, as a fingerprint rather than a key.
 *
 * Never printed and never compared by value anywhere a value could be logged:
 * what is useful here is whether two runtimes were handed the same one, and a
 * digest answers that without the key leaving this function.
 */
function masterKeyFingerprint(): string | null {
  const raw = (process.env.AI17Z_MASTER_KEY ?? process.env.XBAM_MASTER_KEY)?.trim();
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

async function checkDatabaseName(): Promise<void> {
  const dsn = process.env.DATABASE_URL?.trim() ?? '';
  if (!dsn) {
    record('Its own database', 'FAIL', 'DATABASE_URL is not set, so this runtime has nowhere of its own to be.');
    return;
  }
  const plan = tenantDatabasePlan(runtimeId);
  const verdict = connectionIsIsolated(dsn, plan);
  if (verdict.ok) {
    record('Its own database', 'PASS', `Connected as ${plan.role} to ${plan.database}, which is derived from this runtime id.`);
    return;
  }
  record('Its own database', 'FAIL', verdict.why);
}

/**
 * What a tenant can actually check about its own key.
 *
 * Not very much, and saying so is the point. A tenant has its own database, so
 * another tenant's key could not be visible from here however hard this
 * looked: whether every tenant got a different key is the control plane's to
 * guarantee when it provisions them.
 *
 * The one mistake a tenant is in a position to catch is being handed the key
 * somebody uses for everything. `AI17Z_SHARED_KEY_FINGERPRINT` is how an
 * operator names that key, and without it this reports UNAVAILABLE rather than
 * a pass, because a question nobody asked is not an answer.
 */
async function checkMasterKey(): Promise<void> {
  const fingerprint = masterKeyFingerprint();
  if (!fingerprint) {
    record('Its own master key', 'FAIL', 'No master key is set, so nothing sealed for this runtime could be opened.');
    return;
  }

  const shared = process.env.AI17Z_SHARED_KEY_FINGERPRINT?.trim();
  if (!shared) {
    record(
      'Its own master key',
      'UNAVAILABLE',
      `A key is set, fingerprint ${fingerprint}. Whether it is this runtime's own cannot be checked from inside a tenant: another tenant's key is in another tenant's database. Set AI17Z_SHARED_KEY_FINGERPRINT to the control plane's own key and this becomes a real check.`,
    );
    return;
  }

  if (shared === fingerprint) {
    record(
      'Its own master key',
      'FAIL',
      'This runtime was handed the key the control plane uses for everything. One global key across hosted customers means one compromise is every compromise.',
    );
    return;
  }

  record(
    'Its own master key',
    'PASS',
    `Fingerprint ${fingerprint}, which is not the shared one. That every tenant has a different key is still the control plane's guarantee, not something checkable from here.`,
  );
}

async function checkServerAgrees(): Promise<void> {
  const plan = tenantDatabasePlan(runtimeId);
  try {
    const roles = await query<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>(
      'SELECT rolname, rolsuper, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = $1',
      [plan.role],
    );
    if (roles.length === 0) {
      record('The server agrees', 'FAIL', `The server has no role named ${plan.role}, so this runtime was never provisioned here.`);
      return;
    }
    const databases = await query<{ datname: string; owner: string; publicconnect: boolean; roleconnect: boolean }>(
      `SELECT d.datname,
              pg_get_userbyid(d.datdba) AS owner,
              has_database_privilege('public', d.datname, 'CONNECT') AS publicconnect,
              has_database_privilege($2, d.datname, 'CONNECT') AS roleconnect
         FROM pg_database d WHERE d.datname = $1`,
      [plan.database, plan.role],
    );
    if (databases.length === 0) {
      record('The server agrees', 'FAIL', `The server has no database named ${plan.database}.`);
      return;
    }
    const row = databases[0]!;
    const role: ObservedRole = {
      role: roles[0]!.rolname,
      superuser: roles[0]!.rolsuper,
      createdb: roles[0]!.rolcreatedb,
      canLogin: roles[0]!.rolcanlogin,
    };
    const database: ObservedDatabase = {
      database: row.datname,
      owner: row.owner,
      connectGrantees: [...(row.roleconnect ? [plan.role] : []), ...(row.publicconnect ? ['PUBLIC'] : [])],
    };
    const problems = observedIsolationProblems(plan, role, database);
    if (problems.length === 0) {
      record('The server agrees', 'PASS', 'The role, the owner and the connect grants are what the plan asked for.');
      return;
    }
    record('The server agrees', 'FAIL', problems.join(' '));
  } catch (error) {
    record('The server agrees', 'UNAVAILABLE', `The catalogue could not be read: ${(error as Error).message}`);
  }
}

async function checkMayAct(): Promise<void> {
  try {
    const runtime = await hosting.getRuntime(runtimeId);
    if (!runtime) {
      record(
        'Allowed to act',
        'UNAVAILABLE',
        'This database has no record of the runtime, which is expected inside a tenant: the control plane holds that row.',
      );
      return;
    }
    const spend = spendPermissionFor(runtime.state);
    if (runtimeMayAct(runtime.state)) {
      record('Allowed to act', 'PASS', `The runtime is ${runtime.state}.`);
      return;
    }
    record(
      'Allowed to act',
      'FAIL',
      `The runtime is ${runtime.state}, so it may not act. Owner access is ${spend.ownerAccess ? 'still available' : 'not available'}, and starting it anyway is how a suspended agent keeps posting.`,
    );
  } catch (error) {
    record('Allowed to act', 'UNAVAILABLE', `That could not be read: ${(error as Error).message}`);
  }
}

function report(): number {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ runtimeId, findings }, null, 2)}\n`);
  } else {
    const width = Math.max(...findings.map((f) => f.check.length), 10);
    process.stdout.write(`\nTenant preflight for ${runtimeId}\n\n`);
    for (const finding of findings) {
      process.stdout.write(`  ${finding.check.padEnd(width)}  ${finding.outcome}\n`);
      process.stdout.write(`  ${' '.repeat(width)}  ${finding.detail}\n\n`);
    }
  }

  const failed = findings.filter((f) => f.outcome === 'FAIL');
  if (!asJson) {
    if (failed.length > 0) {
      process.stdout.write(`${failed.length} check${failed.length === 1 ? '' : 's'} failed. Do not start this runtime.\n\n`);
    } else {
      const unavailable = findings.filter((f) => f.outcome === 'UNAVAILABLE').length;
      process.stdout.write(
        unavailable > 0
          ? `Nothing failed, and ${unavailable} check${unavailable === 1 ? '' : 's'} could not run. That is not the same as passing.\n\n`
          : 'Every check passed. Safe to start.\n\n',
      );
    }
  }
  return failed.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  if (!runtimeId) {
    process.stderr.write(
      'No runtime id. Set AI17Z_RUNTIME_ID or pass --runtime <id>.\n' +
        'There is deliberately no default: a preflight that guessed which runtime it was checking would pass for the wrong one.\n',
    );
    process.exit(2);
  }

  await checkDatabaseName();
  await checkMasterKey();
  await checkServerAgrees();
  await checkMayAct();
  process.exit(report());
}

void main();
