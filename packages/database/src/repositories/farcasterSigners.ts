import { BadRequestError, openSecret, sealSecret } from '@xbam/shared';
import type { Account } from '@xbam/shared/contracts';
import { queryOne, withTransaction } from '../pool';

/** Presence is the only credential information that may leave the server. */
export async function signerPresence(accountId: string): Promise<{ hasSigner: boolean }> {
  const row = await queryOne('SELECT account_id FROM farcaster_signers WHERE account_id = $1', [accountId]);
  return { hasSigner: Boolean(row) };
}

export async function setSigner(accountId: string, signerKey: string): Promise<void> {
  await beginConnection(accountId, signerKey);
}

function sealSigner(signerKey: string): string {
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(signerKey)) {
    throw new BadRequestError('A Farcaster app signer must be a 32-byte Ed25519 private key encoded as hex.');
  }
  return sealSecret(signerKey.replace(/^0x/, '').toLowerCase());
}

/** Each owner retry gets a generation and an immutable signer snapshot. */
export async function beginConnection(accountId: string, signerKey?: string): Promise<{ generation: string; signerKey: string } | null> {
  const sealed = signerKey === undefined ? null : sealSigner(signerKey);
  const row = await withTransaction(async (tx) => {
    const account = await tx.one('SELECT channel FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (account?.channel !== 'farcaster') throw new BadRequestError('This account is not on Farcaster.');
    if (sealed) await tx.query(
      `INSERT INTO farcaster_signers (account_id, sealed_signer_key) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET sealed_signer_key = excluded.sealed_signer_key`, [accountId, sealed]);
    const signer = await tx.one<{ generation: string; sealed_signer_key: string }>(
      `UPDATE farcaster_signers SET generation = gen_random_uuid(), updated_at = now()
       WHERE account_id = $1 RETURNING generation, sealed_signer_key`, [accountId]);
    await tx.query(
      `UPDATE accounts SET status = $2, enabled = false, next_poll_at = NULL, updated_at = now()
       WHERE id = $1`, [accountId, signer ? 'DISCONNECTED' : 'NEEDS_AUTH']);
    return signer;
  });
  return row ? { generation: row.generation, signerKey: openSecret(row.sealed_signer_key) } : null;
}

/** A late validation must never undo a disconnect, replacement or settings edit. */
export async function finishConnection(accountId: string, generation: string, result: {
  status: Account['status']; detail: string; error?: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.one('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    await tx.query(
      `UPDATE accounts SET status = $3, enabled = ($3 = 'CONNECTED'), last_health_status = $4,
        last_error = $5, last_health_check_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'DISCONNECTED'
         AND EXISTS (SELECT 1 FROM farcaster_signers WHERE account_id = $1 AND generation = $2)`,
      [accountId, generation, result.status, result.detail, result.error ?? null]);
  });
}

/** Plaintext exists only for the signing operation, never on an account row. */
export async function getDecryptedSigner(accountId: string): Promise<string | null> {
  const row = await queryOne<{ sealed_signer_key: string }>(
    'SELECT sealed_signer_key FROM farcaster_signers WHERE account_id = $1', [accountId],
  );
  return row ? openSecret(row.sealed_signer_key) : null;
}

export async function clearSigner(accountId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const account = await tx.one('SELECT channel FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (account?.channel !== 'farcaster') throw new BadRequestError('This account is not on Farcaster.');
    await tx.query(`UPDATE accounts SET enabled = false, status = 'DISCONNECTED',
      last_health_status = 'Disconnected by the owner.', last_error = NULL,
      next_poll_at = NULL, last_health_check_at = now(), updated_at = now() WHERE id = $1`, [accountId]);
    await tx.query('DELETE FROM farcaster_signers WHERE account_id = $1', [accountId]);
  });
}

/** Node cursors and pending validation belong to the configuration they started with. */
export async function updateConfiguration(accountId: string, patch: {
  displayName?: string; enabled?: boolean; settings?: Record<string, unknown>;
}): Promise<void> {
  await withTransaction(async (tx) => {
    const account = await tx.one<{ channel: string; settings: Record<string, unknown> }>(
      'SELECT channel, settings FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (account?.channel !== 'farcaster') throw new BadRequestError('This account is not on Farcaster.');
    const changedNode = patch.settings !== undefined && JSON.stringify(patch.settings) !== JSON.stringify(account.settings);
    const invalidate = changedNode || patch.enabled === false;
    await tx.query(`UPDATE accounts SET display_name = coalesce($2, display_name),
      enabled = CASE WHEN $5 THEN false ELSE coalesce($3, enabled) END,
      settings = coalesce($4::jsonb, settings),
      status = CASE WHEN $5 THEN 'DISCONNECTED' ELSE status END,
      next_poll_at = CASE WHEN $5 THEN NULL ELSE next_poll_at END, updated_at = now() WHERE id = $1`,
    [accountId, patch.displayName ?? null, patch.enabled ?? null,
      patch.settings === undefined ? null : JSON.stringify(patch.settings), invalidate]);
    if (invalidate) await tx.query('UPDATE farcaster_signers SET generation = gen_random_uuid() WHERE account_id = $1', [accountId]);
    if (changedNode) await tx.query(`INSERT INTO channel_poll_state (account_id, cursor, version) VALUES ($1, NULL, 1)
      ON CONFLICT (account_id) DO UPDATE SET cursor = NULL, version = channel_poll_state.version + 1`, [accountId]);
  });
}
