#!/usr/bin/env tsx
/**
 * Provisions a tenant the whole way through, against a real Postgres server.
 *
 * `tenantProvisioning.ts` is ordered steps and `tenantDatabase.ts` is SQL, and
 * until now neither had been run: the statements had never met a server and the
 * step order had never been walked. A step list that has never executed is a
 * plan, and the specific thing a plan cannot tell you is which step fails
 * against the real thing.
 *
 * So this runs them. Two tenants, each getting its own database, role and
 * sealed key, with the real ordering, the real conditional transitions, and the
 * real refusals. Then it tries to cross between them and has to fail.
 *
 *   npx tsx tools/hosted-provision-lab.mts
 *   npx tsx tools/hosted-provision-lab.mts --keep    leave the rows to inspect
 *
 * It needs superuser rights on the server to create a database and a role,
 * which is what a control plane has and a tenant does not. It names everything
 * it creates after the run so a teardown can find it, and removes it all
 * unless asked not to.
 *
 * It does not boot a guest and does not start AI17Z. Those are the next thing,
 * and pretending otherwise by calling a provisioned database a provisioned
 * tenant is the kind of claim this harness exists to avoid making.
 */
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { hosting, query } from '@xbam/database';
import {
  PROVISIONING_STEPS,
  connectionIsIsolated,
  mayMarkReady,
  nextAction,
  newRuntimeMasterKey,
  observedIsolationProblems,
  orphanReport,
  provisioningStatements,
  rollbackOrder,
  statementIsControlPlaneSafe,
  stateAfterFailure,
  teardownStatements,
  tenantDatabasePlan,
  tenantSchemaStatements,
  type ObservedDatabase,
  type ObservedRole,
} from '@xbam/runtime';

const KEEP = process.argv.includes('--keep');
const TAG = `plab-${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

const ok = (what: string, detail = ''): void => {
  passed += 1;
  process.stdout.write(`  ok    ${what}${detail ? ` (${detail})` : ''}\n`);
};
const bad = (what: string, detail: string): void => {
  failed += 1;
  process.stdout.write(`  FAIL  ${what}\n        ${detail}\n`);
};
const check = (what: string, condition: boolean, detail = ''): void => {
  if (condition) ok(what, detail);
  else bad(what, detail || 'expected this to hold');
};
const say = (heading: string): void => {
  process.stdout.write(`\n${heading}\n`);
};

/** Databases and roles this run created, so teardown is exact. */
const created: { database: string; role: string }[] = [];

async function superuserCan(): Promise<boolean> {
  const [row] = await query<{ superuser: boolean }>('SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user');
  return Boolean(row?.superuser);
}

async function provisionOne(name: string): Promise<{ runtimeId: string; database: string; role: string } | null> {
  const tenant = await hosting.upsertTenant({ accountRef: `${TAG}-${name}`, label: `${TAG} ${name}` });
  const { row: runtime } = await hosting.provisionRuntime({
    tenantId: tenant.id,
    runtimeClass: 'lab-general',
    version: 'lab-1',
    region: 'lab',
    provisionKey: `${TAG}-${name}-prov`,
  });

  const plan = tenantDatabasePlan(runtime.id);
  // A password per runtime, generated here and never printed. A lab that
  // printed one would be a lab somebody copied a habit from.
  const password = randomBytes(24).toString('base64url');

  /*
    Two lists, two connections, and the distinction is not cosmetic. A schema
    GRANT or REVOKE applies to whichever database the connection is on: running
    them all here sent `REVOKE ALL ON SCHEMA public FROM PUBLIC` to the control
    plane's own database and gave each tenant role CREATE on `public` there.
    The guard refuses that now, and this asserts it rather than trusting it.
  */
  for (const statement of provisioningStatements(plan, password)) {
    const safe = statementIsControlPlaneSafe(statement);
    if (!safe.ok) throw new Error(`refusing to run on the control plane: ${safe.why}`);
    await query(statement);
  }
  created.push({ database: plan.database, role: plan.role });

  // And the schema statements, on a connection to the tenant's own database.
  const control = new URL(process.env.DATABASE_URL ?? '');
  control.pathname = `/${plan.database}`;
  const tenantPool = new Pool({ connectionString: control.toString(), max: 1 });
  try {
    for (const statement of tenantSchemaStatements(plan)) await tenantPool.query(statement);
  } finally {
    await tenantPool.end();
  }

  return { runtimeId: runtime.id, database: plan.database, role: plan.role };
}

/** What the server says about a tenant, as the guard wants it. */
async function observe(plan: ReturnType<typeof tenantDatabasePlan>): Promise<{ role: ObservedRole; database: ObservedDatabase } | null> {
  const roles = await query<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>(
    'SELECT rolname, rolsuper, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = $1',
    [plan.role],
  );
  if (roles.length === 0) return null;
  const databases = await query<{ datname: string; owner: string; publicconnect: boolean; roleconnect: boolean }>(
    `SELECT d.datname,
            pg_get_userbyid(d.datdba) AS owner,
            has_database_privilege('public', d.datname, 'CONNECT') AS publicconnect,
            has_database_privilege($2, d.datname, 'CONNECT') AS roleconnect
       FROM pg_database d WHERE d.datname = $1`,
    [plan.database, plan.role],
  );
  if (databases.length === 0) return null;
  const row = databases[0]!;
  return {
    role: {
      role: roles[0]!.rolname,
      superuser: roles[0]!.rolsuper,
      createdb: roles[0]!.rolcreatedb,
      canLogin: roles[0]!.rolcanlogin,
    },
    database: {
      database: row.datname,
      owner: row.owner,
      connectGrantees: [...(row.roleconnect ? [plan.role] : []), ...(row.publicconnect ? ['PUBLIC'] : [])],
    },
  };
}

async function main(): Promise<void> {
  process.stdout.write(`AI17Z hosted provisioning lab, run ${TAG}\n`);

  say('The step list itself');
  const first = nextAction({ runtimeId: 'none', completed: [] });
  check('provisioning starts where the list starts', first.action === 'RUN' && first.step.name === PROVISIONING_STEPS[0]!.name, first.action === 'RUN' ? first.step.name : first.action);
  const rollback = rollbackOrder(PROVISIONING_STEPS.map((s) => s.name));
  check('a rollback undoes newest first', rollback[0] === 'MARK_NOT_READY', rollback[0] ?? 'nothing');
  check('a failed provision leaves no state that may act', stateAfterFailure(true) === 'DELETED' && stateAfterFailure(false) === 'FAILED');

  if (!(await superuserCan())) {
    say('Creating a database needs the rights a control plane has');
    bad(
      'this connection can create a database and a role',
      'The current user is not a superuser, so the provisioning statements cannot run. That is the correct arrangement for a tenant connection and the wrong one for this harness.',
    );
    process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }
  ok('this connection can create a database and a role', 'superuser, as a control plane is');

  say('Two tenants, each provisioned for real');
  const alpha = await provisionOne('alpha');
  const beta = await provisionOne('beta');
  if (!alpha || !beta) {
    bad('two tenants were provisioned', 'provisioning returned nothing');
    process.exit(1);
  }
  ok('two tenants have their own database and role', `${alpha.database} and ${beta.database}`);
  check('their databases do not collide', alpha.database !== beta.database);
  check('their roles do not collide', alpha.role !== beta.role);

  say('What the server actually says about them');
  for (const [name, one] of [
    ['alpha', alpha],
    ['beta', beta],
  ] as const) {
    const plan = tenantDatabasePlan(one.runtimeId);
    const observed = await observe(plan);
    if (!observed) {
      bad(`${name} exists on the server`, 'the role or the database is not there');
      continue;
    }
    const problems = observedIsolationProblems(plan, observed.role, observed.database);
    check(`${name} is isolated as the plan asked`, problems.length === 0, problems.join(' '));
    check(`${name} owns its own database`, observed.database.owner === plan.role, observed.database.owner);
    check(`PUBLIC cannot connect to ${name}`, !observed.database.connectGrantees.includes('PUBLIC'));
    check(`${name} is no superuser and may create no database`, !observed.role.superuser && !observed.role.createdb);
  }

  say('Every way one tenant might be pointed at the other');
  const alphaPlan = tenantDatabasePlan(alpha.runtimeId);
  const betaPlan = tenantDatabasePlan(beta.runtimeId);
  check(
    "alpha connection string naming beta database is refused",
    !connectionIsIsolated(`postgres://${alphaPlan.role}:x@h:5432/${betaPlan.database}`, alphaPlan).ok,
  );
  check(
    'alpha connecting as beta role is refused',
    !connectionIsIsolated(`postgres://${betaPlan.role}:x@h:5432/${alphaPlan.database}`, alphaPlan).ok,
  );
  const shared = connectionIsIsolated(`postgres://${alphaPlan.role}:x@h:5432/xbam`, alphaPlan);
  check('alpha pointed at the shared development database is refused', !shared.ok, shared.ok ? '' : shared.why.slice(0, 60));
  check(
    'alpha own connection string is accepted',
    connectionIsIsolated(`postgres://${alphaPlan.role}:secret@h:5432/${alphaPlan.database}`, alphaPlan).ok,
  );

  say('The schema statements went to the tenant database, not this one');
  for (const [name, one] of [
    ['alpha', alpha],
    ['beta', beta],
  ] as const) {
    const plan = tenantDatabasePlan(one.runtimeId);
    const tenantUrl = new URL(process.env.DATABASE_URL ?? '');
    tenantUrl.pathname = `/${plan.database}`;
    const pool = new Pool({ connectionString: tenantUrl.toString(), max: 1 });
    try {
      const { rows } = await pool.query<{ granted: boolean }>(
        "SELECT has_schema_privilege($1, 'public', 'CREATE') AS granted",
        [plan.role],
      );
      check(`${name} role has schema rights in its own database`, Boolean(rows[0]?.granted));
      const { rows: pub } = await pool.query<{ granted: boolean }>(
        "SELECT has_schema_privilege('public', 'public', 'USAGE') AS granted",
      );
      check(`PUBLIC has no schema usage in ${name} own database`, !pub[0]?.granted);
    } finally {
      await pool.end();
    }
  }
  // And the control plane is untouched, which is the thing that went wrong.
  const [hereRole] = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM pg_namespace WHERE nspname = 'public' AND nspacl::text LIKE '%ai17z_r_%'",
  );
  check('no tenant role holds schema rights in the control plane database', hereRole?.n === '0', `found ${hereRole?.n}`);
  const [herePublic] = await query<{ granted: boolean }>(
    "SELECT has_schema_privilege('public', 'public', 'USAGE') AS granted",
  );
  check('PUBLIC still has schema usage in the control plane database', Boolean(herePublic?.granted));

  say('Keys');
  const keyA = newRuntimeMasterKey();
  const keyB = newRuntimeMasterKey();
  check('a runtime key is 32 bytes', keyA.byteLength === 32, `${keyA.byteLength}`);
  check('two runtimes get different keys', !keyA.equals(keyB));

  say('Before anything outside may reach a runtime');
  const notReady = mayMarkReady({ egressEnforced: true, guestMatchesPlan: false, databaseIsolated: true, keyIsItsOwn: true });
  check('a runtime whose guest was never checked is not marked ready', !notReady.ready, notReady.ready ? '' : notReady.missing.join(' '));
  const ready = mayMarkReady({ egressEnforced: true, guestMatchesPlan: true, databaseIsolated: true, keyIsItsOwn: true });
  check('one with every boundary confirmed may be', ready.ready);
  ok(
    'no runtime was marked ready by this harness',
    'it boots no guest, so guestMatchesPlan is something it cannot honestly assert',
  );

  say('A rollback that failed says what it left');
  const report = orphanReport({ runtimeId: alpha.runtimeId, undosAttempted: ['DROP_DATABASE'], undosFailed: ['DROP_DATABASE'] });
  // The sentence is plural, because what is left behind is a list.
  check('an orphan report names what is left and asks for a person', report.includes('DROP_DATABASE') && report.includes('need a person'), report);

  say('Clearing up');
  if (KEEP) {
    ok('rows and databases left for inspection', `${created.length} database(s), and the tag is ${TAG}`);
  } else {
    let removed = 0;
    for (const one of [alpha, beta]) {
      const plan = tenantDatabasePlan(one.runtimeId);
      for (const statement of teardownStatements(plan)) {
        try {
          await query(statement);
        } catch {
          // A terminate that matches nothing is not a failure.
        }
      }
      const still = await observe(plan);
      if (!still) removed += 1;
    }
    check('the lab removed the databases and roles it created', removed === 2, `${removed} of 2`);
    await query(`DELETE FROM hosted_runtimes WHERE provision_key LIKE $1`, [`${TAG}-%`]);
    await query(`DELETE FROM hosted_tenants WHERE account_ref LIKE $1`, [`${TAG}-%`]);
    ok('and its control-plane rows');
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  process.stderr.write(`\nThe lab stopped: ${(error as Error).message}\n`);
  process.stderr.write(
    `Anything it created is tagged ${TAG}. Databases are named from the runtime id, so find them with:\n` +
      `  SELECT datname FROM pg_database WHERE datname LIKE 'ai17z_t_%';\n`,
  );
  process.exit(1);
});
