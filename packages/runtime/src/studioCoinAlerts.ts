import { query, withTransaction, type Tx } from '@xbam/database';
import {
  RADAR_UNIVERSE_CEILING, STUDIO_COIN_ALERTS_MAX_ENTRIES, STUDIO_COIN_ALERTS_MAX_MINTS, STUDIO_COIN_ALERTS_PATH,
  STUDIO_COIN_ALERTS_SNAPSHOT_MS, StudioCoinAlertDocument, type CoinAlertSkip,
} from '@xbam/shared/contracts';
import { ops } from '@xbam/database';
import { isAddress } from '@xbam/upstream';
import { studioInstallationRequest, studioLinkedContext } from './studioLink';
import { playbookUniverse } from './playbookImport';

interface Binding extends Record<string, unknown> {
  agent_id: string; owner_id: string; account_id: string; enabled: boolean;
  installation_id: string; origin: string; linked_at: string;
  mints: string[]; skipped: CoinAlertSkip[]; confirmed_at: string | null; last_error: string | null;
}
type LinkContext = Awaited<ReturnType<typeof studioLinkedContext>>;

const sameLink = (b: Binding, ready: LinkContext) =>
  !('ok' in ready) && b.installation_id === ready.link.installationId && b.origin === ready.where.origin && b.linked_at === ready.link.linkedAt;
const scopeOf = (b: Binding) => ({ installationId: b.installation_id, origin: b.origin, linkedAt: b.linked_at });

/**
 * Only the `mint` of each entry is ever read. The rest of an entry (a wallet, a size, an entry
 * price, a label) is never copied, stored or logged, so nothing but an exact mint can be imported.
 * Reasons are fixed sentences, never the entry's own text.
 */
export function readCoinAlertEntries(entries: readonly unknown[]): { mints: string[]; skipped: CoinAlertSkip[] } {
  const mints: string[] = [];
  const skipped: CoinAlertSkip[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (index >= STUDIO_COIN_ALERTS_MAX_ENTRIES) { if (index === STUDIO_COIN_ALERTS_MAX_ENTRIES) skipped.push({ index, reason: `Only the first ${STUDIO_COIN_ALERTS_MAX_ENTRIES} entries are read.` }); return; }
    const mint = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).mint : undefined;
    if (typeof mint !== 'string') { skipped.push({ index, reason: 'The entry has no mint.' }); return; }
    if (mint.startsWith('0x')) { skipped.push({ index, reason: 'Only exact Solana mints are watched; this is not one.' }); return; }
    if (!isAddress(mint)) { skipped.push({ index, reason: 'The mint is not a valid Solana address.' }); return; }
    if (seen.has(mint)) { skipped.push({ index, reason: 'The mint is already listed.' }); return; }
    seen.add(mint);
    mints.push(mint);
  });
  return { mints, skipped };
}

/** The room left under the shared ceiling once the agent's playbook universe is counted. */
export function coinAlertRoom(playbookCount: number): number {
  return Math.max(0, Math.min(STUDIO_COIN_ALERTS_MAX_MINTS, RADAR_UNIVERSE_CEILING - playbookCount));
}

export async function studioCoinAlertStatus(agentId: string, ownerId: string) {
  const [row] = await query<Binding>('SELECT * FROM studio_coin_alert_bindings WHERE agent_id=$1 AND owner_id=$2', [agentId, ownerId]);
  if (!row) return { binding: null };
  return {
    binding: {
      accountId: row.account_id, enabled: row.enabled, confirmedAt: row.confirmed_at, lastError: row.last_error,
      watching: row.mints.length, skipped: row.skipped,
    },
  };
}

/** Owner control plane only. Linking never creates a source. */
export async function setStudioCoinAlerts(input: { agentId: string; ownerId: string; accountId: string; enabled: boolean }) {
  const [owned] = await query(`SELECT a.id FROM agents a JOIN accounts ac ON ac.id=$3 AND ac.owner_id=a.owner_id
    WHERE a.id=$1 AND a.owner_id=$2 AND (NOT $4 OR EXISTS(SELECT 1 FROM agent_accounts aa WHERE aa.agent_id=a.id AND aa.account_id=ac.id AND aa.enabled))`,
  [input.agentId, input.ownerId, input.accountId, input.enabled]);
  if (!owned) return { ok: false as const, why: 'Choose an account owned by this agent owner with an enabled agent link.' };
  const ready = await studioLinkedContext();
  if (input.enabled && 'ok' in ready) return ready;
  await withTransaction(async tx => {
    // One order for everything that changes this agent's coin alerts: the agent, then its binding,
    // then its radar source (here, in disable and in the sync). Two of them taking the binding and
    // the source in opposite orders waited on each other until Postgres ended one. NO KEY UPDATE
    // on the agent, because the radar poll holding the source records ideas and candidates for the
    // agent (a KEY SHARE on it) and FOR UPDATE made that wait on this.
    await lockAgent(tx, input.agentId);
    if ('ok' in ready) {
      await tx.query('UPDATE studio_coin_alert_bindings SET enabled=false,updated_at=now() WHERE agent_id=$1', [input.agentId]);
    } else {
      // A new account or link starts from an empty list: a list confirmed under another scope is not reused.
      await tx.query(`INSERT INTO studio_coin_alert_bindings(agent_id,owner_id,account_id,enabled,installation_id,origin,linked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(agent_id) DO UPDATE SET
        mints=CASE WHEN studio_coin_alert_bindings.account_id=excluded.account_id AND studio_coin_alert_bindings.installation_id=excluded.installation_id
          AND studio_coin_alert_bindings.linked_at=excluded.linked_at THEN studio_coin_alert_bindings.mints ELSE '[]'::jsonb END,
        account_id=excluded.account_id,enabled=excluded.enabled,installation_id=excluded.installation_id,origin=excluded.origin,
        linked_at=excluded.linked_at,next_sync_at=now(),last_error=NULL,updated_at=now()`,
      [input.agentId, input.ownerId, input.accountId, input.enabled, ready.link.installationId, ready.where.origin, ready.link.linkedAt]);
    }
    await tx.query(`UPDATE radar_sources SET enabled=false,status='DISABLED',updated_at=now() WHERE config->>'coinAlertAgentId'=$1`, [input.agentId]);
  });
  await ops.audit({ actorUserId: input.ownerId, action: 'studio.coin-alerts.changed', entityType: 'agent', entityId: input.agentId, data: { enabled: input.enabled } });
  return { ok: true as const, ...await studioCoinAlertStatus(input.agentId, input.ownerId) };
}

/** First lock of every transaction that changes an agent's coin alerts; see setStudioCoinAlerts. */
async function lockAgent(tx: Tx, agentId: string): Promise<void> {
  await tx.query('SELECT id FROM agents WHERE id=$1 FOR NO KEY UPDATE', [agentId]);
}

async function disable(binding: Binding, reason: string) {
  await withTransaction(async tx => {
    await lockAgent(tx, binding.agent_id);
    await tx.query('UPDATE studio_coin_alert_bindings SET enabled=false,last_error=$2,updated_at=now() WHERE agent_id=$1', [binding.agent_id, reason]);
    await tx.query(`UPDATE radar_sources SET enabled=false,status='DISABLED',idle_reason=$2,updated_at=now() WHERE config->>'coinAlertAgentId'=$1::text`, [binding.agent_id, reason]);
  });
}

/** Called by the radar tick. The persisted claim is the only schedule; there is no timer of its own. */
export async function syncStudioCoinAlerts(): Promise<void> {
  const bindings = await query<Binding>(`UPDATE studio_coin_alert_bindings SET next_sync_at=now()+interval '10 minutes'
    WHERE agent_id IN (SELECT agent_id FROM studio_coin_alert_bindings WHERE enabled AND next_sync_at<=now() ORDER BY next_sync_at LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`);
  for (const binding of bindings) {
    if (!sameLink(binding, await studioLinkedContext())) { await disable(binding, 'The Studio link changed or was revoked. Enable coin alerts again locally.'); continue; }
    const answer = await studioInstallationRequest(STUDIO_COIN_ALERTS_PATH, { method: 'GET' }, scopeOf(binding));
    const parsed = answer.ok && answer.status === 200 ? StudioCoinAlertDocument.safeParse(answer.body) : null;
    const age = parsed?.success ? Date.now() - Date.parse(parsed.data.generated_at) : NaN;
    if (!parsed?.success || !Number.isFinite(age) || age < -30_000 || age > STUDIO_COIN_ALERTS_SNAPSHOT_MS) {
      // Unreachable or unusable: the last confirmed universe stays, and the panel says so.
      const kept = binding.mints.length;
      await query('UPDATE studio_coin_alert_bindings SET last_error=$2,updated_at=now() WHERE agent_id=$1', [binding.agent_id,
        kept ? `Studio coin alerts could not be read, so the last confirmed list (${kept} coins${binding.confirmed_at ? `, confirmed ${new Date(binding.confirmed_at).toISOString()}` : ''}) is still in use.`
          : 'Studio coin alerts could not be read, and no list has been confirmed yet.']);
      continue;
    }
    const read = readCoinAlertEntries(parsed.data.alerts);
    const playbook = await playbookUniverse(binding.agent_id).catch(() => null);
    const room = coinAlertRoom(playbook?.length ?? 0);
    const skipped = [...read.skipped];
    const mints = read.mints.slice(0, room);
    if (read.mints.length > room) skipped.push({ index: -1, reason: `${read.mints.length - room} coins were not added: the universe ceiling of ${RADAR_UNIVERSE_CEILING} (with the playbook) and ${STUDIO_COIN_ALERTS_MAX_MINTS} alerts applies.` });
    if (!sameLink(binding, await studioLinkedContext())) { await disable(binding, 'The Studio link changed during sync.'); continue; }
    await withTransaction(async tx => {
      await lockAgent(tx, binding.agent_id);
      const current = await tx.one<Binding>('SELECT * FROM studio_coin_alert_bindings WHERE agent_id=$1 AND enabled FOR UPDATE', [binding.agent_id]);
      if (!current || current.account_id !== binding.account_id) return;
      const allowed = await tx.one(`SELECT 1 FROM agent_accounts aa JOIN agents a ON a.id=aa.agent_id JOIN accounts ac ON ac.id=aa.account_id AND ac.owner_id=a.owner_id
        WHERE aa.agent_id=$1 AND aa.account_id=$2 AND aa.enabled AND a.owner_id=$3`, [binding.agent_id, binding.account_id, binding.owner_id]);
      await tx.query('UPDATE studio_coin_alert_bindings SET mints=$2::jsonb,skipped=$3::jsonb,confirmed_at=now(),last_error=NULL,updated_at=now() WHERE agent_id=$1', [binding.agent_id, JSON.stringify(mints), JSON.stringify(skipped)]);
      if (!allowed || !mints.length) {
        await tx.query(`UPDATE radar_sources SET enabled=false,status='DISABLED',idle_reason=$2,updated_at=now() WHERE config->>'coinAlertAgentId'=$1::text`, [binding.agent_id, allowed ? 'Studio lists no coins to watch.' : 'The local account link was removed.']);
        return;
      }
      // Reads are by rotation, one coin per poll at the source interval, so a longer list never
      // means more reads per minute. The poll still asks the account's X budget and X_READ_PACING floor.
      const config = { coinAlertAgentId: binding.agent_id, mayTrigger: false, intervalSeconds: 180, priority: 60 };
      await tx.query(`INSERT INTO radar_sources(account_id,kind,target,label,enabled,config,next_poll_at)
        VALUES($1,'tracked_keyword',$2,'Studio coin alerts',true,$3,now()) ON CONFLICT(account_id,kind,target) DO UPDATE
        SET enabled=true,status=CASE WHEN radar_sources.enabled THEN radar_sources.status ELSE 'UNKNOWN' END,config=excluded.config,
          cursor=CASE WHEN radar_sources.enabled THEN radar_sources.cursor ELSE NULL END,
          next_poll_at=CASE WHEN radar_sources.enabled THEN radar_sources.next_poll_at ELSE now() END,updated_at=now()`,
      [binding.account_id, `coin-alerts:${binding.agent_id}`, config]);
    });
  }
}

/**
 * The exact mints the owner chose to watch, or null when the opt-in is off or the link is gone.
 * When Studio is unreachable this is still the last confirmed list, by design.
 */
export async function coinAlertUniverse(agentId: string): Promise<string[] | null> {
  const [row] = await query<Binding>('SELECT * FROM studio_coin_alert_bindings WHERE agent_id=$1 AND enabled', [agentId]);
  if (!row || !row.mints.length) return null;
  return row.mints;
}
