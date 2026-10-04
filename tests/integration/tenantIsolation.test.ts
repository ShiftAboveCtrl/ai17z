import { describe, expect, it } from 'vitest';
import { hosting } from '@xbam/database';
import { HostCapacity } from '@xbam/shared/contracts';
import {
  ASSIGNMENT_FORBIDDEN_FIELDS,
  HEARTBEAT_STALE_AFTER_SEC,
  assignmentFor,
  authoriseGatewayRequest,
  lifecycleAction,
  mayProvisionAnother,
  placeRuntime,
  tenantDatabaseName,
  tenantRoleName,
  type CapacityEntitlement,
  type HostForScheduling,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Two customers, and every way one of them might reach the other.
 *
 * These are attacks rather than examples: the identifiers are swapped, the
 * tokens are reused after expiry and revocation, a grant for one runtime is
 * presented for another, and a host is asked to accept work after being
 * revoked. All of them have to fail, and the refusals have to be
 * indistinguishable from each other so that probing cannot map the estate.
 */

const capacity = (over: Partial<HostCapacity> = {}): HostCapacity =>
  HostCapacity.parse({
    cpuCores: 16,
    memoryMb: 32_768,
    diskGb: 500,
    runtimeSlots: 8,
    browserSlots: 4,
    gpus: 0,
    region: 'lab',
    runtimeVersions: ['1.0.0-test'],
    ...over,
  });

async function trustedHost(label = 'host') {
  const provider = await hosting.createProvider({ label: `first-party-${uniqueSuffix()}`, tier: 'FIRST_PARTY_TRUSTED' });
  const offered = await hosting.offerHost({
    providerId: provider.id,
    label,
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    keyThumbprint: `thumb-${uniqueSuffix()}`,
    region: 'lab',
    agentVersion: '1.0.0-test',
  });
  const active = await hosting.enrolHost(offered.id, null);
  await hosting.heartbeat({ id: offered.id, capacity: capacity(), agentVersion: '1.0.0-test' });
  return active!;
}

/** A tenant with one runtime, placed and running. */
async function tenantWithRuntime(name: string) {
  const host = await trustedHost(`host-${name}`);
  const tenant = await hosting.upsertTenant({ accountRef: `acct-${name}-${uniqueSuffix()}`, label: name });
  const { row } = await hosting.provisionRuntime({
    tenantId: tenant.id,
    runtimeClass: 'general-1',
    version: '1.0.0-test',
    region: 'lab',
    provisionKey: `prov-${name}-${uniqueSuffix()}`,
  });
  await hosting.placeRuntimeOn(row.id, host.id);
  const ready = await hosting.transitionRuntime(row.id, 'PROVISIONING', 'ACTIVE');
  return { host, tenant, runtime: ready! };
}

const grantFor = (runtimeId: string, tenantId: string, accountRef: string, over: Partial<Parameters<typeof hosting.issueGrant>[0]> = {}) =>
  hosting.issueGrant({ runtimeId, tenantId, accountRef, scopes: ['runtime.api'], ttlSeconds: 300, ...over });

describe('a client never names its own runtime', () => {
  it('refuses a request with no grant at all', async () => {
    const out = await authoriseGatewayRequest({ token: null, scope: 'runtime.api' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toBe('NO_TOKEN');
  }, 60_000);

  it('lets a grant through to exactly the runtime it names', async () => {
    const a = await tenantWithRuntime('alpha');
    const { token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef);
    const out = await authoriseGatewayRequest({ token, scope: 'runtime.api' });
    expect(out.ok, !out.ok ? out.refusal : '').toBe(true);
    expect(out.ok && out.runtime.id).toBe(a.runtime.id);
  }, 60_000);

  it('refuses a grant presented for somebody else runtime', async () => {
    // The attack: hold a valid grant, name a different runtime.
    const a = await tenantWithRuntime('alpha2');
    const b = await tenantWithRuntime('beta2');
    const { token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef);
    const out = await authoriseGatewayRequest({ token, scope: 'runtime.api', claimedRuntimeId: b.runtime.id });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toBe('RUNTIME_MISMATCH');
  }, 60_000);

  it('ignores a claimed runtime that happens to be right, and still uses the grant', async () => {
    const a = await tenantWithRuntime('alpha3');
    const { token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef);
    const out = await authoriseGatewayRequest({ token, scope: 'runtime.api', claimedRuntimeId: a.runtime.id });
    expect(out.ok && out.runtime.id).toBe(a.runtime.id);
  }, 60_000);

  it('gives one indistinguishable answer for expired, revoked, unknown and spent grants', async () => {
    // A caller must not be able to tell these apart, or the error becomes a
    // map of which runtimes and tokens exist.
    const a = await tenantWithRuntime('alpha4');

    const expired = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef, { ttlSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1_200));

    const revoked = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef);
    await hosting.revokeGrant(revoked.row.id);

    const single = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef, { singleUse: true });
    await authoriseGatewayRequest({ token: single.token, scope: 'runtime.api' });

    for (const token of [expired.token, revoked.token, single.token, 'never-existed-at-all']) {
      const out = await authoriseGatewayRequest({ token, scope: 'runtime.api' });
      expect(out.ok).toBe(false);
      expect(!out.ok && out.refusal, token.slice(0, 8)).toBe('NO_SUCH_GRANT');
    }
  }, 90_000);

  it('refuses a scope the grant does not carry', async () => {
    const a = await tenantWithRuntime('alpha5');
    const { token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef, { scopes: ['runtime.api'] });
    // Watching is not controlling, and neither was granted here.
    for (const scope of ['browser.view', 'browser.control', 'runtime.export'] as const) {
      const out = await authoriseGatewayRequest({ token, scope });
      expect(out.ok).toBe(false);
      expect(!out.ok && out.refusal).toBe('SCOPE_NOT_GRANTED');
    }
  }, 60_000);

  it('spends a single-use grant exactly once', async () => {
    const a = await tenantWithRuntime('alpha6');
    const { token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef, { singleUse: true });
    expect((await authoriseGatewayRequest({ token, scope: 'runtime.api' })).ok).toBe(true);
    expect((await authoriseGatewayRequest({ token, scope: 'runtime.api' })).ok).toBe(false);
  }, 60_000);

  it('stores no token, only a hash', async () => {
    // A copy of this table must not be a set of working sessions.
    const a = await tenantWithRuntime('alpha7');
    const { row, token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef);
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
  }, 60_000);
});

describe('a lapsed subscription still lets an owner leave', () => {
  it('refuses ordinary browser work while suspended but allows export', async () => {
    const a = await tenantWithRuntime('alpha8');
    await hosting.transitionRuntime(a.runtime.id, 'ACTIVE', 'SUSPENDED');
    const { token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef, {
      scopes: ['browser.control', 'runtime.export'],
    });

    const blocked = await authoriseGatewayRequest({ token, scope: 'browser.control' });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.refusal).toBe('RUNTIME_SUSPENDED');

    // The whole reason state is kept on a lapse is that it can be taken out.
    const leaving = await authoriseGatewayRequest({ token, scope: 'runtime.export' });
    expect(leaving.ok, !leaving.ok ? leaving.detail : '').toBe(true);
  }, 60_000);

  it('refuses a runtime that is gone or was never reachable', async () => {
    const a = await tenantWithRuntime('alpha9');
    const { token } = await grantFor(a.runtime.id, a.tenant.id, a.tenant.accountRef);
    await hosting.transitionRuntime(a.runtime.id, 'ACTIVE', 'DELETED');
    const out = await authoriseGatewayRequest({ token, scope: 'runtime.api' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toBe('RUNTIME_NOT_REACHABLE');
  }, 60_000);
});

describe('a host is told what it needs and nothing else', () => {
  it('sends no owner identity in an assignment', async () => {
    // A host that never receives a customer list cannot leak one, and an
    // operator reading host logs should not be reading one either.
    const a = await tenantWithRuntime('alpha10');
    const assignment = assignmentFor(a.runtime);
    const text = JSON.stringify(assignment);
    for (const field of ASSIGNMENT_FORBIDDEN_FIELDS) {
      expect(text, field).not.toContain(field);
    }
    expect(text).not.toContain(a.tenant.accountRef);
    // What it does carry is enough to run the thing.
    expect(assignment.runtimeId).toBe(a.runtime.id);
    expect(assignment.runtimeClass).toBe('general-1');
    expect(assignment.generation).toBe(1);
  }, 60_000);
});

describe('a host cannot put itself into service', () => {
  it('starts unenrolled, and is unschedulable until an administrator says so', async () => {
    const provider = await hosting.createProvider({ label: `p-${uniqueSuffix()}`, tier: 'FIRST_PARTY_TRUSTED' });
    const offered = await hosting.offerHost({
      providerId: provider.id,
      label: 'uninvited',
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      keyThumbprint: `thumb-${uniqueSuffix()}`,
    });
    expect(offered.state).toBe('PENDING_ENROLMENT');

    const asHost: HostForScheduling = {
      id: offered.id,
      state: offered.state,
      tier: 'FIRST_PARTY_TRUSTED',
      capacity: capacity(),
      reserved: { cpuCores: 0, memoryMb: 0, diskGb: 0, runtimes: 0, browserRuntimes: 0 },
      heartbeatAgeSec: 1,
    };
    expect(placeRuntime([asHost], {
      runtimeClass: { id: 'general-1', label: 'g', cpuCores: 1, memoryMb: 2048, diskGb: 20, browser: false, maxAgents: 1 },
      runtimeVersion: '1.0.0-test',
    }).placed).toBe(false);
  }, 60_000);

  it('treats the same key offering itself twice as one host', async () => {
    const provider = await hosting.createProvider({ label: `p-${uniqueSuffix()}`, tier: 'FIRST_PARTY_TRUSTED' });
    const thumb = `thumb-${uniqueSuffix()}`;
    const first = await hosting.offerHost({ providerId: provider.id, label: 'a', publicKeyJwk: { k: 1 }, keyThumbprint: thumb });
    const again = await hosting.offerHost({ providerId: provider.id, label: 'b', publicKeyJwk: { k: 2 }, keyThumbprint: thumb });
    expect(again.id).toBe(first.id);
  }, 60_000);

  it('cannot talk its way back in after being revoked', async () => {
    const host = await trustedHost('doomed');
    await hosting.revokeHost(host.id, 'suspected compromise');

    // Neither a heartbeat nor a re-enrolment lifts a revocation.
    expect(await hosting.heartbeat({ id: host.id, capacity: capacity(), agentVersion: '1.0.0-test' })).toBeNull();
    expect(await hosting.enrolHost(host.id, null)).toBeNull();
    expect((await hosting.getHost(host.id))?.state).toBe('REVOKED');
  }, 60_000);

  it('stops being schedulable when it goes quiet, and recovers when it speaks', async () => {
    const host = await trustedHost('quiet');
    const silenced = await hosting.markSilentHosts(0);
    expect(silenced).toBeGreaterThan(0);
    expect((await hosting.getHost(host.id))?.state).toBe('UNREACHABLE');

    const back = await hosting.heartbeat({ id: host.id, capacity: capacity(), agentVersion: '1.0.0-test' });
    expect(back?.state).toBe('ACTIVE');
  }, 60_000);
});

describe('a lost host does not become two running agents', () => {
  it('strands its runtimes rather than reassigning them', async () => {
    // Starting the same agent twice is worse than leaving it down: one of
    // them would act on the world believing it is alone.
    const a = await tenantWithRuntime('alpha11');
    const moved = await hosting.strandRuntimesOf(a.host.id);
    expect(moved).toBe(1);
    const after = await hosting.getRuntime(a.runtime.id);
    expect(after?.state).toBe('HOST_UNREACHABLE');
    // And it was not quietly handed to somebody else.
    expect(after?.hostId).toBe(a.host.id);
  }, 60_000);

  it('never places a runtime that already has a host', async () => {
    const a = await tenantWithRuntime('alpha12');
    const other = await trustedHost('elsewhere');
    expect(await hosting.placeRuntimeOn(a.runtime.id, other.id)).toBeNull();
    expect((await hosting.getRuntime(a.runtime.id))?.hostId).toBe(a.host.id);
  }, 60_000);
});

describe('provisioning once per request', () => {
  it('returns the first runtime when a request is retried', async () => {
    const tenant = await hosting.upsertTenant({ accountRef: `acct-${uniqueSuffix()}` });
    const key = `prov-${uniqueSuffix()}`;
    const first = await hosting.provisionRuntime({ tenantId: tenant.id, runtimeClass: 'general-1', version: '1.0.0-test', provisionKey: key });
    const again = await hosting.provisionRuntime({ tenantId: tenant.id, runtimeClass: 'browser-1', version: '1.0.0-test', provisionKey: key });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    // One payment, one runtime, whatever the retry asked for.
    expect(again.row.runtimeClass).toBe('general-1');
    expect(await hosting.runtimesOfTenant(tenant.id)).toHaveLength(1);
  }, 60_000);
});

describe('a backup is not authority to read it', () => {
  it('records a backup and only trusts one somebody verified', async () => {
    const a = await tenantWithRuntime('alpha13');
    const unverified = await hosting.recordBackup({
      runtimeId: a.runtime.id,
      tenantId: a.tenant.id,
      generation: 1,
      location: 'off-host://bucket/one',
      sizeBytes: 1_024,
      sha256: 'a'.repeat(64),
    });
    // Writing it is not proof it can be read back.
    expect(await hosting.newestVerifiedBackup(a.runtime.id)).toBeNull();

    await hosting.markBackupVerified(unverified.id, null);
    const good = await hosting.newestVerifiedBackup(a.runtime.id);
    expect(good?.id).toBe(unverified.id);

    // And a failure is recorded as a failure rather than silently dropped.
    const broken = await hosting.recordBackup({
      runtimeId: a.runtime.id,
      tenantId: a.tenant.id,
      generation: 1,
      location: 'off-host://bucket/two',
      sizeBytes: 1,
      sha256: 'b'.repeat(64),
    });
    await hosting.markBackupVerified(broken.id, 'checksum did not match');
    const rows = await hosting.backupsOfRuntime(a.runtime.id);
    expect(rows.find((r) => r.id === broken.id)?.verifyError).toBe('checksum did not match');
    expect(rows.find((r) => r.id === broken.id)?.verifiedAt).toBeNull();
  }, 60_000);

  it('keeps one tenant backups out of another reach', async () => {
    const a = await tenantWithRuntime('alpha14');
    const b = await tenantWithRuntime('beta14');
    await hosting.recordBackup({
      runtimeId: a.runtime.id,
      tenantId: a.tenant.id,
      generation: 1,
      location: 'off-host://bucket/a',
      sizeBytes: 10,
      sha256: 'c'.repeat(64),
    });
    // Asking with the other runtime's id finds nothing, which is the whole
    // point: a backup identifier is not a capability.
    expect(await hosting.backupsOfRuntime(b.runtime.id)).toHaveLength(0);
  }, 60_000);
});

describe('the heartbeat bound is the one the rest of AI17Z already uses', () => {
  it('is 90 seconds, matching the browser panel', () => {
    expect(HEARTBEAT_STALE_AFTER_SEC).toBe(90);
  });
});

describe('a tenant database is one tenant', () => {
  it('derives a different database and role for every runtime', async () => {
    // Real uuids rather than fixture ids, because the shape of the input is
    // what the name is derived from and a uuid is the real shape.
    const a = await tenantWithRuntime('dbone');
    const b = await tenantWithRuntime('dbtwo');

    expect(tenantDatabaseName(a.runtime.id)).not.toBe(tenantDatabaseName(b.runtime.id));
    expect(tenantRoleName(a.runtime.id)).not.toBe(tenantRoleName(b.runtime.id));
    for (const name of [tenantDatabaseName(a.runtime.id), tenantRoleName(a.runtime.id)]) {
      // Postgres cuts an identifier at 63 bytes, and truncating is how two
      // long ids become one database.
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it('never names the shared database this installation already uses', async () => {
    const { runtime } = await tenantWithRuntime('dbthree');
    expect(tenantDatabaseName(runtime.id)).not.toBe('xbam');
  });
});

describe('capacity is bounded before a runtime exists', () => {
  const entitlement = (tenantId: string, runtimes: number): CapacityEntitlement => ({
    tenantId,
    runtimeClassId: 'general-1',
    runtimes,
    browser: true,
    coversUntil: new Date(Date.now() + 86_400_000).toISOString(),
    source: 'OPERATOR_GRANT',
  });

  it('counts a suspended runtime against the entitlement it was created under', async () => {
    // It still holds a database, a disk, a key and a backup, so counting only
    // the acting ones would let somebody hold ten suspended agents on an
    // entitlement for one.
    const { tenant, runtime } = await tenantWithRuntime('cap');
    await hosting.transitionRuntime(runtime.id, 'ACTIVE', 'SUSPENDED');

    const runtimes = await hosting.runtimesOfTenant(tenant.id);
    const usage = { runtimes: runtimes.map((r) => ({ runtimeClassId: r.runtimeClass, state: r.state, browser: false })) };

    const out = mayProvisionAnother(entitlement(tenant.id, 1), usage);
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.why).toContain('suspended and retained');

    expect(mayProvisionAnother(entitlement(tenant.id, 2), usage).allowed).toBe(true);
  });
});

describe('a lapse is never a deletion', () => {
  it('returns no deletion for a real runtime whose entitlement has run out', async () => {
    const { runtime } = await tenantWithRuntime('lapse');
    const lapsed = await hosting.transitionRuntime(runtime.id, 'ACTIVE', 'ACTIVE', {
      entitledUntil: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });

    const action = lifecycleAction({
      state: lapsed!.state,
      entitledUntil: lapsed!.entitledUntil,
      since: lapsed!.updatedAt,
    });
    // The furthest it goes is scheduling one, with notice, and that is a
    // separate act somebody takes.
    expect(JSON.stringify(action)).not.toContain('DELETED');
  });
});
