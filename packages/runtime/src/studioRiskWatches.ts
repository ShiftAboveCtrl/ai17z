import { ops, query, withTransaction, type RadarSourceRow, type Tx } from '@xbam/database';
import { sha256Hex } from '@xbam/shared';
import { STUDIO_RISK_PATH, STUDIO_RISK_SNAPSHOT_MS, StudioRiskAcknowledgement, StudioRiskObservation, StudioRiskObservationBatch, StudioRiskWatchlist, type SignalObservation, type SignalWatch, type StudioRiskWatch } from '@xbam/shared/contracts';
import { ask, JUPITER_FAMILY, type JupiterQuery, type JupiterResult } from '@xbam/upstream';
import { solanaTokenFrom } from './marketIntelCapabilities';
import { studioInstallationRequest, studioLinkedContext } from './studioLink';

interface Binding extends Record<string, unknown> {
  id: string; agent_id: string; owner_id: string; account_id: string; enabled: boolean; may_trigger: boolean;
  installation_id: string; origin: string; linked_at: string;
}
const sourceScope = `s.config->'studioRisk'->>'bindingId'`;
type LinkContext = Awaited<ReturnType<typeof studioLinkedContext>>;
function sameLink(binding: Binding, ready: LinkContext): boolean {
  return !('ok' in ready) && binding.installation_id === ready.link.installationId && binding.origin === ready.where.origin && binding.linked_at === ready.link.linkedAt;
}
const linkScope = (binding: Binding) => ({ installationId: binding.installation_id, origin: binding.origin, linkedAt: binding.linked_at });

export function studioRiskSignalWatch(watch: StudioRiskWatch): SignalWatch {
  return { chain: 'solana', address: watch.mint, predicate: watch.kind === 'LIQUIDITY_BELOW' ? 'liquidity_below' : 'concentration_above', threshold: watch.threshold, studioMetric: watch.kind };
}

function watchRevision(watch: StudioRiskWatch): string {
  return sha256Hex(JSON.stringify([watch.id, watch.mint, watch.kind, watch.threshold]));
}

/** The exact index fields Studio samples, through the existing machine quota. No X I/O. */
export async function readStudioRiskMetric(watch: SignalWatch): Promise<SignalObservation> {
  const answer = await ask<JupiterQuery, JupiterResult>(JUPITER_FAMILY, { operation: 'search', query: watch.address, list: 'toptrending', interval: '1h', limit: 30 });
  const token = answer.value.tokens.map(solanaTokenFrom).find(t => t?.mint === watch.address);
  let value = watch.studioMetric === 'LIQUIDITY_BELOW' ? token?.liquidityUsd : watch.studioMetric === 'TOP_HOLDERS_ABOVE' ? token?.topHoldersPct : token?.developerHoldsPct;
  if (watch.studioMetric === 'LIQUIDITY_BELOW' && value === 0 && !token?.firstPoolAt) value = null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (watch.studioMetric !== 'LIQUIDITY_BELOW' && value > 100)) value = null;
  const definition = watch.studioMetric === 'LIQUIDITY_BELOW'
    ? 'Index liquidity in USD across the token pools. Zero without a recorded first pool is unavailable. This is not a safety rating.'
    : watch.studioMetric === 'TOP_HOLDERS_ABOVE'
      ? 'Index top-holder share of supply in percent. Pool and exchange accounts may inflate concentration. This is not attributed ownership.'
      : 'Index-attributed developer share of supply in percent. Attribution may be wrong or absent. This is not proof of ownership.';
  // An index value without its own time has unknown age, as in Studio's native sampler.
  return { value: value ?? null, source: 'jupiter', observedAt: token?.updatedAt ?? '', definition };
}

export async function studioRiskWatchStatus(agentId: string, ownerId: string) {
  const [binding] = await query(`SELECT id, account_id AS "accountId", enabled, may_trigger AS "mayTrigger", synced_at AS "syncedAt", expires_at AS "expiresAt", last_error AS "lastError"
    FROM studio_risk_bindings WHERE agent_id=$1 AND owner_id=$2`, [agentId, ownerId]);
  const pending = await query(`SELECT count(*) AS count FROM studio_risk_outbox o JOIN studio_risk_bindings b ON b.id=o.binding_id
    WHERE b.agent_id=$1 AND b.owner_id=$2 AND o.delivered_at IS NULL`, [agentId, ownerId]);
  return { binding: binding ?? null, pendingObservations: Number(pending[0]?.count ?? 0) };
}

/** Local owner control plane only; linking itself never creates a source. */
export async function setStudioRiskWatches(input: { agentId: string; ownerId: string; accountId: string; enabled: boolean; mayTrigger?: boolean }) {
  const [owned] = await query(`SELECT a.id FROM agents a JOIN accounts ac ON ac.id=$3 AND ac.owner_id=a.owner_id
    WHERE a.id=$1 AND a.owner_id=$2 AND (NOT $4 OR EXISTS(SELECT 1 FROM agent_accounts aa WHERE aa.agent_id=a.id AND aa.account_id=ac.id AND aa.enabled))`, [input.agentId, input.ownerId, input.accountId, input.enabled]);
  if (!owned) return { ok: false as const, why: 'Choose an account owned by this agent owner with an enabled agent link.' };
  const ready = await studioLinkedContext();
  if (input.enabled && 'ok' in ready) return ready;
  await withTransaction(async tx => {
    await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [input.agentId]);
    const old = await tx.one<Binding>('SELECT * FROM studio_risk_bindings WHERE agent_id=$1 FOR UPDATE', [input.agentId]);
    if (old) await tx.query(`UPDATE radar_sources s SET enabled=false,status='DISABLED',updated_at=now() WHERE ${sourceScope}=$1`, [old.id]);
    if ('ok' in ready) {
      await tx.query('UPDATE studio_risk_bindings SET enabled=false,updated_at=now() WHERE agent_id=$1', [input.agentId]);
      return;
    }
    const reuse = old?.enabled && old.account_id === input.accountId && sameLink(old, ready);
    await tx.query(`INSERT INTO studio_risk_bindings(agent_id,owner_id,account_id,enabled,may_trigger,installation_id,origin,linked_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(agent_id) DO UPDATE SET
      id=CASE WHEN $9 THEN studio_risk_bindings.id ELSE gen_random_uuid() END,
      account_id=excluded.account_id,enabled=excluded.enabled,may_trigger=excluded.may_trigger,
      installation_id=excluded.installation_id,origin=excluded.origin,linked_at=excluded.linked_at,
      next_sync_at=now(),expires_at=NULL,last_error=NULL,updated_at=now()`,
    [input.agentId, input.ownerId, input.accountId, input.enabled, input.mayTrigger ?? false, ready.link.installationId, ready.where.origin, ready.link.linkedAt, reuse ?? false]);
  });
  await ops.audit({ actorUserId: input.ownerId, action: 'studio.risk-watches.changed', entityType: 'agent', entityId: input.agentId, data: { enabled: input.enabled, mayTrigger: input.mayTrigger ?? false } });
  return { ok: true as const, ...await studioRiskWatchStatus(input.agentId, input.ownerId) };
}

async function suspend(binding: Binding, reason: string, disable = false) {
  await withTransaction(async tx => {
    await tx.query(`UPDATE studio_risk_bindings SET last_error=$2,expires_at=NULL,enabled=enabled AND NOT $3,updated_at=now() WHERE id=$1`, [binding.id, reason, disable]);
    await tx.query(`UPDATE radar_sources s SET enabled=false,status='DISABLED',idle_reason=$2,last_error=$2,updated_at=now() WHERE ${sourceScope}=$1`, [binding.id, reason]);
  });
}

/** Called by the radar tick. The persisted claim is the only sync schedule. */
export async function syncStudioRiskWatches(): Promise<void> {
  const bindings = await query<Binding>(`UPDATE studio_risk_bindings SET next_sync_at=now()+interval '1 minute'
    WHERE agent_id IN (SELECT agent_id FROM studio_risk_bindings WHERE enabled AND next_sync_at<=now() ORDER BY next_sync_at LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`);
  for (const binding of bindings) {
    const ready = await studioLinkedContext();
    if (!sameLink(binding, ready)) { await suspend(binding, 'The Studio link changed or was revoked. Enable risk watches again locally.', true); continue; }
    const answer = await studioInstallationRequest(STUDIO_RISK_PATH, { method: 'GET' }, linkScope(binding));
    if (!answer.ok || answer.status !== 200) { await suspend(binding, 'Studio risk watches are unavailable; no current universe can be confirmed.'); continue; }
    const parsed = StudioRiskWatchlist.safeParse(answer.body);
    const age = parsed.success ? Date.now() - Date.parse(parsed.data.generated_at) : NaN;
    if (!parsed.success || !Number.isFinite(age) || age < -30_000 || age > STUDIO_RISK_SNAPSHOT_MS) {
      await suspend(binding, 'Studio risk watches were malformed or stale; no current universe was applied.'); continue;
    }
    if (!sameLink(binding, await studioLinkedContext())) { await suspend(binding, 'The Studio link changed during sync.', true); continue; }
    const expiresAt = new Date(Date.parse(parsed.data.generated_at) + STUDIO_RISK_SNAPSHOT_MS);
    await withTransaction(async tx => {
      const current = await tx.one<Binding>('SELECT * FROM studio_risk_bindings WHERE id=$1 AND enabled FOR UPDATE', [binding.id]);
      if (!current || current.may_trigger !== binding.may_trigger || String(current.updated_at) !== String(binding.updated_at)) return;
      const allowed = await tx.one(`SELECT a.id FROM agents a JOIN accounts ac ON ac.id=$2 AND ac.owner_id=a.owner_id
        JOIN agent_accounts aa ON aa.agent_id=a.id AND aa.account_id=ac.id AND aa.enabled WHERE a.id=$1 AND a.owner_id=$3`, [binding.agent_id, binding.account_id, binding.owner_id]);
      if (!allowed) {
        await tx.query(`UPDATE radar_sources s SET enabled=false,status='DISABLED',idle_reason='The local account link was removed.' WHERE ${sourceScope}=$1`, [binding.id]);
        return;
      }
      const targets: string[] = [];
      for (const watch of parsed.data.watches) {
        const revision = watchRevision(watch);
        const target = `studio-risk:${binding.id}:${watch.id}:${revision}`;
        targets.push(target);
        const watches = [studioRiskSignalWatch(watch)];
        const config = { intervalSeconds: watch.interval_seconds, limit: 1, mayTrigger: binding.may_trigger, priority: 30, watches, studioRisk: { bindingId: binding.id, agentId: binding.agent_id, watchId: watch.id, watchRevision: revision } };
        const old = await tx.one('SELECT id,enabled,config FROM radar_sources WHERE account_id=$1 AND kind=\'market_signal\' AND target=$2 FOR UPDATE', [binding.account_id, target]);
        if (old && (!old.enabled || JSON.stringify((old.config as RadarSourceRow['config']).watches) !== JSON.stringify(watches))) await tx.query('DELETE FROM signal_baselines WHERE source_id=$1', [old.id]);
        await tx.query(`INSERT INTO radar_sources(account_id,kind,target,label,enabled,config,next_poll_at)
          VALUES($1,'market_signal',$2,'Studio risk watch: ' || $3,true,$4,now()) ON CONFLICT(account_id,kind,target) DO UPDATE
          SET config=excluded.config,enabled=true,status=CASE WHEN radar_sources.enabled THEN radar_sources.status ELSE 'UNKNOWN' END,
            next_poll_at=CASE WHEN radar_sources.enabled THEN radar_sources.next_poll_at ELSE now() END,updated_at=now()
          WHERE radar_sources.config IS DISTINCT FROM excluded.config OR NOT radar_sources.enabled`, [binding.account_id, target, watch.kind, config]);
      }
      await tx.query(`UPDATE radar_sources s SET enabled=false,status='DISABLED',idle_reason='The Studio watch was removed.' WHERE ${sourceScope}=$1 AND NOT(target=ANY($2::text[]))`, [binding.id, targets]);
      await tx.query(`DELETE FROM studio_risk_outbox o USING radar_sources s WHERE o.source_id=s.id AND ${sourceScope}=$1 AND NOT(s.target=ANY($2::text[]))`, [binding.id, targets]);
      await tx.query('UPDATE studio_risk_bindings SET synced_at=now(),expires_at=$2,last_error=NULL WHERE id=$1', [binding.id, expiresAt]);
    });
  }
}

/** A saved snapshot is permission to observe only while that exact local/link scope remains current. */
export async function studioRiskSourceRefusal(source: Pick<RadarSourceRow, 'id' | 'config'>): Promise<string | null> {
  const meta = source.config.studioRisk;
  if (!meta) return null;
  const [binding] = await query<Binding>(`SELECT b.* FROM studio_risk_bindings b JOIN radar_sources s ON s.id=$1 AND ${sourceScope}=b.id::text
    JOIN agents a ON a.id=b.agent_id AND a.owner_id=b.owner_id JOIN accounts ac ON ac.id=b.account_id AND ac.owner_id=b.owner_id
    JOIN agent_accounts aa ON aa.agent_id=b.agent_id AND aa.account_id=b.account_id AND aa.enabled
    WHERE b.id=$2 AND b.enabled AND b.expires_at>now() AND s.enabled AND s.account_id=b.account_id AND b.agent_id=$3`, [source.id, meta.bindingId, meta.agentId]);
  if (!binding) return 'The Studio watch is disabled, removed, stale or no longer linked to this account.';
  if (!sameLink(binding, await studioLinkedContext())) return 'The Studio link changed or was revoked.';
  return null;
}

/** Recheck after I/O, on the same connection that commits the observation. */
export async function studioRiskTransactionValid(tx: Tx, source: RadarSourceRow): Promise<boolean> {
  const meta = source.config.studioRisk;
  if (!meta) return true;
  return !!await tx.one(`SELECT b.id FROM studio_risk_bindings b
    JOIN app_settings l ON l.key='studio.link' AND l.value->>'installationId'=b.installation_id
      AND l.value->>'origin'=b.origin AND l.value->>'linkedAt'=b.linked_at AND l.value->>'revokedAt' IS NULL
    JOIN agents a ON a.id=b.agent_id AND a.owner_id=b.owner_id
    JOIN accounts ac ON ac.id=b.account_id AND ac.owner_id=b.owner_id
    JOIN agent_accounts aa ON aa.agent_id=b.agent_id AND aa.account_id=b.account_id AND aa.enabled
    WHERE b.id=$1 AND b.enabled AND b.expires_at>now() AND b.agent_id=$2 AND b.account_id=$3`, [meta.bindingId, meta.agentId, source.accountId]);
}

/** Explicit projection: no provider text, identity, guidance or local verdict can enter the payload. */
export async function recordStudioRiskObservation(tx: Tx, source: RadarSourceRow, watch: SignalWatch, before: SignalObservation | null, after: SignalObservation): Promise<void> {
  const meta = source.config.studioRisk;
  if (!meta || typeof after.value !== 'number') return;
  const observation = StudioRiskObservation.parse({
    observation_id: sha256Hex(JSON.stringify([meta.watchId, meta.watchRevision, watch.address, 'jupiter', after.observedAt, after.value])),
    watch_id: meta.watchId, watch_revision: meta.watchRevision, mint: watch.address, source: 'jupiter',
    before: before && typeof before.value === 'number' ? { value: before.value, observed_at: before.observedAt } : null,
    after: { value: after.value, observed_at: after.observedAt },
  });
  await tx.query(`INSERT INTO studio_risk_outbox(binding_id,source_id,observation_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [meta.bindingId, source.id, observation.observation_id, observation]);
}

/** Delivery rides the radar tick; at most 50 rows and one bounded batch per binding per pass. */
export async function flushStudioRiskObservations(): Promise<void> {
  await query(`DELETE FROM studio_risk_outbox WHERE created_at<now()-interval '24 hours'`);
  const rows = await query<{ id: string; binding_id: string; source_id: string; payload: unknown }>(`UPDATE studio_risk_outbox SET next_attempt_at=now()+interval '1 minute'
    WHERE id IN (SELECT o.id FROM studio_risk_outbox o JOIN studio_risk_bindings b ON b.id=o.binding_id AND b.enabled
      JOIN radar_sources s ON s.id=o.source_id AND s.enabled
      WHERE o.delivered_at IS NULL AND o.next_attempt_at<=now() AND o.created_at>now()-interval '24 hours'
        AND b.expires_at>now() ORDER BY o.payload->'after'->>'observed_at',o.id LIMIT 50 FOR UPDATE OF o SKIP LOCKED) RETURNING id,binding_id,source_id,payload`);
  for (const bindingId of new Set(rows.map(row => row.binding_id))) {
    const batchRows = rows.filter(row => row.binding_id === bindingId).sort((a, b) => String((a.payload as StudioRiskObservation).after.observed_at).localeCompare((b.payload as StudioRiskObservation).after.observed_at));
    const selected: typeof batchRows = [];
    for (const row of batchRows) {
      const [source] = await query<RadarSourceRow & Record<string, unknown>>(`SELECT id,config FROM radar_sources WHERE id=$1`, [row.source_id]);
      if (source && !await studioRiskSourceRefusal(source)) selected.push(row);
    }
    if (!selected.length) continue;
    const [binding] = await query<Binding>('SELECT * FROM studio_risk_bindings WHERE id=$1 AND enabled', [bindingId]);
    if (!binding) continue;
    const batch = StudioRiskObservationBatch.parse({ protocol: 1, observations: selected.map(row => row.payload) });
    const answer = await studioInstallationRequest(`${STUDIO_RISK_PATH}/observations`, { method: 'POST', json: batch }, linkScope(binding));
    const ack = answer.ok && answer.status === 200 ? StudioRiskAcknowledgement.safeParse(answer.body) : null;
    const valid = ack?.success && ack.data.accepted.every(key => batch.observations.some(o => o.observation_id === key));
    await query(`UPDATE studio_risk_outbox SET delivered_at=CASE WHEN observation_key=ANY($2::text[]) THEN now() ELSE delivered_at END,
      last_error=CASE WHEN observation_key=ANY($2::text[]) THEN NULL ELSE 'Studio did not acknowledge this observation.' END WHERE id=ANY($1::uuid[])`, [selected.map(row => row.id), valid ? ack.data.accepted : []]);
  }
}
