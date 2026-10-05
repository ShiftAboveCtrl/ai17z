import { createHash } from 'node:crypto';

/**
 * One tenant, one database, one role.
 *
 * The failure this exists to prevent has a shape rather than a name: a single
 * database with an `account_id` column on every table, which is defeated by
 * one missing predicate in one query and is how multi-tenant systems leak.
 * AI17Z's own repositories are written against unique indexes and foreign keys
 * precisely because application logic is the layer that forgets, and a tenant
 * boundary made of predicates is a boundary made of the thing that forgets.
 *
 * So the boundary is Postgres' own: a database per tenant, a role that can
 * reach exactly that database, and `PUBLIC` revoked so a role nobody granted
 * anything to cannot connect by default. None of that is novel. What is worth
 * writing down is that it is checked, and what the checks refuse.
 *
 * Two rules carried over from work this repository has already paid for.
 *
 * Names are derived locally from the runtime id, never read back from a stored
 * value, for the same reason `resolveProfileDir` derives a browser profile path
 * rather than trusting one: a path or a name written by one machine and read by
 * another is a second, empty thing that looks exactly like the first.
 *
 * And a plan is not a database. `isolationProblems` checks the plan;
 * `observedIsolationProblems` checks what the server reports. A GRANT that was
 * generated is not a GRANT that ran.
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Postgres truncates an identifier at 63 bytes, so a long runtime id would
 * collide with another long one and two tenants would share a database without
 * anything failing.
 */
const MAX_IDENTIFIER = 63;
const PREFIX_DB = 'ai17z_t_';
const PREFIX_ROLE = 'ai17z_r_';

/** Lower-case, underscore, digits. Everything else is a quoting problem. */
function slug(runtimeId: string): string {
  const cleaned = runtimeId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned) throw new Error('A runtime id that reduces to nothing cannot name a database.');
  // A hash suffix rather than a plain truncation: truncating is exactly how two
  // long ids become one name.
  const digest = createHash('sha256').update(runtimeId).digest('hex').slice(0, 12);
  const room = MAX_IDENTIFIER - PREFIX_DB.length - digest.length - 1;
  return `${cleaned.slice(0, Math.max(1, room))}_${digest}`;
}

export function tenantDatabaseName(runtimeId: string): string {
  return `${PREFIX_DB}${slug(runtimeId)}`;
}

export function tenantRoleName(runtimeId: string): string {
  return `${PREFIX_ROLE}${slug(runtimeId)}`;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface TenantDatabasePlan {
  runtimeId: string;
  database: string;
  role: string;
  /** Whether this role may create databases. Always false. */
  mayCreateDatabase: false;
  /** Whether this role is a superuser. Always false. */
  superuser: false;
  /** Whether `PUBLIC` may connect to this database. Always false. */
  publicMayConnect: false;
}

export function tenantDatabasePlan(runtimeId: string): TenantDatabasePlan {
  return {
    runtimeId,
    database: tenantDatabaseName(runtimeId),
    role: tenantRoleName(runtimeId),
    mayCreateDatabase: false,
    superuser: false,
    publicMayConnect: false,
  };
}

/**
 * The one sentence that has to be said out loud, because it is the thing
 * somebody proposes when hosting gets expensive.
 */
export const SHARED_DATABASE_REFUSAL =
  'Customers never share a Postgres database. Separation by an account_id column is not isolation between customers: it is the thing a single missing predicate defeats, and it is how multi-tenant systems leak.';

export function isolationProblems(plan: TenantDatabasePlan): readonly string[] {
  const problems: string[] = [];

  if (plan.database !== tenantDatabaseName(plan.runtimeId)) {
    problems.push('The database name was not derived from the runtime id, so it may be somebody else\'s.');
  }
  if (plan.role !== tenantRoleName(plan.runtimeId)) {
    problems.push('The role name was not derived from the runtime id, so it may be somebody else\'s.');
  }
  if (plan.database === plan.role) {
    problems.push('The database and the role have the same name, which makes a grant ambiguous to read.');
  }
  if (plan.mayCreateDatabase !== false) {
    problems.push('A tenant role that may create databases can create one outside anything that bounds it.');
  }
  if (plan.superuser !== false) {
    problems.push('A tenant role that is a superuser reaches every other tenant on the server.');
  }
  if (plan.publicMayConnect !== false) {
    problems.push('PUBLIC may connect, so any role on the server reaches this tenant.');
  }
  if (plan.database.length > MAX_IDENTIFIER || plan.role.length > MAX_IDENTIFIER) {
    problems.push('The identifier is longer than Postgres keeps, so it would be truncated into somebody else\'s.');
  }

  return problems;
}

/** Whether two tenants would end up in the same place. */
export function plansCollide(a: TenantDatabasePlan, b: TenantDatabasePlan): boolean {
  if (a.runtimeId === b.runtimeId) return true;
  return a.database === b.database || a.role === b.role;
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

/**
 * The SQL that creates the boundary, in order.
 *
 * Returned as statements rather than run, because the privileges needed to run
 * them are the privileges the control plane holds and no test here should.
 *
 * The order matters in one place: `REVOKE CONNECT ... FROM PUBLIC` comes before
 * the grant to the tenant role. The other way round and there is a window in
 * which the database exists and every role on the server can reach it, which is
 * exactly the window a provisioning failure leaves open for ever.
 */
export function provisioningStatements(plan: TenantDatabasePlan, sealedPassword: string): readonly string[] {
  const problems = isolationProblems(plan);
  if (problems.length > 0) throw new Error(`Refusing to provision: ${problems.join(' ')}`);
  if (!sealedPassword) throw new Error('A tenant role is never created without a password.');

  const db = quoteIdentifier(plan.database);
  const role = quoteIdentifier(plan.role);

  return [
    // NOLOGIN until the database exists, so a half-provisioned tenant is not a
    // reachable one.
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    `CREATE DATABASE ${db} OWNER ${role}`,
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`,
    `REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${db} TO ${role}`,
    `ALTER ROLE ${role} LOGIN PASSWORD ${quoteLiteral(sealedPassword)}`,
    // A statement timeout is not isolation, but a tenant holding a lock for
    // ever is a tenant affecting the server every other tenant is on.
    `ALTER ROLE ${role} SET statement_timeout = '120s'`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '60s'`,
    // Leaving `search_path` to the default means a schema a tenant created
    // shadows `public` for its own session only, which is harmless, while an
    // inherited one is not.
    `ALTER ROLE ${role} SET search_path = 'public'`,
  ];
}

/**
 * The statements that have to run **connected to the tenant's own database**.
 *
 * Separate from the ones above, and separate because running them on the wrong
 * connection has already happened and did real damage.
 *
 * `GRANT` and `REVOKE` on a schema apply to the database the connection is on.
 * A caller that ran one list on one connection therefore executed
 * `REVOKE ALL ON SCHEMA public FROM PUBLIC` against the **control plane's own
 * database**, taking schema rights away from PUBLIC there, and granted each
 * new tenant's role `USAGE` and `CREATE` on `public` **in the shared
 * database**. Provisioning a tenant gave that tenant privileges inside the
 * control plane: the exact inversion of what the whole design is for.
 *
 * It was invisible in every unit test, because a test over the SQL strings
 * cannot see which connection they would be sent on. It showed up when
 * `DROP ROLE` refused, because the role held grants somewhere nobody had
 * looked.
 *
 * So the two lists are different types of thing and are named differently, and
 * `provisioningConnection` says out loud which database each belongs to.
 */
export function tenantSchemaStatements(plan: TenantDatabasePlan): readonly string[] {
  const role = quoteIdentifier(plan.role);
  return [
    // The schema, not just the database. A role that cannot connect to the
    // database but can reach `public` is a different leak.
    `REVOKE ALL ON SCHEMA public FROM PUBLIC`,
    `GRANT ALL ON SCHEMA public TO ${role}`,
  ];
}

/**
 * Which database each list of statements has to be sent on.
 *
 * Data rather than a comment, so a caller can assert it and a test can check
 * that a caller did.
 */
export const PROVISIONING_CONNECTIONS = {
  provisioningStatements: 'CONTROL_PLANE',
  tenantSchemaStatements: 'TENANT_DATABASE',
  teardownStatements: 'CONTROL_PLANE',
} as const;

export type ProvisioningConnection = (typeof PROVISIONING_CONNECTIONS)[keyof typeof PROVISIONING_CONNECTIONS];

/**
 * Whether a statement is safe to run on the control plane's connection.
 *
 * A schema-scoped `GRANT` or `REVOKE` is not, because it would land on the
 * wrong database and look like it worked. Checked rather than remembered: the
 * remembering is what failed.
 */
export function statementIsControlPlaneSafe(statement: string): { ok: true } | { ok: false; why: string } {
  const text = statement.trim().toUpperCase();
  if (/^(GRANT|REVOKE)\b/.test(text) && /\bON\s+SCHEMA\b/.test(text)) {
    return {
      ok: false,
      why: 'A schema grant applies to the database the connection is on, so this would change the control plane rather than the tenant. It belongs in tenantSchemaStatements, run on the tenant database.',
    };
  }
  if (/^(GRANT|REVOKE)\b/.test(text) && /\bON\s+(ALL\s+TABLES|ALL\s+SEQUENCES|ALL\s+FUNCTIONS)\b/.test(text)) {
    return {
      ok: false,
      why: 'A grant over all tables applies to the current database, so this would change the control plane rather than the tenant.',
    };
  }
  return { ok: true };
}

/**
 * Removing a tenant's database.
 *
 * Separate from the lifecycle on purpose: `lifecycleAction` never returns a
 * deletion, and this is the statement somebody runs after a person decided.
 */
export function teardownStatements(plan: TenantDatabasePlan): readonly string[] {
  const db = quoteIdentifier(plan.database);
  const role = quoteIdentifier(plan.role);
  return [
    `ALTER ROLE ${role} NOLOGIN`,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(plan.database)}`,
    `DROP DATABASE IF EXISTS ${db}`,
    `DROP ROLE IF EXISTS ${role}`,
  ];
}

function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`${name} is not a plain identifier.`);
  return `"${name}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// The connection a runtime is given
// ---------------------------------------------------------------------------

export type ConnectionVerdict = { ok: true } | { ok: false; why: string };

/**
 * Whether the connection string a runtime was handed is its own.
 *
 * Checked at the runtime rather than only where it was built, because a
 * configuration that drifted is the case this catches and a configuration that
 * was built correctly needs no check.
 */
export function connectionIsIsolated(dsn: string, plan: TenantDatabasePlan): ConnectionVerdict {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return { ok: false, why: 'The connection string is not a URL.' };
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) return { ok: false, why: 'The connection string is not a Postgres URL.' };

  const database = url.pathname.replace(/^\//, '');

  // Named before the general mismatch, because it is the one a
  // misconfiguration is most likely to point at: it is the database that
  // already works, and "pointed at xbam rather than its own" tells somebody
  // much less than the reason it matters.
  if (database === 'xbam') {
    return { ok: false, why: SHARED_DATABASE_REFUSAL };
  }
  if (database !== plan.database) {
    return { ok: false, why: `This runtime is pointed at ${database || 'no database'} rather than its own.` };
  }
  if (decodeURIComponent(url.username) !== plan.role) {
    return { ok: false, why: 'This runtime would connect as a role that is not its own.' };
  }
  if (!url.password) return { ok: false, why: 'The connection carries no password.' };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// What the server says
// ---------------------------------------------------------------------------

export interface ObservedRole {
  role: string;
  superuser: boolean;
  createdb: boolean;
  canLogin: boolean;
}

export interface ObservedDatabase {
  database: string;
  owner: string;
  /** Roles the server reports as able to connect, PUBLIC included if it can. */
  connectGrantees: readonly string[];
}

/**
 * Compares what the server reports with what was asked for.
 *
 * A GRANT that was generated is not a GRANT that ran, and a provisioning step
 * that half failed leaves a database whose permissions nobody checked. The
 * same reasoning as the packager running a transform rather than listing files.
 */
export function observedIsolationProblems(
  plan: TenantDatabasePlan,
  role: ObservedRole,
  database: ObservedDatabase,
): readonly string[] {
  const problems: string[] = [];

  if (role.role !== plan.role) problems.push('The server reports a different role than this plan names.');
  if (role.superuser) problems.push('The tenant role is a superuser on the server, whatever the plan said.');
  if (role.createdb) problems.push('The tenant role may create databases on the server.');
  if (!role.canLogin) problems.push('The tenant role cannot log in, so provisioning did not finish.');

  if (database.database !== plan.database) problems.push('The server reports a different database than this plan names.');
  if (database.owner !== plan.role) problems.push('The database is owned by somebody other than its tenant.');

  const grantees = database.connectGrantees.map((g) => g.toLowerCase());
  if (grantees.includes('public')) problems.push('PUBLIC can still connect, so every role on the server reaches this tenant.');
  for (const grantee of grantees) {
    if (grantee !== plan.role.toLowerCase() && grantee !== 'public') {
      problems.push(`${grantee} can connect to this tenant's database and is not its role.`);
    }
  }
  if (!grantees.includes(plan.role.toLowerCase())) {
    problems.push('The tenant role itself cannot connect, so provisioning did not finish.');
  }

  return problems;
}

export const DATABASE_CAVEATS: readonly string[] = [
  'A schema GRANT or REVOKE applies to the database the connection is on. Running the provisioning list on one connection sent REVOKE ALL ON SCHEMA public FROM PUBLIC to the control plane database and granted every new tenant role CREATE there: provisioning a tenant gave it privileges inside the control plane. Found by DROP ROLE refusing, because the role held grants somewhere nobody had looked.',
  SHARED_DATABASE_REFUSAL,
  'A database per tenant is isolation between tenants, not from the server operator. A Postgres superuser reads every database on the server, which is why a tenant\'s own secrets are sealed under its own key rather than left in the clear in its own database.',
  'A statement timeout is not a boundary. It stops one tenant holding a lock for ever; it does not stop one tenant being noisy.',
  'These statements have not been run against a real server from this repository. observedIsolationProblems is what checks a server, and nothing has yet asked one.',
];
