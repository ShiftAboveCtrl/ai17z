/**
 * Asks a host whether the boundaries it was asked for are actually there.
 *
 * Every check in here has a generated half and an observed half, and this tool
 * is the observed one. A rule that was generated is not a rule that is loaded;
 * a GRANT that was generated is not a GRANT that ran; a guest that was planned
 * is not a guest that booted. Each of those failures is silent, and each looks
 * exactly like success from the control plane.
 *
 * It reads and reports. It changes nothing, loads nothing, and provisions
 * nothing, so it is safe to run on a host holding live tenants.
 *
 *   npx tsx tools/hosted-isolation-check.mts                  everything it can reach
 *   npx tsx tools/hosted-isolation-check.mts --runtime rt-1   one runtime's database
 *   npx tsx tools/hosted-isolation-check.mts --json           for something else to read
 *
 * On a machine that is not a Linux host it says so for each check rather than
 * passing. A check that cannot run is not a check that passed, which is the
 * same reason the release preflight is *run* in the packaging stage rather
 * than assumed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@xbam/database';
import {
  MANDATORY_DENIALS,
  egressPlan,
  observedIsolationProblems,
  tenantDatabasePlan,
  verifyLoadedRuleset,
  type ObservedDatabase,
  type ObservedRole,
} from '@xbam/runtime';

const run = promisify(execFile);

type Outcome = 'PASS' | 'FAIL' | 'UNAVAILABLE';

interface Finding {
  check: string;
  outcome: Outcome;
  detail: string;
}

const findings: Finding[] = [];

function record(check: string, outcome: Outcome, detail: string): void {
  findings.push({ check, outcome, detail });
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const runtimeArg = ((): string | undefined => {
  const at = argv.indexOf('--runtime');
  return at >= 0 ? argv[at + 1] : undefined;
})();

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

async function checkEgress(): Promise<void> {
  if (process.platform !== 'linux') {
    record(
      'Egress rules loaded',
      'UNAVAILABLE',
      `This is ${process.platform}. nftables is a Linux host facility, so nothing here can say whether a tenant guest is filtered.`,
    );
    return;
  }

  let ruleset = '';
  try {
    const { stdout } = await run('nft', ['list', 'ruleset'], { timeout: 10_000 });
    ruleset = stdout;
  } catch (error) {
    record(
      'Egress rules loaded',
      'UNAVAILABLE',
      `nft could not be read (${(error as Error).message}). Root is usually needed, and a ruleset nobody could read is not a ruleset that is absent.`,
    );
    return;
  }

  const verdict = verifyLoadedRuleset(ruleset, egressPlan());
  if (verdict.enforced) {
    record('Egress rules loaded', 'PASS', `All ${MANDATORY_DENIALS.length} mandatory denials are present and the chain drops by default.`);
    return;
  }
  record(
    'Egress rules loaded',
    'FAIL',
    verdict.missing.length > 0
      ? `${verdict.why} Missing: ${verdict.missing.join(', ')}.`
      : verdict.why,
  );
}

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

async function checkGuests(): Promise<void> {
  if (process.platform !== 'linux') {
    record('Guests are jailed', 'UNAVAILABLE', `This is ${process.platform}. There is no jailer process tree to read.`);
    return;
  }

  try {
    const { stdout } = await run('ps', ['-eo', 'pid,ppid,user,comm'], { timeout: 10_000 });
    const lines = stdout.split('\n').slice(1).filter((l) => l.trim());
    const firecracker = lines.filter((l) => /firecracker/.test(l));
    const jailer = lines.filter((l) => /jailer/.test(l));

    if (firecracker.length === 0) {
      record('Guests are jailed', 'PASS', 'No guest is running on this host, so there is nothing unjailed.');
      return;
    }

    const asRoot = firecracker.filter((l) => /\broot\b/.test(l));
    if (asRoot.length > 0) {
      record(
        'Guests are jailed',
        'FAIL',
        `${asRoot.length} of ${firecracker.length} Firecracker processes are running as root, which defeats the jailer they should be under.`,
      );
      return;
    }
    record(
      'Guests are jailed',
      'PASS',
      `${firecracker.length} guest process${firecracker.length === 1 ? '' : 'es'}, none as root, alongside ${jailer.length} jailer process${jailer.length === 1 ? '' : 'es'}.`,
    );
  } catch (error) {
    record('Guests are jailed', 'UNAVAILABLE', `The process list could not be read: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Tenant databases
// ---------------------------------------------------------------------------

/**
 * Asks the server about one tenant's database rather than trusting the plan.
 *
 * Read only: three catalogue queries and no write. `has_database_privilege`
 * is asked for `public` explicitly, because PUBLIC being able to connect is
 * the failure that a provisioning step half running leaves behind and the one
 * nothing else would notice.
 */
async function checkTenantDatabase(runtimeId: string): Promise<void> {
  const plan = tenantDatabasePlan(runtimeId);

  try {
    const roles = await query<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>(
      'SELECT rolname, rolsuper, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = $1',
      [plan.role],
    );
    if (roles.length === 0) {
      record(`Tenant database for ${runtimeId}`, 'FAIL', `The server has no role named ${plan.role}, so this runtime has no database of its own.`);
      return;
    }

    const databases = await query<{ datname: string; owner: string; publicconnect: boolean; roleconnect: boolean }>(
      `SELECT d.datname,
              pg_get_userbyid(d.datdba) AS owner,
              has_database_privilege('public', d.datname, 'CONNECT') AS publicconnect,
              has_database_privilege($2, d.datname, 'CONNECT') AS roleconnect
         FROM pg_database d
        WHERE d.datname = $1`,
      [plan.database, plan.role],
    );
    if (databases.length === 0) {
      record(`Tenant database for ${runtimeId}`, 'FAIL', `The server has no database named ${plan.database}.`);
      return;
    }

    const row = databases[0]!;
    const observedRole: ObservedRole = {
      role: roles[0]!.rolname,
      superuser: roles[0]!.rolsuper,
      createdb: roles[0]!.rolcreatedb,
      canLogin: roles[0]!.rolcanlogin,
    };
    const observedDatabase: ObservedDatabase = {
      database: row.datname,
      owner: row.owner,
      connectGrantees: [
        ...(row.roleconnect ? [plan.role] : []),
        ...(row.publicconnect ? ['PUBLIC'] : []),
      ],
    };

    const problems = observedIsolationProblems(plan, observedRole, observedDatabase);
    if (problems.length === 0) {
      record(`Tenant database for ${runtimeId}`, 'PASS', `${plan.database} is owned by ${plan.role}, PUBLIC cannot connect, and the role holds none of the privileges that reach another tenant.`);
      return;
    }
    record(`Tenant database for ${runtimeId}`, 'FAIL', problems.join(' '));
  } catch (error) {
    record(
      `Tenant database for ${runtimeId}`,
      'UNAVAILABLE',
      `The server could not be asked: ${(error as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(): number {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
  } else {
    const width = Math.max(...findings.map((f) => f.check.length), 10);
    process.stdout.write('\nHosted isolation, as the host reports it\n\n');
    for (const finding of findings) {
      process.stdout.write(`  ${finding.check.padEnd(width)}  ${finding.outcome}\n`);
      process.stdout.write(`  ${' '.repeat(width)}  ${finding.detail}\n\n`);
    }
  }

  const failed = findings.filter((f) => f.outcome === 'FAIL').length;
  const unavailable = findings.filter((f) => f.outcome === 'UNAVAILABLE').length;

  if (!asJson) {
    if (failed > 0) {
      process.stdout.write(`${failed} boundary this host was asked for is not there. A tenant on it is not isolated as described.\n\n`);
    } else if (unavailable > 0) {
      // Said rather than rounded up to a pass, because a check that could not
      // run is exactly the shape of a boundary nobody has verified.
      process.stdout.write(`Nothing failed, and ${unavailable} check${unavailable === 1 ? '' : 's'} could not run. That is not the same as passing.\n\n`);
    } else {
      process.stdout.write('Every boundary this tool can see is there.\n\n');
    }
  }

  return failed > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  await checkEgress();
  await checkGuests();

  if (runtimeArg) {
    await checkTenantDatabase(runtimeArg);
  } else {
    try {
      const rows = await query<{ id: string }>(
        "SELECT id FROM hosted_runtimes WHERE state NOT IN ('DELETED') ORDER BY created_at LIMIT 50",
      );
      if (rows.length === 0) {
        record('Tenant databases', 'PASS', 'There are no hosted runtimes recorded, so there is nothing to check.');
      } else {
        for (const row of rows) await checkTenantDatabase(row.id);
      }
    } catch (error) {
      record('Tenant databases', 'UNAVAILABLE', `The runtime list could not be read: ${(error as Error).message}`);
    }
  }

  process.exit(report());
}

void main();
