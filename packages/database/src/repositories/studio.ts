import { query, queryOne, withTransaction } from '../pool';

/**
 * The local ledger of Studio purchases this installation's owner was asked to
 * pay for. See migration 0093 for why it exists beside Studio's own record,
 * and 0094 for why a row is one payment (a leg) of a checkout, not the whole.
 */

export type StudioLedgerState = 'PREPARED' | 'SENT' | 'ABANDONED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';

export interface StudioLedgerRow {
  intentId: string;
  legIndex: number;
  attempt: number;
  role: 'PUBLISHER' | 'TREASURY';
  asset: 'AI17Z' | 'ETH';
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
  billingMode: string | null;
  intentKind: string | null;
  note: string | null;
  preparedAt: string;
  sentAt: string | null;
  settledAt: string | null;
  updatedAt: string;
}

interface Row extends Record<string, unknown> {
  intent_id: string;
  leg_index: number;
  attempt: number;
  role: 'PUBLISHER' | 'TREASURY';
  asset: 'AI17Z' | 'ETH';
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
  billing_mode: string | null;
  intent_kind: string | null;
  note: string | null;
  prepared_at: string;
  sent_at: string | null;
  settled_at: string | null;
  updated_at: string;
}

const COLUMNS = `intent_id, leg_index, attempt, role, asset, plugin_id, plugin_name, chain_id, token_address, payer_address, recipient_address,
  amount_base_units::text AS amount_base_units, state, tx_hash, studio_status, billing_mode, intent_kind, note,
  prepared_at::text AS prepared_at, sent_at::text AS sent_at, settled_at::text AS settled_at, updated_at::text AS updated_at`;

const toRow = (row: Row): StudioLedgerRow => ({
  intentId: row.intent_id,
  legIndex: row.leg_index,
  attempt: row.attempt,
  role: row.role,
  asset: row.asset,
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
  billingMode: row.billing_mode,
  intentKind: row.intent_kind,
  note: row.note,
  preparedAt: row.prepared_at,
  sentAt: row.sent_at,
  settledAt: row.settled_at,
  updatedAt: row.updated_at,
});

/** The latest attempt at one leg. */
export async function getLeg(intentId: string, legIndex = 0): Promise<StudioLedgerRow | null> {
  const row = await queryOne<Row>(
    `SELECT ${COLUMNS} FROM studio_purchase_ledger WHERE intent_id = $1 AND leg_index = $2 ORDER BY attempt DESC LIMIT 1`,
    [intentId, legIndex],
  );
  return row ? toRow(row) : null;
}

/** Whether this installation has any record of a checkout. */
export async function getPurchase(intentId: string): Promise<StudioLedgerRow | null> {
  return getLeg(intentId, 0);
}

/** Every attempt at every leg, newest first. */
export async function listPurchases(limit = 100): Promise<StudioLedgerRow[]> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM studio_purchase_ledger ORDER BY prepared_at DESC, leg_index LIMIT $1`, [limit]);
  return rows.map(toRow);
}

export interface PrepareTerms {
  intentId: string;
  /** The first leg, the publisher, in AI17Z when absent: a checkout from before payment legs. */
  legIndex?: number;
  role?: 'PUBLISHER' | 'TREASURY';
  asset?: 'AI17Z' | 'ETH';
  pluginId: string;
  pluginName: string;
  chainId: number;
  tokenAddress: string;
  payerAddress: string;
  recipientAddress: string;
  amountBaseUnits: string;
  billingMode?: string | null;
  intentKind?: string | null;
  /** True when Studio says the last transaction for this leg was refused on chain, so it is still owed. */
  studioRefusedLast?: boolean;
}

/**
 * Records that the wallet is about to be asked for one leg, once.
 *
 * Under a row lock, so two presses of the button, or two tabs, cannot both
 * be told to go ahead. Only a leg never prepared, one the owner said nothing
 * was sent for, or one whose transaction Studio read off the chain and
 * refused, may be prepared. The last of those starts a new attempt and keeps
 * the refused one as it was. Terms that differ from the ones already recorded
 * are refused: Studio changing what it asks for halfway through is not
 * something to follow.
 */
export async function claimPrepare(
  given: PrepareTerms,
): Promise<{ ok: true; row: StudioLedgerRow } | { ok: false; why: string; row: StudioLedgerRow }> {
  const terms = { ...given, legIndex: given.legIndex ?? 0, role: given.role ?? 'PUBLISHER', asset: given.asset ?? 'AI17Z' };
  return withTransaction(async (client) => {
    // One lock per checkout, so legs of one checkout are prepared one at a time.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('studio_purchase_ledger:' || $1))`, [terms.intentId]);
    const latest = await client.query<Row>(
      `SELECT ${COLUMNS} FROM studio_purchase_ledger WHERE intent_id = $1 AND leg_index = $2 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`,
      [terms.intentId, terms.legIndex],
    );
    let current = latest.rows[0] ? toRow(latest.rows[0]) : null;
    const insert = async (attempt: number, note: string) => {
      const inserted = await client.query<Row>(
        `INSERT INTO studio_purchase_ledger
           (intent_id, leg_index, attempt, role, asset, plugin_id, plugin_name, chain_id, token_address, payer_address,
            recipient_address, amount_base_units, state, note, billing_mode, intent_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, 'ABANDONED', $13, $14, $15)
         RETURNING ${COLUMNS}`,
        [
          terms.intentId,
          terms.legIndex,
          attempt,
          terms.role,
          terms.asset,
          terms.pluginId,
          terms.pluginName,
          terms.chainId,
          terms.tokenAddress,
          terms.payerAddress,
          terms.recipientAddress,
          terms.amountBaseUnits,
          note,
          terms.billingMode ?? null,
          terms.intentKind ?? null,
        ],
      );
      return toRow(inserted.rows[0]!);
    };
    if (!current) current = await insert(1, 'recorded before the first request to the wallet');
    const same =
      current.role === terms.role &&
      current.asset === terms.asset &&
      current.chainId === terms.chainId &&
      current.tokenAddress === terms.tokenAddress &&
      current.payerAddress === terms.payerAddress &&
      current.recipientAddress === terms.recipientAddress &&
      current.amountBaseUnits === terms.amountBaseUnits;
    if (!same) {
      return { ok: false as const, why: 'Studio now describes this payment differently from what your wallet was shown, so nothing was prepared.', row: current };
    }
    if (current.state === 'PREPARED') {
      return {
        ok: false as const,
        why: 'Your wallet was already asked for this payment. Check its activity: if it sent it, add the transaction here; if it did not, say so and try again.',
        row: current,
      };
    }
    if ((current.state === 'SENT' || current.state === 'FAILED') && current.txHash && terms.studioRefusedLast) {
      // The chain refused that transaction, so the leg is still owed. The refused row stays as it was.
      await client.query(
        `UPDATE studio_purchase_ledger SET state = 'FAILED', settled_at = COALESCE(settled_at, now()), updated_at = now()
          WHERE intent_id = $1 AND leg_index = $2 AND attempt = $3`,
        [current.intentId, current.legIndex, current.attempt],
      );
      current = await insert(current.attempt + 1, 'paying again: Studio refused the previous transaction for this payment');
    }
    if (current.state !== 'ABANDONED') {
      return { ok: false as const, why: `This payment is already ${current.state.toLowerCase()} here, so it will not be paid again.`, row: current };
    }
    const updated = await client.query<Row>(
      `UPDATE studio_purchase_ledger SET state = 'PREPARED', note = NULL, prepared_at = now(), updated_at = now()
        WHERE intent_id = $1 AND leg_index = $2 AND attempt = $3 RETURNING ${COLUMNS}`,
      [current.intentId, current.legIndex, current.attempt],
    );
    return { ok: true as const, row: toRow(updated.rows[0]!) };
  });
}

/** The wallet returned a transaction hash for a leg. From here that attempt is never prepared again. */
export async function markSent(intentId: string, txHash: string, legIndex = 0): Promise<{ ok: true; row: StudioLedgerRow } | { ok: false; why: string }> {
  const hash = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, why: 'That is not a transaction hash.' };
  return withTransaction(async (client) => {
    const locked = await client.query<Row>(
      `SELECT ${COLUMNS} FROM studio_purchase_ledger WHERE intent_id = $1 AND leg_index = $2 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`,
      [intentId, legIndex],
    );
    const row = locked.rows[0] ? toRow(locked.rows[0]) : null;
    if (!row) return { ok: false as const, why: 'This payment was never prepared here.' };
    if (row.txHash === hash) return { ok: true as const, row };
    if (row.txHash) return { ok: false as const, why: 'A different transaction is already recorded for this payment.' };
    if (row.state !== 'PREPARED' && row.state !== 'ABANDONED') {
      return { ok: false as const, why: `This payment is already ${row.state.toLowerCase()} here.` };
    }
    const updated = await client.query<Row>(
      `UPDATE studio_purchase_ledger SET state = 'SENT', tx_hash = $3, sent_at = now(), updated_at = now()
        WHERE intent_id = $1 AND leg_index = $2 AND attempt = $4 RETURNING ${COLUMNS}`,
      [intentId, legIndex, hash, row.attempt],
    );
    return { ok: true as const, row: toRow(updated.rows[0]!) };
  });
}

/** The owner says their wallet sent nothing for a leg. Only a person may say this. */
export async function markAbandoned(intentId: string, legIndex = 0): Promise<{ ok: boolean; why?: string }> {
  const rows = await query<{ intent_id: string }>(
    `UPDATE studio_purchase_ledger SET state = 'ABANDONED', note = 'the owner said nothing was sent', updated_at = now()
      WHERE intent_id = $1 AND leg_index = $2 AND state = 'PREPARED' AND tx_hash IS NULL
        AND attempt = (SELECT max(attempt) FROM studio_purchase_ledger WHERE intent_id = $1 AND leg_index = $2)
      RETURNING intent_id`,
    [intentId, legIndex],
  );
  return rows.length > 0 ? { ok: true } : { ok: false, why: 'Only a payment waiting on the wallet, with no transaction recorded, can be marked as not sent.' };
}

/** Records what Studio said about a checkout this installation knows, on every attempt at every leg. */
export async function noteStudioStatus(intentId: string, studioStatus: string, note: string | null): Promise<void> {
  const settled: Record<string, StudioLedgerState> = { CONFIRMED: 'CONFIRMED', FAILED: 'FAILED', EXPIRED: 'EXPIRED' };
  const next = settled[studioStatus];
  await query(
    `UPDATE studio_purchase_ledger
        SET studio_status = $2,
            note = COALESCE($3, note),
            state = CASE WHEN $4::text IS NULL THEN state
                         WHEN $4::text = 'CONFIRMED' AND state NOT IN ('SENT', 'CONFIRMED') THEN state
                         ELSE $4::text END,
            settled_at = CASE WHEN $4::text IS NOT NULL AND settled_at IS NULL THEN now() ELSE settled_at END,
            updated_at = now()
      WHERE intent_id = $1 AND (studio_status IS DISTINCT FROM $2 OR ($4::text IS NOT NULL AND state <> $4))`,
    [intentId, studioStatus, note, next ?? null],
  );
}

/** Records Studio's word on one leg's transaction: final, or refused by the chain. */
export async function noteLegStatus(intentId: string, legIndex: number, txHash: string | null, legStatus: string, reason: string | null): Promise<void> {
  if (!txHash || (legStatus !== 'CONFIRMED' && legStatus !== 'FAILED')) return;
  await query(
    `UPDATE studio_purchase_ledger
        SET state = $4, note = COALESCE($5, note), settled_at = COALESCE(settled_at, now()), updated_at = now()
      WHERE intent_id = $1 AND leg_index = $2 AND tx_hash = $3 AND state = 'SENT'`,
    [intentId, legIndex, txHash.toLowerCase(), legStatus, reason],
  );
}
