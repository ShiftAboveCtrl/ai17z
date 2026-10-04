import { describe, expect, it } from 'vitest';
import {
  DATABASE_CAVEATS,
  SHARED_DATABASE_REFUSAL,
  connectionIsIsolated,
  isolationProblems,
  observedIsolationProblems,
  plansCollide,
  provisioningStatements,
  tenantDatabaseName,
  tenantDatabasePlan,
  tenantRoleName,
  teardownStatements,
  type ObservedDatabase,
  type ObservedRole,
} from '@xbam/runtime';

/**
 * One tenant, one database, one role.
 *
 * The cases worth pinning are the ones that fail silently: two long runtime
 * ids truncated into one identifier, PUBLIC left able to connect, a runtime
 * handed the shared development database, and a set of grants that was
 * generated and never ran.
 */

describe('names', () => {
  it('derives the same name every time for one runtime', () => {
    expect(tenantDatabaseName('rt-alpha')).toBe(tenantDatabaseName('rt-alpha'));
  });

  it('gives different runtimes different names', () => {
    expect(tenantDatabaseName('rt-alpha')).not.toBe(tenantDatabaseName('rt-beta'));
    expect(tenantRoleName('rt-alpha')).not.toBe(tenantRoleName('rt-beta'));
  });

  it('stays inside what Postgres keeps', () => {
    // Postgres truncates at 63 bytes, and truncating is exactly how two long
    // ids become one name.
    const long = 'runtime-' + 'x'.repeat(400);
    expect(tenantDatabaseName(long).length).toBeLessThanOrEqual(63);
    expect(tenantRoleName(long).length).toBeLessThanOrEqual(63);
  });

  it('does not collide for two long ids that share a prefix', () => {
    const a = 'runtime-' + 'x'.repeat(200) + '-alpha';
    const b = 'runtime-' + 'x'.repeat(200) + '-beta';
    expect(tenantDatabaseName(a)).not.toBe(tenantDatabaseName(b));
  });

  it('produces a plain identifier whatever the id looked like', () => {
    for (const id of ['RT Alpha!', 'rt.alpha', 'rt/alpha', '  rt-alpha  ']) {
      expect(tenantDatabaseName(id), id).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it('refuses an id that reduces to nothing', () => {
    expect(() => tenantDatabaseName('!!!')).toThrow();
  });

  it('keeps the database and the role apart', () => {
    const plan = tenantDatabasePlan('rt-alpha');
    expect(plan.database).not.toBe(plan.role);
  });
});

describe('the plan', () => {
  it('has no problems as built', () => {
    expect(isolationProblems(tenantDatabasePlan('rt-alpha'))).toEqual([]);
  });

  it('refuses a name somebody supplied rather than derived', () => {
    const plan = { ...tenantDatabasePlan('rt-alpha'), database: 'ai17z_t_somebody_else' };
    expect(isolationProblems(plan).join(' ')).toContain('not derived from the runtime id');
  });

  it('refuses a superuser or a role that may create databases', () => {
    const base = tenantDatabasePlan('rt-alpha');
    expect(isolationProblems({ ...base, superuser: true as unknown as false }).join(' ')).toContain('superuser');
    expect(isolationProblems({ ...base, mayCreateDatabase: true as unknown as false }).join(' ')).toContain('create databases');
  });

  it('refuses PUBLIC being able to connect', () => {
    const plan = { ...tenantDatabasePlan('rt-alpha'), publicMayConnect: true as unknown as false };
    expect(isolationProblems(plan).join(' ')).toContain('any role on the server');
  });

  it('notices two plans that would land in the same place', () => {
    const a = tenantDatabasePlan('rt-alpha');
    expect(plansCollide(a, tenantDatabasePlan('rt-beta'))).toBe(false);
    expect(plansCollide(a, { ...tenantDatabasePlan('rt-beta'), database: a.database })).toBe(true);
    expect(plansCollide(a, { ...tenantDatabasePlan('rt-beta'), role: a.role })).toBe(true);
  });
});

describe('the statements', () => {
  const plan = tenantDatabasePlan('rt-alpha');
  const sql = provisioningStatements(plan, 'a-sealed-secret');

  it('revokes from PUBLIC before granting to the tenant', () => {
    // The other way round leaves a window in which the database exists and
    // every role on the server can reach it.
    const revoke = sql.findIndex((s) => s.includes('REVOKE CONNECT'));
    const grant = sql.findIndex((s) => s.includes('GRANT CONNECT'));
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(revoke);
  });

  it('creates the role unable to log in and enables it last', () => {
    // A half-provisioned tenant is not a reachable one.
    expect(sql[0]).toContain('NOLOGIN');
    const login = sql.findIndex((s) => s.includes('LOGIN PASSWORD'));
    expect(login).toBeGreaterThan(sql.findIndex((s) => s.includes('CREATE DATABASE')));
  });

  it('creates the role without any of the privileges that reach other tenants', () => {
    for (const forbidden of ['NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION', 'NOBYPASSRLS']) {
      expect(sql[0], forbidden).toContain(forbidden);
    }
  });

  it('revokes the public schema as well as the database', () => {
    expect(sql.some((s) => s.includes('REVOKE ALL ON SCHEMA public FROM PUBLIC'))).toBe(true);
  });

  it('bounds a statement and an idle transaction', () => {
    expect(sql.some((s) => s.includes('statement_timeout'))).toBe(true);
    expect(sql.some((s) => s.includes('idle_in_transaction_session_timeout'))).toBe(true);
  });

  it('quotes a password containing a quote', () => {
    const out = provisioningStatements(plan, "it's a secret");
    expect(out.some((s) => s.includes("'it''s a secret'"))).toBe(true);
  });

  it('refuses to provision without a password', () => {
    expect(() => provisioningStatements(plan, '')).toThrow(/never created without a password/);
  });

  it('refuses to provision an unsound plan at all', () => {
    const bad = { ...plan, superuser: true as unknown as false };
    expect(() => provisioningStatements(bad, 'x')).toThrow(/Refusing to provision/);
  });

  it('terminates connections before dropping, and drops the role last', () => {
    const down = teardownStatements(plan);
    const terminate = down.findIndex((s) => s.includes('pg_terminate_backend'));
    const dropDb = down.findIndex((s) => s.includes('DROP DATABASE'));
    const dropRole = down.findIndex((s) => s.includes('DROP ROLE'));
    expect(terminate).toBeLessThan(dropDb);
    expect(dropDb).toBeLessThan(dropRole);
  });
});

describe('the connection a runtime is handed', () => {
  const plan = tenantDatabasePlan('rt-alpha');
  const good = `postgres://${plan.role}:secret@127.0.0.1:5432/${plan.database}`;

  it('accepts its own', () => {
    expect(connectionIsIsolated(good, plan)).toEqual({ ok: true });
  });

  it('refuses the shared development database by name', () => {
    // The one a misconfiguration is most likely to point at, because it is the
    // one that already works.
    const out = connectionIsIsolated(`postgres://${plan.role}:secret@127.0.0.1:5432/xbam`, plan);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toBe(SHARED_DATABASE_REFUSAL);
  });

  it("refuses another tenant's database", () => {
    const other = tenantDatabasePlan('rt-beta');
    const out = connectionIsIsolated(`postgres://${plan.role}:secret@h:5432/${other.database}`, plan);
    expect(out.ok).toBe(false);
  });

  it('refuses connecting as a role that is not its own', () => {
    const out = connectionIsIsolated(`postgres://postgres:secret@h:5432/${plan.database}`, plan);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('not its own');
  });

  it('refuses a connection with no password', () => {
    expect(connectionIsIsolated(`postgres://${plan.role}@h:5432/${plan.database}`, plan).ok).toBe(false);
  });

  it('refuses something that is not a Postgres URL', () => {
    for (const bad of ['', 'not a url', 'mysql://x:y@h/z', 'https://example.com/db']) {
      expect(connectionIsIsolated(bad, plan).ok, bad).toBe(false);
    }
  });
});

describe('what the server actually reports', () => {
  const plan = tenantDatabasePlan('rt-alpha');
  const role = (over: Partial<ObservedRole> = {}): ObservedRole => ({
    role: plan.role,
    superuser: false,
    createdb: false,
    canLogin: true,
    ...over,
  });
  const database = (over: Partial<ObservedDatabase> = {}): ObservedDatabase => ({
    database: plan.database,
    owner: plan.role,
    connectGrantees: [plan.role],
    ...over,
  });

  it('accepts a correctly provisioned tenant', () => {
    expect(observedIsolationProblems(plan, role(), database())).toEqual([]);
  });

  it('refuses a role the server made a superuser whatever the plan said', () => {
    // A GRANT that was generated is not a GRANT that ran.
    expect(observedIsolationProblems(plan, role({ superuser: true }), database()).join(' ')).toContain('superuser on the server');
  });

  it('notices PUBLIC still being able to connect', () => {
    const out = observedIsolationProblems(plan, role(), database({ connectGrantees: [plan.role, 'PUBLIC'] }));
    expect(out.join(' ')).toContain('every role on the server');
  });

  it('names any other role that can connect', () => {
    const out = observedIsolationProblems(plan, role(), database({ connectGrantees: [plan.role, 'ai17z_r_other'] }));
    expect(out.join(' ')).toContain('ai17z_r_other');
  });

  it('notices a database owned by somebody else', () => {
    const out = observedIsolationProblems(plan, role(), database({ owner: 'postgres' }));
    expect(out.join(' ')).toContain('owned by somebody other than its tenant');
  });

  it('reports provisioning that did not finish rather than treating it as safe', () => {
    expect(observedIsolationProblems(plan, role({ canLogin: false }), database()).join(' ')).toContain('did not finish');
    expect(observedIsolationProblems(plan, role(), database({ connectGrantees: [] })).join(' ')).toContain('did not finish');
  });

  it('gives every problem rather than the first', () => {
    const out = observedIsolationProblems(
      plan,
      role({ superuser: true, createdb: true }),
      database({ owner: 'postgres', connectGrantees: ['PUBLIC'] }),
    );
    expect(out.length).toBeGreaterThanOrEqual(4);
  });
});

describe('what this does not claim', () => {
  it('says plainly that an account_id column is not isolation', () => {
    expect(SHARED_DATABASE_REFUSAL.toLowerCase()).toContain('account_id');
    expect(DATABASE_CAVEATS).toContain(SHARED_DATABASE_REFUSAL);
  });

  it('says a database per tenant is not isolation from the server operator', () => {
    expect(DATABASE_CAVEATS.join(' ').toLowerCase()).toContain('not from the server operator');
  });

  it('says these statements have never been run against a real server', () => {
    expect(DATABASE_CAVEATS.join(' ').toLowerCase()).toContain('not been run against a real server');
  });
});
