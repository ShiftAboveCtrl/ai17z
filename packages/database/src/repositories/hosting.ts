/**
 * Hosts, tenants, runtimes, the grants that reach them and the backups that
 * outlive them. The rules live in `packages/runtime/src/hostScheduler.ts` and
 * `tenantGateway.ts`; this keeps the rows.
 *
 * Two things here are the security boundary rather than plumbing.
 *
 * `publicKeyJwk` is the whole of what is kept about a host's identity. There
 * is no column for a shared secret anywhere in this file, because a secret
 * deployed to every node is every node once one copy leaks.
 *
 * A grant is stored as a hash and never as a token. `issueGrant` returns the
 * token once; after that the row can only confirm a token somebody presents,
 * which means a leaked copy of this table is not a set of working sessions.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { HostCapacity, HostState, ProviderTier, RuntimeState } from '@xbam/shared/contracts';
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface HostProviderRow {
  id: string;
  label: string;
  tier: ProviderTier;
  notes: string | null;
  createdAt: string;
  retiredAt: string | null;
}

export interface HostNodeRow {
  id: string;
  providerId: string;
  label: string;
  publicKeyJwk: Record<string, unknown>;
  keyThumbprint: string;
  state: HostState;
  capacity: HostCapacity | null;
  region: string | null;
  agentVersion: string | null;
  lastHeartbeatAt: string | null;
  enrolledBy: string | null;
  enrolledAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostedTenantRow {
  id: string;
  accountRef: string;
  label: string | null;
  createdAt: string;
  retiredAt: string | null;
}

export interface HostedRuntimeRow {
  id: string;
  tenantId: string;
  hostId: string | null;
  runtimeClass: string;
  state: RuntimeState;
  version: string;
  region: string | null;
  generation: number;
  keyCustody: 'HOST_SEALED' | 'ATTESTED_RELEASE';
  entitlementRef: string | null;
  entitledUntil: string | null;
  provisionKey: string;
  lastHealthAt: string | null;
  health: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeGrantRow {
  id: string;
  runtimeId: string;
  tenantId: string;
  accountRef: string;
  tokenHash: string;
  scopes: string[];
  singleUse: boolean;
  usedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface RuntimeBackupRow {
  id: string;
  runtimeId: string;
  tenantId: string;
  generation: number;
  location: string;
  sizeBytes: string;
  sha256: string;
  verifiedAt: string | null;
  verifyError: string | null;
  createdAt: string;
}

/** States in which a runtime counts against a host's capacity. */
export const RUNTIME_OCCUPYING_STATES = ['PROVISIONING', 'MIGRATING', 'READY', 'ACTIVE', 'GRACE'] as const;

// ---------------------------------------------------------------------------
// Providers and hosts
// ---------------------------------------------------------------------------

export async function createProvider(input: { label: string; tier: ProviderTier; notes?: string | null }): Promise<HostProviderRow> {
  return mapRow<HostProviderRow>(
    await queryOne(`INSERT INTO host_providers (label, tier, notes) VALUES ($1,$2,$3) RETURNING *`, [
      input.label,
      input.tier,
      input.notes ?? null,
    ]),
  ) as HostProviderRow;
}

/**
 * A host offering its key. Not yet allowed to hold anything.
 *
 * Enrolment is a separate, administrative act. A machine that can register
 * itself into service is a machine anybody can add.
 */
export async function offerHost(input: {
  providerId: string;
  label: string;
  publicKeyJwk: Record<string, unknown>;
  keyThumbprint: string;
  region?: string | null;
  agentVersion?: string | null;
}): Promise<HostNodeRow> {
  const existing = await queryOne(`SELECT * FROM host_nodes WHERE key_thumbprint = $1`, [input.keyThumbprint]);
  // The same key offering itself again is the same host, not a second one.
  if (existing) return mapRow<HostNodeRow>(existing) as HostNodeRow;
  return mapRow<HostNodeRow>(
    await queryOne(
      `INSERT INTO host_nodes (provider_id, label, public_key_jwk, key_thumbprint, region, agent_version)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING *`,
      [input.providerId, input.label, JSON.stringify(input.publicKeyJwk), input.keyThumbprint, input.region ?? null, input.agentVersion ?? null],
    ),
  ) as HostNodeRow;
}

/** An administrator putting a host into service. Refuses a revoked key for ever. */
export async function enrolHost(id: string, enrolledBy: string | null): Promise<HostNodeRow | null> {
  return mapRow<HostNodeRow>(
    await queryOne(
      `UPDATE host_nodes SET state = 'ACTIVE', enrolled_by = $2, enrolled_at = now(), updated_at = now()
         WHERE id = $1 AND state IN ('PENDING_ENROLMENT', 'DRAINING', 'UNREACHABLE')
         RETURNING *`,
      [id, enrolledBy],
    ),
  );
}

/**
 * Refuse a host's key from now on.
 *
 * One way: a host cannot un-revoke itself, and `enrolHost` does not accept
 * REVOKED as a state to leave, so a compromised machine stays out until
 * somebody writes a new row for a new key.
 */
export async function revokeHost(id: string, reason: string): Promise<HostNodeRow | null> {
  return mapRow<HostNodeRow>(
    await queryOne(
      `UPDATE host_nodes SET state = 'REVOKED', revoked_at = now(), revoked_reason = $2, updated_at = now()
         WHERE id = $1 AND state <> 'REVOKED' RETURNING *`,
      [id, reason],
    ),
  );
}

export async function drainHost(id: string): Promise<HostNodeRow | null> {
  return mapRow<HostNodeRow>(
    await queryOne(
      `UPDATE host_nodes SET state = 'DRAINING', updated_at = now()
         WHERE id = $1 AND state = 'ACTIVE' RETURNING *`,
      [id],
    ),
  );
}

/**
 * A heartbeat, carrying what the host measured about itself.
 *
 * Refused for a revoked host: a machine that was taken out of service does
 * not talk its way back in by continuing to report.
 */
export async function heartbeat(input: {
  id: string;
  capacity: HostCapacity;
  agentVersion: string;
}): Promise<HostNodeRow | null> {
  return mapRow<HostNodeRow>(
    await queryOne(
      `UPDATE host_nodes SET
         capacity = $2::jsonb,
         agent_version = $3,
         region = coalesce($2::jsonb->>'region', region),
         last_heartbeat_at = now(),
         state = CASE WHEN state = 'UNREACHABLE' THEN 'ACTIVE' ELSE state END,
         updated_at = now()
       WHERE id = $1 AND state <> 'REVOKED' RETURNING *`,
      [input.id, JSON.stringify(input.capacity), input.agentVersion],
    ),
  );
}

/**
 * One provider, for the tier a host is running under.
 *
 * Read by the host agent as well as the scheduler: the scheduler refusing is
 * the control plane's decision, and the machine declining work it is not
 * qualified for is its own.
 */
export async function getProvider(id: string): Promise<HostProviderRow | null> {
  return mapRow<HostProviderRow>(await queryOne(`SELECT * FROM host_providers WHERE id = $1`, [id]));
}

export async function listProviders(): Promise<HostProviderRow[]> {
  return mapRows<HostProviderRow>(await query(`SELECT * FROM host_providers ORDER BY created_at`));
}

export async function getHost(id: string): Promise<HostNodeRow | null> {
  return mapRow<HostNodeRow>(await queryOne(`SELECT * FROM host_nodes WHERE id = $1`, [id]));
}

export async function listHosts(): Promise<HostNodeRow[]> {
  return mapRows<HostNodeRow>(await query(`SELECT * FROM host_nodes ORDER BY created_at ASC`, []));
}

/** Mark hosts that have stopped reporting, so the scheduler stops choosing them. */
export async function markSilentHosts(staleSeconds: number): Promise<number> {
  const rows = await query(
    `UPDATE host_nodes SET state = 'UNREACHABLE', updated_at = now()
       WHERE state = 'ACTIVE'
         AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - make_interval(secs => $1))
       RETURNING id`,
    [staleSeconds],
  );
  return rows.length;
}

/** What each host is already holding, for the scheduler's sums. */
/**
 * What one runtime of a class reserves.
 *
 * A row rather than a name, because placement needs CPU, memory and disk and
 * the only thing recorded before was the name. Multiplying a count by an
 * assumed class would produce refusals and acceptances nobody could explain.
 */
export interface RuntimeClassRow {
  id: string;
  label: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  browser: boolean;
  maxAgents: number;
  createdAt: string;
  retiredAt: string | null;
}

export async function putRuntimeClass(input: {
  id: string;
  label: string;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  browser: boolean;
  maxAgents: number;
}): Promise<RuntimeClassRow> {
  return mapRow<RuntimeClassRow>(
    await queryOne(
      `INSERT INTO runtime_classes (id, label, cpu_cores, memory_mb, disk_gb, browser, max_agents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label,
         cpu_cores = excluded.cpu_cores,
         memory_mb = excluded.memory_mb,
         disk_gb = excluded.disk_gb,
         browser = excluded.browser,
         max_agents = excluded.max_agents,
         retired_at = NULL
       RETURNING *`,
      [input.id, input.label, input.cpuCores, input.memoryMb, input.diskGb, input.browser, input.maxAgents],
    ),
  ) as RuntimeClassRow;
}

export async function getRuntimeClass(id: string): Promise<RuntimeClassRow | null> {
  return mapRow<RuntimeClassRow>(await queryOne(`SELECT * FROM runtime_classes WHERE id = $1`, [id]));
}

/** Live classes, which are the ones a new runtime may be created under. */
export async function listRuntimeClasses(includeRetired = false): Promise<RuntimeClassRow[]> {
  return mapRows<RuntimeClassRow>(
    await query(
      includeRetired
        ? `SELECT * FROM runtime_classes ORDER BY id`
        : `SELECT * FROM runtime_classes WHERE retired_at IS NULL ORDER BY id`,
    ),
  );
}

/**
 * Retired, never deleted: a runtime created under this class still names it,
 * and "what was this agent given" is a fair question afterwards.
 */
export async function retireRuntimeClass(id: string): Promise<RuntimeClassRow | null> {
  return mapRow<RuntimeClassRow>(
    await queryOne(`UPDATE runtime_classes SET retired_at = now() WHERE id = $1 AND retired_at IS NULL RETURNING *`, [id]),
  );
}

/**
 * What each host has set aside, in the shape the scheduler asks for.
 *
 * Read from the `host_reservations` view, so the sum and the rows cannot
 * disagree. `unmeasured` counts runtimes whose class was never recorded: the
 * scheduler must refuse rather than place against an incomplete sum, because
 * treating those as reserving nothing makes a host look emptier than it is.
 */
export async function reservedByHost(): Promise<
  Map<string, { cpuCores: number; memoryMb: number; diskGb: number; runtimes: number; browserRuntimes: number; unmeasured: number }>
> {
  const rows = mapRows<{
    hostId: string;
    runtimes: number;
    browserRuntimes: number;
    unmeasured: number;
    cpuCores: string;
    memoryMb: number;
    diskGb: number;
  }>(await query(`SELECT * FROM host_reservations`));

  const out = new Map<
    string,
    { cpuCores: number; memoryMb: number; diskGb: number; runtimes: number; browserRuntimes: number; unmeasured: number }
  >();
  for (const r of rows) {
    out.set(r.hostId, {
      // numeric comes back as a string, and Number on a sum of two-decimal
      // reservations is exact well past any plausible host.
      cpuCores: Number(r.cpuCores),
      memoryMb: Number(r.memoryMb),
      diskGb: Number(r.diskGb),
      runtimes: Number(r.runtimes),
      browserRuntimes: Number(r.browserRuntimes),
      unmeasured: Number(r.unmeasured),
    });
  }
  return out;
}

export async function reservationsByHost(): Promise<Map<string, { runtimes: number; browserRuntimes: number }>> {
  const rows = mapRows<{ hostId: string; runtimeClass: string; n: string }>(
    await query(
      `SELECT host_id, runtime_class, count(*)::text AS n FROM hosted_runtimes
         WHERE host_id IS NOT NULL AND state = ANY($1::text[])
         GROUP BY host_id, runtime_class`,
      [[...RUNTIME_OCCUPYING_STATES]],
    ),
  );
  const out = new Map<string, { runtimes: number; browserRuntimes: number }>();
  for (const r of rows) {
    const got = out.get(r.hostId) ?? { runtimes: 0, browserRuntimes: 0 };
    got.runtimes += Number(r.n);
    out.set(r.hostId, got);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tenants and runtimes
// ---------------------------------------------------------------------------

export async function upsertTenant(input: { accountRef: string; label?: string | null }): Promise<HostedTenantRow> {
  return mapRow<HostedTenantRow>(
    await queryOne(
      `INSERT INTO hosted_tenants (account_ref, label) VALUES ($1,$2)
       ON CONFLICT (account_ref) DO UPDATE SET label = coalesce(excluded.label, hosted_tenants.label)
       RETURNING *`,
      [input.accountRef, input.label ?? null],
    ),
  ) as HostedTenantRow;
}

/**
 * Create a runtime, once per request however many times it is asked.
 *
 * `provisionKey` is unique, so a retried payment or a double-clicked button
 * finds the first runtime instead of provisioning a second one somebody then
 * pays for and nobody uses.
 */
export async function provisionRuntime(input: {
  tenantId: string;
  runtimeClass: string;
  version: string;
  region?: string | null;
  entitlementRef?: string | null;
  entitledUntil?: string | null;
  provisionKey: string;
}): Promise<{ row: HostedRuntimeRow; created: boolean }> {
  const existing = await queryOne(`SELECT * FROM hosted_runtimes WHERE provision_key = $1`, [input.provisionKey]);
  if (existing) return { row: mapRow<HostedRuntimeRow>(existing) as HostedRuntimeRow, created: false };
  const row = mapRow<HostedRuntimeRow>(
    await queryOne(
      `INSERT INTO hosted_runtimes (tenant_id, runtime_class, version, region, entitlement_ref, entitled_until, provision_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (provision_key) DO NOTHING
       RETURNING *`,
      [input.tenantId, input.runtimeClass, input.version, input.region ?? null, input.entitlementRef ?? null, input.entitledUntil ?? null, input.provisionKey],
    ),
  );
  if (!row) {
    const theirs = await queryOne(`SELECT * FROM hosted_runtimes WHERE provision_key = $1`, [input.provisionKey]);
    return { row: mapRow<HostedRuntimeRow>(theirs) as HostedRuntimeRow, created: false };
  }
  return { row, created: true };
}

export async function getRuntime(id: string): Promise<HostedRuntimeRow | null> {
  return mapRow<HostedRuntimeRow>(await queryOne(`SELECT * FROM hosted_runtimes WHERE id = $1`, [id]));
}

export async function runtimesOfTenant(tenantId: string): Promise<HostedRuntimeRow[]> {
  return mapRows<HostedRuntimeRow>(
    await query(`SELECT * FROM hosted_runtimes WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]),
  );
}

/** Place a runtime, only if it has nowhere yet. Never silently moves one. */
export async function placeRuntimeOn(runtimeId: string, hostId: string): Promise<HostedRuntimeRow | null> {
  return mapRow<HostedRuntimeRow>(
    await queryOne(
      `UPDATE hosted_runtimes SET host_id = $2, updated_at = now()
         WHERE id = $1 AND host_id IS NULL RETURNING *`,
      [runtimeId, hostId],
    ),
  );
}

export async function transitionRuntime(
  id: string,
  from: RuntimeState | readonly RuntimeState[],
  to: RuntimeState,
  set: Partial<{ health: Record<string, unknown> | null; entitledUntil: string | null; hostId: string | null }> = {},
): Promise<HostedRuntimeRow | null> {
  const froms = Array.isArray(from) ? [...from] : [from];
  return mapRow<HostedRuntimeRow>(
    await queryOne(
      `UPDATE hosted_runtimes SET
         state = $3,
         health = CASE WHEN $4::boolean THEN $5::jsonb ELSE health END,
         last_health_at = CASE WHEN $4::boolean THEN now() ELSE last_health_at END,
         entitled_until = CASE WHEN $6::boolean THEN $7 ELSE entitled_until END,
         host_id = CASE WHEN $8::boolean THEN $9 ELSE host_id END,
         updated_at = now()
       WHERE id = $1 AND state = ANY($2::text[]) RETURNING *`,
      [
        id,
        froms,
        to,
        'health' in set,
        set.health === undefined ? null : JSON.stringify(set.health),
        'entitledUntil' in set,
        set.entitledUntil ?? null,
        'hostId' in set,
        set.hostId ?? null,
      ],
    ),
  );
}

/**
 * Move a lost host's runtimes out of service without reassigning them.
 *
 * Deliberately not a reassignment. Starting the same agent twice is worse than
 * leaving it down: one of them would act on the world believing it is alone.
 * A replacement is a decision with a restore behind it, and `generation` is
 * bumped when that happens so a returning host cannot be mistaken for current.
 */
export async function strandRuntimesOf(hostId: string): Promise<number> {
  const rows = await query(
    `UPDATE hosted_runtimes SET state = 'HOST_UNREACHABLE', updated_at = now()
       WHERE host_id = $1 AND state = ANY($2::text[]) RETURNING id`,
    [hostId, [...RUNTIME_OCCUPYING_STATES]],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export function hashGrantToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a short-lived permission to reach one runtime.
 *
 * The token is returned here and nowhere else: only its hash is stored, so a
 * copy of this table does not become a set of working sessions. The caller is
 * expected to hand it to the owner's browser over TLS and then forget it.
 */
export async function issueGrant(input: {
  runtimeId: string;
  tenantId: string;
  accountRef: string;
  scopes: readonly string[];
  ttlSeconds: number;
  singleUse?: boolean;
}): Promise<{ row: RuntimeGrantRow; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const row = mapRow<RuntimeGrantRow>(
    await queryOne(
      `INSERT INTO runtime_grants (runtime_id, tenant_id, account_ref, token_hash, scopes, single_use, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6, now() + make_interval(secs => $7)) RETURNING *`,
      [input.runtimeId, input.tenantId, input.accountRef, hashGrantToken(token), JSON.stringify([...input.scopes]), input.singleUse ?? false, input.ttlSeconds],
    ),
  ) as RuntimeGrantRow;
  return { row, token };
}

/** Find a live grant by the token somebody presented. Expiry and revocation are in the where. */
export async function liveGrantByToken(token: string): Promise<RuntimeGrantRow | null> {
  return mapRow<RuntimeGrantRow>(
    await queryOne(
      `SELECT * FROM runtime_grants
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
           AND (single_use = false OR used_at IS NULL)`,
      [hashGrantToken(token)],
    ),
  );
}

/** Spend a single-use grant. Returns null if somebody already did. */
export async function consumeGrant(id: string): Promise<RuntimeGrantRow | null> {
  return mapRow<RuntimeGrantRow>(
    await queryOne(
      `UPDATE runtime_grants SET used_at = now()
         WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
      [id],
    ),
  );
}

export async function revokeGrant(id: string): Promise<RuntimeGrantRow | null> {
  return mapRow<RuntimeGrantRow>(
    await queryOne(`UPDATE runtime_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *`, [id]),
  );
}

/** Every grant for a runtime, so an owner can see and end their own sessions. */
export async function grantsOfRuntime(runtimeId: string): Promise<RuntimeGrantRow[]> {
  return mapRows<RuntimeGrantRow>(
    await query(`SELECT * FROM runtime_grants WHERE runtime_id = $1 ORDER BY created_at DESC LIMIT 100`, [runtimeId]),
  );
}

export async function revokeGrantsOfRuntime(runtimeId: string): Promise<number> {
  const rows = await query(
    `UPDATE runtime_grants SET revoked_at = now() WHERE runtime_id = $1 AND revoked_at IS NULL RETURNING id`,
    [runtimeId],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export async function recordBackup(input: {
  runtimeId: string;
  tenantId: string;
  generation: number;
  location: string;
  sizeBytes: number;
  sha256: string;
}): Promise<RuntimeBackupRow> {
  return mapRow<RuntimeBackupRow>(
    await queryOne(
      `INSERT INTO runtime_backups (runtime_id, tenant_id, generation, location, size_bytes, sha256)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.runtimeId, input.tenantId, input.generation, input.location, input.sizeBytes, input.sha256],
    ),
  ) as RuntimeBackupRow;
}

/** Record that a backup was actually read back, or why it could not be. */
export async function markBackupVerified(id: string, error: string | null): Promise<RuntimeBackupRow | null> {
  return mapRow<RuntimeBackupRow>(
    await queryOne(
      // Cast explicitly: Postgres cannot infer a parameter used both as a null
      // test and as a text assignment.
      `UPDATE runtime_backups SET
         verified_at = CASE WHEN $2::text IS NULL THEN now() ELSE verified_at END,
         verify_error = $2::text
       WHERE id = $1 RETURNING *`,
      [id, error],
    ),
  );
}

export async function backupsOfRuntime(runtimeId: string, limit = 20): Promise<RuntimeBackupRow[]> {
  return mapRows<RuntimeBackupRow>(
    await query(`SELECT * FROM runtime_backups WHERE runtime_id = $1 ORDER BY created_at DESC LIMIT $2`, [runtimeId, limit]),
  );
}

/** The newest backup that somebody has actually verified can be read. */
export async function newestVerifiedBackup(runtimeId: string): Promise<RuntimeBackupRow | null> {
  return mapRow<RuntimeBackupRow>(
    await queryOne(
      `SELECT * FROM runtime_backups WHERE runtime_id = $1 AND verified_at IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      [runtimeId],
    ),
  );
}
