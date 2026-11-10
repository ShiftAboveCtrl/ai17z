import { PipelineError } from '@xbam/shared';
import { query, queryOne } from '../pool';

export async function pollState(accountId: string): Promise<{ cursor: string | null; version: number }> {
  await query('INSERT INTO channel_poll_state (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
  return (await queryOne<{ cursor: string | null; version: number }>(
    'SELECT cursor, version FROM channel_poll_state WHERE account_id = $1', [accountId],
  ))!;
}

export async function advancePoll(accountId: string, version: number, cursor: string): Promise<boolean> {
  const rows = await query(
    `UPDATE channel_poll_state SET cursor = $3, version = version + 1
     WHERE account_id = $1 AND version = $2 RETURNING version`, [accountId, version, cursor],
  );
  return rows.length === 1;
}

export async function outgoingMessage(accountId: string, key: string, digest: string): Promise<Buffer | null> {
  const row = await queryOne<{ request_digest: string; message: Buffer }>(
    'SELECT request_digest, message FROM channel_outgoing_messages WHERE account_id = $1 AND idempotency_key = $2',
    [accountId, key],
  );
  if (row && row.request_digest !== digest) {
    throw PipelineError.permanent('farcaster_idempotency_conflict', 'This action key already belongs to a different message.');
  }
  return row?.message ?? null;
}

export async function prepareOutgoing(accountId: string, key: string, digest: string, message: Uint8Array): Promise<Buffer> {
  await query(
    `INSERT INTO channel_outgoing_messages (account_id, idempotency_key, request_digest, message)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [accountId, key, digest, Buffer.from(message)],
  );
  return (await outgoingMessage(accountId, key, digest))!;
}
