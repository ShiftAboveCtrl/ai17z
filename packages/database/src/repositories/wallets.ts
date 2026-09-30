/**
 * Agent wallets and the transactions an owner asked them to make. The rules
 * live in `packages/runtime/src/walletCore.ts`; this keeps the rows.
 *
 * `sealed_secret` is never selected by anything that returns a row to a
 * caller: `WALLET_COLUMNS` leaves it out, and only `sealedSecretOf` reads it.
 */
import type { WalletFamily, WalletIntentStatus, WalletSimulation } from '@xbam/shared/contracts';
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export const WALLET_FAMILY_VALUES = ['EVM', 'SOLANA'] as const;
export const WALLET_INTENT_KIND_VALUES = ['NATIVE_TRANSFER', 'TOKEN_TRANSFER'] as const;
export const WALLET_INTENT_STATUS_VALUES = [
  'DRAFTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
] as const satisfies readonly WalletIntentStatus[];

const WALLET_COLUMNS = 'id, agent_id, family, address, adapter, created_at, backed_up_at, retired_at';

export interface WalletRow {
  id: string;
  agentId: string;
  family: WalletFamily;
  address: string;
  adapter: string;
  createdAt: string;
  backedUpAt: string | null;
  retiredAt: string | null;
}

export interface WalletIntentRow {
  id: string;
  walletId: string;
  agentId: string;
  ownerId: string | null;
  network: string;
  kind: 'NATIVE_TRANSFER' | 'TOKEN_TRANSFER';
  params: Record<string, unknown>;
  idempotencyKey: string;
  status: WalletIntentStatus;
  simulation: WalletSimulation | null;
  digest: string | null;
  approvedDigest: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export async function createWallet(input: { agentId: string; family: WalletFamily; address: string; sealedSecret: string; adapter: string }): Promise<WalletRow> {
  return mapRow<WalletRow>(
    await queryOne(
      `INSERT INTO agent_wallets (agent_id, family, address, sealed_secret, adapter)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${WALLET_COLUMNS}`,
      [input.agentId, input.family, input.address, input.sealedSecret, input.adapter],
    ),
  )!;
}

export async function liveWallets(agentId: string): Promise<WalletRow[]> {
  return mapRows<WalletRow>(
    await query(`SELECT ${WALLET_COLUMNS} FROM agent_wallets WHERE agent_id = $1 AND retired_at IS NULL ORDER BY family`, [agentId]),
  );
}

export async function getWallet(id: string): Promise<WalletRow | null> {
  return mapRow<WalletRow>(await queryOne(`SELECT ${WALLET_COLUMNS} FROM agent_wallets WHERE id = $1`, [id]));
}

/** The one read of a sealed secret. Opened by the caller, used, and dropped. */
export async function sealedSecretOf(walletId: string): Promise<string | null> {
  const row = await queryOne(`SELECT sealed_secret FROM agent_wallets WHERE id = $1 AND retired_at IS NULL`, [walletId]);
  return (row?.sealed_secret as string | undefined) ?? null;
}

export async function markBackedUp(walletId: string): Promise<void> {
  await query(`UPDATE agent_wallets SET backed_up_at = now() WHERE id = $1`, [walletId]);
}

export async function createIntent(input: {
  walletId: string;
  agentId: string;
  ownerId: string | null;
  network: string;
  kind: 'NATIVE_TRANSFER' | 'TOKEN_TRANSFER';
  params: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ intent: WalletIntentRow; created: boolean }> {
  const inserted = await queryOne(
    `INSERT INTO wallet_intents (wallet_id, agent_id, owner_id, network, kind, params, idempotency_key, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'DRAFTED')
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [input.walletId, input.agentId, input.ownerId, input.network, input.kind, JSON.stringify(input.params), input.idempotencyKey],
  );
  if (inserted) return { intent: mapRow<WalletIntentRow>(inserted)!, created: true };
  const existing = await queryOne(`SELECT * FROM wallet_intents WHERE idempotency_key = $1`, [input.idempotencyKey]);
  return { intent: mapRow<WalletIntentRow>(existing)!, created: false };
}

export async function getIntent(id: string): Promise<WalletIntentRow | null> {
  return mapRow<WalletIntentRow>(await queryOne(`SELECT * FROM wallet_intents WHERE id = $1`, [id]));
}

export async function listIntents(agentId: string, limit = 50): Promise<WalletIntentRow[]> {
  return mapRows<WalletIntentRow>(
    await query(`SELECT * FROM wallet_intents WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`, [agentId, Math.min(200, limit)]),
  );
}

/**
 * Moves an intent on only from the state it is expected to be in.
 *
 * This is what makes submission single-flight: two submits race for
 * APPROVED -> SUBMITTING and exactly one wins. Nothing moves an intent back
 * into a state it could be signed from.
 */
export async function transitionIntent(
  id: string,
  from: WalletIntentStatus | readonly WalletIntentStatus[],
  to: WalletIntentStatus,
  set: Partial<{
    simulation: WalletSimulation | null;
    digest: string | null;
    approvedDigest: string;
    approvedBy: string | null;
    txHash: string;
    error: string | null;
  }> = {},
): Promise<WalletIntentRow | null> {
  const froms = Array.isArray(from) ? [...from] : [from];
  return mapRow<WalletIntentRow>(
    await queryOne(
      `UPDATE wallet_intents SET
         status = $3,
         simulation = CASE WHEN $4::boolean THEN $5::jsonb ELSE simulation END,
         digest = CASE WHEN $6::boolean THEN $7 ELSE digest END,
         approved_digest = coalesce($8, approved_digest),
         approved_by = CASE WHEN $8 IS NOT NULL THEN $9 ELSE approved_by END,
         approved_at = CASE WHEN $8 IS NOT NULL THEN now() ELSE approved_at END,
         tx_hash = coalesce($10, tx_hash),
         error = CASE WHEN $11::boolean THEN $12 ELSE error END,
         submitted_at = CASE WHEN $3 = 'SUBMITTED' THEN now() ELSE submitted_at END,
         updated_at = now()
       WHERE id = $1 AND status = ANY($2::text[])
       RETURNING *`,
      [
        id,
        froms,
        to,
        'simulation' in set,
        set.simulation === undefined ? null : JSON.stringify(set.simulation),
        'digest' in set,
        set.digest ?? null,
        set.approvedDigest ?? null,
        set.approvedBy ?? null,
        set.txHash ?? null,
        'error' in set,
        set.error ?? null,
      ],
    ),
  );
}
