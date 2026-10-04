#!/usr/bin/env tsx
/**
 * A hosted AI17Z lab, on one machine, proving two customers cannot reach each
 * other.
 *
 * This is the thing that makes the hosted architecture more than a set of
 * modules: a control plane, a trusted host, two tenants that have nothing to
 * do with each other, and a set of attempts to cross between them that all
 * have to fail. It runs against a real database, because the isolation this
 * proves is enforced by unique indexes and conditional updates and a mock
 * would be testing the mock.
 *
 * What it deliberately does not do: start a microVM, launch Chrome, call a
 * model or touch a chain. Those need a host daemon and adapters that are not
 * built yet, and pretending otherwise by stubbing them would produce a lab
 * that proves the stubs. Every line it prints is something it actually did.
 *
 * Run it with:
 *   npx tsx tools/hosted-lab.mts
 *
 * It creates its own rows, names them so they are obviously synthetic, and
 * removes them at the end unless asked to leave them for inspection.
 */
import { hosting, query } from '@xbam/database';
import { HostCapacity, type ProviderTier } from '@xbam/shared/contracts';
import {
  assignmentFor,
  authoriseGatewayRequest,
  capacityFrom,
  placeRuntime,
  type HostForScheduling,
} from '@xbam/runtime';

const KEEP = process.argv.includes('--keep');
const TAG = `lab-${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function ok(what: string, detail = ''): void {
  passed += 1;
  process.stdout.write(`  ok    ${what}${detail ? ` (${detail})` : ''}\n`);
}

function bad(what: string, detail: string): void {
  failed += 1;
  process.stdout.write(`  FAIL  ${what}\n        ${detail}\n`);
}

/** Assert, and keep going: one failure should not hide the next six. */
function check(what: string, condition: boolean, detail = ''): void {
  if (condition) ok(what, detail);
  else bad(what, detail || 'expected this to hold');
}

function say(heading: string): void {
  process.stdout.write(`\n${heading}\n`);
}

const capacity = (over: Partial<HostCapacity> = {}): HostCapacity =>
  HostCapacity.parse({
    cpuCores: 8,
    memoryMb: 16_384,
    diskGb: 200,
    runtimeSlots: 4,
    browserSlots: 2,
    gpus: 0,
    region: 'lab',
    runtimeVersions: ['lab-1'],
    ...over,
  });

async function enrolledHost(label: string, tier: ProviderTier = 'FIRST_PARTY_TRUSTED') {
  const provider = await hosting.createProvider({ label: `${TAG}-${label}-provider`, tier });
  const offered = await hosting.offerHost({
    providerId: provider.id,
    label: `${TAG}-${label}`,
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: `x-${label}`, y: `y-${label}` },
    keyThumbprint: `${TAG}-${label}-thumb`,
    region: 'lab',
    agentVersion: 'lab-1',
  });
  await hosting.enrolHost(offered.id, null);
  await hosting.heartbeat({ id: offered.id, capacity: capacity(), agentVersion: 'lab-1' });
  return (await hosting.getHost(offered.id))!;
}

async function tenantWithRuntime(name: string, hostId: string, runtimeClass = 'lab-general') {
  const tenant = await hosting.upsertTenant({ accountRef: `${TAG}-${name}`, label: `${TAG} ${name}` });
  const { row } = await hosting.provisionRuntime({
    tenantId: tenant.id,
    runtimeClass,
    version: 'lab-1',
    region: 'lab',
    provisionKey: `${TAG}-${name}-prov`,
  });
  await hosting.placeRuntimeOn(row.id, hostId);
  const active = await hosting.transitionRuntime(row.id, 'PROVISIONING', 'ACTIVE');
  return { tenant, runtime: active! };
}

async function main(): Promise<void> {
  process.stdout.write(`\nAI17Z hosted lab, run ${TAG}\n`);

  // ---- A control plane with one trusted host -----------------------------
  say('A host that had to be let in');
  const host = await enrolledHost('host-a');
  check('a host reaches ACTIVE only after an administrator enrols it', host.state === 'ACTIVE', host.state);

  const uninvited = await hosting.offerHost({
    providerId: (await hosting.createProvider({ label: `${TAG}-walkin`, tier: 'FIRST_PARTY_TRUSTED' })).id,
    label: `${TAG}-walkin`,
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'w', y: 'w' },
    keyThumbprint: `${TAG}-walkin-thumb`,
  });
  check('a host that enrolled nobody stays out', uninvited.state === 'PENDING_ENROLMENT', uninvited.state);

  const measured = capacityFrom({
    totalMemoryMb: 16_384,
    cpuCores: 8,
    freeDiskGb: 200,
    browserPresent: true,
    region: 'lab',
    runtimeVersions: ['lab-1'],
  });
  check('a host measures its own capacity rather than being told', measured.ok,
    measured.ok ? `${measured.capacity.runtimeSlots} slots, ${measured.capacity.browserSlots} with a browser` : measured.why);

  // ---- Two customers who have nothing to do with each other --------------
  say('Two tenants on one host');
  const alpha = await tenantWithRuntime('alpha', host.id);
  const beta = await tenantWithRuntime('beta', host.id);
  check('two tenants hold separate runtimes', alpha.runtime.id !== beta.runtime.id);
  check('neither runtime belongs to the other tenant', alpha.runtime.tenantId !== beta.runtime.tenantId);

  const browserTenant = await tenantWithRuntime('gamma-browser', host.id, 'lab-browser');
  check('a browser-capable tenant is provisioned alongside them', browserTenant.runtime.state === 'ACTIVE');

  // ---- Everything one tenant might try on the other ----------------------
  say('Every way alpha might reach beta');
  const alphaGrant = await hosting.issueGrant({
    runtimeId: alpha.runtime.id,
    tenantId: alpha.tenant.id,
    accountRef: alpha.tenant.accountRef,
    scopes: ['runtime.api', 'browser.view'],
    ttlSeconds: 300,
  });

  const own = await authoriseGatewayRequest({ token: alphaGrant.token, scope: 'runtime.api' });
  check('alpha reaches its own runtime', own.ok && own.runtime.id === alpha.runtime.id);

  const claimed = await authoriseGatewayRequest({
    token: alphaGrant.token,
    scope: 'runtime.api',
    claimedRuntimeId: beta.runtime.id,
  });
  check('alpha naming beta is refused', !claimed.ok, !claimed.ok ? claimed.refusal : 'it was allowed');

  const unscoped = await authoriseGatewayRequest({ token: alphaGrant.token, scope: 'browser.control' });
  check('a scope the grant does not carry is refused', !unscoped.ok, !unscoped.ok ? unscoped.refusal : 'it was allowed');

  const invented = await authoriseGatewayRequest({ token: 'not-a-real-grant', scope: 'runtime.api' });
  check('an invented token is refused', !invented.ok, !invented.ok ? invented.refusal : 'it was allowed');

  const revoked = await hosting.issueGrant({
    runtimeId: beta.runtime.id,
    tenantId: beta.tenant.id,
    accountRef: beta.tenant.accountRef,
    scopes: ['runtime.api'],
    ttlSeconds: 300,
  });
  await hosting.revokeGrant(revoked.row.id);
  const afterRevoke = await authoriseGatewayRequest({ token: revoked.token, scope: 'runtime.api' });
  check('a revoked grant is refused', !afterRevoke.ok, !afterRevoke.ok ? afterRevoke.refusal : 'it was allowed');
  check(
    'a revoked grant is indistinguishable from one that never existed',
    !afterRevoke.ok && !invented.ok && afterRevoke.refusal === invented.refusal,
    !afterRevoke.ok ? afterRevoke.refusal : '',
  );

  // ---- Backups belong to one tenant --------------------------------------
  say('Backups');
  const alphaBackup = await hosting.recordBackup({
    runtimeId: alpha.runtime.id,
    tenantId: alpha.tenant.id,
    generation: alpha.runtime.generation,
    location: `lab://${TAG}/alpha.bin`,
    sizeBytes: 2_048,
    sha256: 'a'.repeat(64),
  });
  check('a fresh backup is not yet trusted', (await hosting.newestVerifiedBackup(alpha.runtime.id)) === null);
  await hosting.markBackupVerified(alphaBackup.id, null);
  check('a verified backup is', (await hosting.newestVerifiedBackup(alpha.runtime.id))?.id === alphaBackup.id);
  check("beta sees none of alpha's backups", (await hosting.backupsOfRuntime(beta.runtime.id)).length === 0);

  // ---- A host is told nothing about whose agent it holds -----------------
  say('What the host is told');
  const assignment = assignmentFor(alpha.runtime);
  const text = JSON.stringify(assignment);
  check('an assignment carries no account reference', !text.includes(alpha.tenant.accountRef));
  check('an assignment carries no label an owner chose', !text.includes('alpha'));
  check('an assignment still says what to run', assignment.runtimeClass === 'lab-general' && assignment.version === 'lab-1');

  // ---- Capacity is refused rather than oversubscribed --------------------
  say('Capacity');
  const reservations = await hosting.reservationsByHost();
  const held = reservations.get(host.id)?.runtimes ?? 0;
  check('the control plane knows what the host is holding', held === 3, `${held} runtimes`);

  const asHost: HostForScheduling = {
    id: host.id,
    state: 'ACTIVE',
    tier: 'FIRST_PARTY_TRUSTED',
    capacity: capacity(),
    reserved: { cpuCores: 0, memoryMb: 15_000, diskGb: 0, runtimes: held, browserRuntimes: 1 },
    heartbeatAgeSec: 1,
  };
  const overfull = placeRuntime([asHost], {
    runtimeClass: { id: 'lab-big', label: 'big', cpuCores: 2, memoryMb: 8_192, diskGb: 20, browser: false, maxAgents: 1 },
    runtimeVersion: 'lab-1',
  });
  check('a host beyond its headroom is refused', !overfull.placed,
    overfull.placed ? 'it was placed anyway' : overfull.refusals.map((r) => r.code).join(','));

  const confidential = await enrolledHost('host-conf', 'CONFIDENTIAL_COMPUTE');
  const ontoUnproven = placeRuntime(
    [{ ...asHost, id: confidential.id, tier: 'CONFIDENTIAL_COMPUTE', reserved: { cpuCores: 0, memoryMb: 0, diskGb: 0, runtimes: 0, browserRuntimes: 0 } }],
    {
      runtimeClass: { id: 'lab-general', label: 'g', cpuCores: 1, memoryMb: 1_024, diskGb: 10, browser: false, maxAgents: 1 },
      runtimeVersion: 'lab-1',
    },
  );
  check('an unproven provider tier holds nothing', !ontoUnproven.placed,
    ontoUnproven.placed ? 'it was placed' : ontoUnproven.refusals.map((r) => r.code).join(','));

  // ---- A host that goes away ---------------------------------------------
  say('A host that stops answering');
  const stranded = await hosting.strandRuntimesOf(host.id);
  check('its runtimes are stranded rather than reassigned', stranded === 3, `${stranded} runtimes`);
  const after = await hosting.getRuntime(alpha.runtime.id);
  check('a stranded runtime keeps its host rather than being handed on', after?.hostId === host.id, after?.state);
  check('and is not reachable', after?.state === 'HOST_UNREACHABLE', after?.state);

  // ---- Tidy up ------------------------------------------------------------
  if (!KEEP) {
    say('Clearing up');
    // Order matters: runtimes reference tenants and hosts with RESTRICT.
    await query(`DELETE FROM runtime_backups WHERE location LIKE $1`, [`lab://${TAG}/%`]);
    await query(`DELETE FROM runtime_grants WHERE account_ref LIKE $1`, [`${TAG}-%`]);
    await query(`DELETE FROM hosted_runtimes WHERE provision_key LIKE $1`, [`${TAG}-%`]);
    await query(`DELETE FROM hosted_tenants WHERE account_ref LIKE $1`, [`${TAG}-%`]);
    await query(`DELETE FROM host_nodes WHERE key_thumbprint LIKE $1`, [`${TAG}-%`]);
    await query(`DELETE FROM host_providers WHERE label LIKE $1`, [`${TAG}-%`]);
    ok('the lab removed its own rows');
  } else {
    say(`Left in place, tagged ${TAG}`);
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`\nThe lab could not run: ${(error as Error).message}\n`);
  process.exit(1);
});
