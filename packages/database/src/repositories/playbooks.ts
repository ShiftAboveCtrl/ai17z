import type { TradeMandate } from '@xbam/shared/contracts';
import { query, queryOne, withTransaction, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';
import { putMandate, type TradeMandateRow } from './trading';

/**
 * Which published playbook an agent's paper mandate came from.
 *
 * A pin is written in the same transaction as the mandate it produced and is
 * never edited afterwards. Whether it is still what the agent runs is not
 * stored: it is read by comparing `mandateId` with the agent's current mandate.
 */
export interface PlaybookPinRow {
  id: string;
  agentId: string;
  ownerId: string | null;
  playbookId: string;
  version: number;
  title: string;
  contentSha256: string;
  document: Record<string, unknown>;
  effective: Record<string, unknown>;
  mandateId: string;
  importedAt: string;
  retiredAt: string | null;
}

export interface PinInput {
  playbookId: string;
  version: number;
  title: string;
  contentSha256: string;
  document: Record<string, unknown>;
  effective: Record<string, unknown>;
}

/** What the caller decided, having been shown the state it would change. */
export type PinDecision =
  | { kind: 'REFUSE'; why: string }
  | { kind: 'UNCHANGED'; pin: PlaybookPinRow }
  | { kind: 'APPLY'; mandate: Omit<TradeMandate, 'id' | 'agentId'>; pin: PinInput };

export type PinResult =
  | { kind: 'REFUSED'; why: string }
  | { kind: 'UNCHANGED'; pin: PlaybookPinRow }
  | { kind: 'APPLIED'; pin: PlaybookPinRow; mandate: TradeMandateRow; replaced: PlaybookPinRow | null };

export async function livePin(agentId: string): Promise<PlaybookPinRow | null> {
  return mapRow<PlaybookPinRow>(await queryOne(`SELECT * FROM agent_playbooks WHERE agent_id = $1 AND retired_at IS NULL`, [agentId]));
}

export async function pinHistory(agentId: string, limit = 20): Promise<PlaybookPinRow[]> {
  return mapRows<PlaybookPinRow>(await query(`SELECT * FROM agent_playbooks WHERE agent_id = $1 ORDER BY imported_at DESC LIMIT $2`, [agentId, limit]));
}

/** Imported mandates are never mistaken for owner choices, even after retirement. */
export async function ownerCeiling(agentId: string, tx?: Tx): Promise<TradeMandateRow | null> {
  const sql = `SELECT m.* FROM trade_mandates m WHERE m.agent_id = $1
    AND NOT EXISTS (SELECT 1 FROM agent_playbooks p WHERE p.mandate_id = m.id)
    ORDER BY m.created_at DESC LIMIT 1`;
  return mapRow<TradeMandateRow>(tx ? await tx.one(sql, [agentId]) : await queryOne(sql, [agentId]));
}

/** No history page limit: every digest ever recorded for this version binds. */
export async function versionDigests(playbookId: string, version: number, tx?: Tx): Promise<string[]> {
  const sql = `SELECT DISTINCT content_sha256 FROM agent_playbooks WHERE playbook_id = $1 AND version = $2`;
  const rows = tx ? (await tx.query(sql, [playbookId, version])).rows : await query(sql, [playbookId, version]);
  return rows.map((r) => String(r.content_sha256));
}

/** Materialise one ordinary keyword source per linked playbook, without another timer. */
export async function syncRadarSources(tx?: Tx, agentId?: string): Promise<void> {
  const run = async (sql: string) => tx ? tx.query(sql, [agentId ?? null]) : query(sql, [agentId ?? null]);
  await run(`UPDATE radar_sources s SET enabled = false, status = 'DISABLED', updated_at = now()
    WHERE s.config ? 'playbookAgentId' AND ($1::uuid IS NULL OR s.config->>'playbookAgentId' = $1::text)
      AND NOT EXISTS (
        SELECT 1 FROM agent_playbooks p JOIN trade_mandates m ON m.id = p.mandate_id AND m.retired_at IS NULL
          JOIN agent_accounts aa ON aa.agent_id = p.agent_id AND aa.account_id = s.account_id AND aa.enabled
        WHERE p.retired_at IS NULL AND p.agent_id::text = s.config->>'playbookAgentId')`);
  await run(`INSERT INTO radar_sources (account_id, kind, target, label, enabled, config, next_poll_at)
    SELECT aa.account_id, 'tracked_keyword', 'playbook:' || p.agent_id, 'Playbook: ' || p.title, true,
      jsonb_build_object('playbookAgentId', p.agent_id, 'playbookPinId', p.id, 'mayTrigger', false), now()
    FROM agent_playbooks p JOIN trade_mandates m ON m.id = p.mandate_id AND m.retired_at IS NULL
      JOIN agent_accounts aa ON aa.agent_id = p.agent_id AND aa.enabled
    WHERE p.retired_at IS NULL AND ($1::uuid IS NULL OR p.agent_id = $1)
    ON CONFLICT (account_id, kind, target) DO UPDATE SET
      label = excluded.label, enabled = true, status = 'UNKNOWN', config = excluded.config,
      cursor = NULL, next_poll_at = now(), updated_at = now()
    WHERE radar_sources.config->>'playbookPinId' IS DISTINCT FROM excluded.config->>'playbookPinId'
      OR radar_sources.enabled = false`);
}

/**
 * Decide and write under one lock.
 *
 * The agent row is locked first, so two imports for one agent queue behind each
 * other and each decides against what the other left. The decision is made
 * from the mandate and pin read inside the transaction, never from a copy the
 * caller took earlier: a plan made against a mandate the owner has since
 * edited would otherwise be written over their edit.
 */
export async function applyPin(
  agentId: string,
  ownerId: string,
  decide: (current: TradeMandateRow | null, pinned: PlaybookPinRow | null, owner: TradeMandateRow | null, digests: string[]) => PinDecision,
  version: { playbookId: string; version: number },
): Promise<PinResult> {
  return withTransaction(async (tx) => {
    await tx.one(`SELECT id FROM agents WHERE id = $1 FOR UPDATE`, [agentId]);
    // Different agents importing the same version must agree on its digest too.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`playbook-version:${version.playbookId}:${version.version}`]);
    const current = mapRow<TradeMandateRow>(await tx.one(`SELECT * FROM trade_mandates WHERE agent_id = $1 AND retired_at IS NULL`, [agentId]));
    const pinned = mapRow<PlaybookPinRow>(await tx.one(`SELECT * FROM agent_playbooks WHERE agent_id = $1 AND retired_at IS NULL`, [agentId]));
    const owner = await ownerCeiling(agentId, tx);
    const digests = await versionDigests(version.playbookId, version.version, tx);
    const decision = decide(current, pinned, owner, digests);
    if (decision.kind === 'REFUSE') return { kind: 'REFUSED' as const, why: decision.why };
    if (decision.kind === 'UNCHANGED') return { kind: 'UNCHANGED' as const, pin: decision.pin };

    const mandate = await putMandate({ agentId, ownerId, mandate: decision.mandate, tx });
    if (pinned) await tx.query(`UPDATE agent_playbooks SET retired_at = now() WHERE id = $1`, [pinned.id]);
    const p = decision.pin;
    const pin = mapRow<PlaybookPinRow>(
      await tx.one(
        `INSERT INTO agent_playbooks (agent_id, owner_id, playbook_id, version, title, content_sha256, document, effective, mandate_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING *`,
        [agentId, ownerId, p.playbookId, p.version, p.title, p.contentSha256, JSON.stringify(p.document), JSON.stringify(p.effective), mandate.id],
      ),
    )!;
    await syncRadarSources(tx, agentId);
    return { kind: 'APPLIED' as const, pin, mandate, replaced: pinned };
  });
}
