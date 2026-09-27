import { query, queryOne, withTransaction } from '../pool';

/**
 * The local ledger of Studio purchases this installation's owner was asked to
 * pay for. See migration 0093 for why it exists beside Studio's own record.
 */

export type StudioLedgerState = 'PREPARED' | 'SENT' | 'ABANDONED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';

export interface StudioLedgerRow {
  intentId: string;
  pluginId: string;
  pluginName: string;
  chainId: number;
  tokenAddress: string;
  payerAddress: string;
  recipientAddress: string;
  amountBaseUnits: string;
  state: StudioLedgerState;
  txHash: string | null;
  studioStatus: string | null;
  note: string | null;
  preparedAt: string;
  sentAt: string | null;
  settledAt: string | null;
  updatedAt: string;
}

interface Row extends Record<string, unknown> {
  intent_id: string;
  plugin_id: string;
  plugin_name: string;
  chain_id: number;
  token_address: string;
  payer_address: string;
  recipient_address: string;
  amount_base_units: string;
  state: StudioLedgerState;
  tx_hash: string | null;
  studio_status: string | null;
  note: string | null;
  prepared_at: string;
  sent_at: string | null;
  settled_at: string | null;
  updated_at: string;
}

const COLUMNS = `intent_id, plugin_id, plugin_name, chain_id, token_address, payer_address, recipient_address,
  amount_base_units::text AS amount_base_units, state, tx_hash, studio_status, note,
  prepared_at::text AS prepared_at, sent_at::text AS sent_at, settled_at::text AS settled_at, updated_at::text AS updated_at`;

const toRow = (row: Row): StudioLedgerRow => ({
  intentId: row.intent_id,
  pluginId: row.plugin_id,
  pluginName: row.plugin_name,
  chainId: row.chain_id,
  tokenAddress: row.token_address,
  payerAddress: row.payer_address,
  recipientAddress: row.recipient_address,
  amountBaseUnits: row.amount_base_units,
  state: row.state,
  txHash: row.tx_hash,
  studioStatus: row.studio_status,
  note: row.note,
  preparedAt: row.prepared_at,
  sentAt: row.sent_at,
  settledAt: row.settled_at,
  updatedAt: row.updated_at,
});

export async function getPurchase(intentId: string): Promise<StudioLedgerRow | null> {
  const row = await queryOne<Row>(`SELECT ${COLUMNS} FROM studio_purchase_ledger WHERE intent_id = $1`, [intentId]);
  return row ? toRow(row) : null;
}

export async function listPurchases(limit = 100): Promise<StudioLedgerRow[]> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM studio_purchase_ledger ORDER BY prepared_at DESC LIMIT $1`, [limit]);
  return rows.map(toRow);
}

export interface PrepareTerms {
  intentId: string;
  pluginId: string;
  pluginName: string;
  chainId: number;
  tokenAddress: string;
  payerAddress: string;
  recipientAddress: string;
  amountBaseUnits: string;
}

/**
 * Records that the wallet is about to be asked, once.
 *
 * Under a row lock, so two presses of the button, or two tabs, cannot both
 * be told to go ahead. Only a purchase never prepared, or one the owner said
 * nothing was sent for, may be prepared. Terms that differ from the ones
 * already recorded are refused: Studio changing what it asks for halfway
 * through is not something to follow.
 */
export async function claimPrepare(
  terms: PrepareTerms,
): Promise<{ ok: true; row: StudioLedgerRow } | { ok: false; why: string; row: StudioLedgerRow }> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO studio_purchase_ledger
         (intent_id, plugin_id, plugin_name, chain_id, token_address, payer_address, recipient_address, amount_base_units, state, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, 'ABANDONED', 'recorded before the first request to the wallet')
       ON CONFLICT (intent_id) DO NOTHING`,
      [
        terms.intentId,
        terms.pluginId,
        terms.pluginName,
        terms.chainId,
        terms.tokenAddress,
        terms.payerAddress,
        terms.recipientAddress,
        terms.amountBaseUnits,
      ],
    );
    const locked = await client.query<Row>(`SELECT ${COLUMNS} FROM studio_purchase_ledger WHERE intent_id = $1 FOR UPDATE`, [
      terms.intentId,
    ]);
    const row = toRow(locked.rows[0]!);
    const same =
      row.chainId === terms.chainId &&
      row.tokenAddress === terms.tokenAddress &&
      row.payerAddress === terms.payerAddress &&
      row.recipientAddress === terms.recipientAddress &&
      row.amountBaseUnits === terms.amountBaseUnits;
    if (!same) {
      return { ok: false as const, why: 'Studio now describes this purchase differently from what your wallet was shown, so nothing was prepared.', row };
    }
    if (row.state === 'PREPARED') {
      return {
        ok: false as const,
        why: 'Your wallet was already asked to pay for this. Check its activity: if it sent the payment, add the transaction here; if it did not, say so and try again.',
        row,
      };
    }
    if (row.state !== 'ABANDONED') {
      return { ok: false as const, why: `This purchase is already ${row.state.toLowerCase()} here, so it will not be paid again.`, row };
    }
    const updated = await client.query<Row>(
      `UPDATE studio_purchase_ledger SET state = 'PREPARED', note = NULL, prepared_at = now(), updated_at = now()
        WHERE intent_id = $1 RETURNING ${COLUMNS}`,
      [terms.intentId],
    );
    return { ok: true as const, row: toRow(updated.rows[0]!) };
  });
}

/** The wallet returned a transaction hash. From here the purchase is never prepared again. */
export async function markSent(intentId: string, txHash: string): Promise<{ ok: true; row: StudioLedgerRow } | { ok: false; why: string }> {
  const hash = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, why: 'That is not a transaction hash.' };
  return withTransaction(async (client) => {
    const locked = await client.query<Row>(`SELECT ${COLUMNS} FROM studio_purchase_ledger WHERE intent_id = $1 FOR UPDATE`, [intentId]);
    const row = locked.rows[0] ? toRow(locked.rows[0]) : null;
    if (!row) return { ok: false as const, why: 'This purchase was never prepared here.' };
    if (row.txHash === hash) return { ok: true as const, row };
    if (row.txHash) return { ok: false as const, why: 'A different transaction is already recorded for this purchase.' };
    if (row.state !== 'PREPARED' && row.state !== 'ABANDONED') {
      return { ok: false as const, why: `This purchase is already ${row.state.toLowerCase()} here.` };
    }
    const updated = await client.query<Row>(
      `UPDATE studio_purchase_ledger SET state = 'SENT', tx_hash = $2, sent_at = now(), updated_at = now()
        WHERE intent_id = $1 RETURNING ${COLUMNS}`,
      [intentId, hash],
    );
    return { ok: true as const, row: toRow(updated.rows[0]!) };
  });
}

/** The owner says their wallet sent nothing. Only a person may say this. */
export async function markAbandoned(intentId: string): Promise<{ ok: boolean; why?: string }> {
  const rows = await query<{ intent_id: string }>(
    `UPDATE studio_purchase_ledger SET state = 'ABANDONED', note = 'the owner said nothing was sent', updated_at = now()
      WHERE intent_id = $1 AND state = 'PREPARED' AND tx_hash IS NULL RETURNING intent_id`,
    [intentId],
  );
  return rows.length > 0 ? { ok: true } : { ok: false, why: 'Only a purchase waiting on the wallet, with no transaction recorded, can be marked as not sent.' };
}

/** Records what Studio said about a purchase this installation knows. */
export async function noteStudioStatus(intentId: string, studioStatus: string, note: string | null): Promise<void> {
  const settled: Record<string, StudioLedgerState> = { CONFIRMED: 'CONFIRMED', FAILED: 'FAILED', EXPIRED: 'EXPIRED' };
  const next = settled[studioStatus];
  await query(
    `UPDATE studio_purchase_ledger
        SET studio_status = $2,
            note = COALESCE($3, note),
            state = COALESCE($4, state),
            settled_at = CASE WHEN $4::text IS NOT NULL AND settled_at IS NULL THEN now() ELSE settled_at END,
            updated_at = now()
      WHERE intent_id = $1 AND (studio_status IS DISTINCT FROM $2 OR ($4::text IS NOT NULL AND state <> $4))`,
    [intentId, studioStatus, note, next ?? null],
  );
}
