import type { ChannelId, NormalizedEvent } from '@xbam/shared/contracts';
import { query, queryOne, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface EventRecord {
  id: string;
  channel: ChannelId;
  accountId: string | null;
  type: string;
  remoteEventId: string;
  remoteMessageId: string | null;
  remoteAuthorId: string | null;
  remoteAuthorHandle: string | null;
  remoteAuthorDisplay: string | null;
  remoteConversationId: string | null;
  parentRemoteMessageId: string | null;
  remoteUrl: string | null;
  text: string;
  payload: Record<string, unknown>;
  occurredAt: string | null;
  ingestedAt: string;
}

const COLUMNS = `
  id, channel, account_id, type, remote_event_id, remote_message_id, remote_author_id,
  remote_author_handle, remote_author_display, remote_conversation_id,
  parent_remote_message_id, remote_url, text, payload, occurred_at, ingested_at`;

export interface IngestResult {
  event: EventRecord;
  /** False when this exact remote event was already recorded. */
  created: boolean;
}

/**
 * Records an inbound event exactly once. Re-ingesting the same remote event is a
 * no-op that returns the original row, which is what makes the whole pipeline
 * safe to re-run.
 */
export async function ingestEvent(
  tx: Tx,
  accountId: string | null,
  event: NormalizedEvent,
): Promise<IngestResult> {
  const params = [
    event.channel,
    accountId,
    event.type,
    event.remoteEventId,
    event.remoteMessageId,
    event.remoteAuthorId,
    event.remoteAuthorHandle,
    event.remoteAuthorDisplayName,
    event.remoteConversationId,
    event.parentRemoteMessageId,
    event.remoteUrl,
    event.text,
    JSON.stringify(event.raw ?? {}),
    event.occurredAt,
  ];
  const inserted = await tx.one(
    `INSERT INTO events (channel, account_id, type, remote_event_id, remote_message_id,
       remote_author_id, remote_author_handle, remote_author_display, remote_conversation_id,
       parent_remote_message_id, remote_url, text, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     ON CONFLICT (channel, coalesce(account_id::text, 'none'), remote_event_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    params,
  );
  if (inserted) return { event: mapRow<EventRecord>(inserted) as EventRecord, created: true };

  const existing = await tx.one(
    `SELECT ${COLUMNS} FROM events
      WHERE channel = $1 AND coalesce(account_id::text, 'none') = coalesce($2::text, 'none') AND remote_event_id = $3`,
    [event.channel, accountId, event.remoteEventId],
  );
  return { event: mapRow<EventRecord>(existing) as EventRecord, created: false };
}

export async function getEvent(id: string): Promise<EventRecord | null> {
  return mapRow<EventRecord>(await queryOne(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [id]));
}

export async function listEvents(options: {
  accountId?: string;
  channel?: ChannelId;
  limit?: number;
  offset?: number;
}): Promise<EventRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.accountId) {
    params.push(options.accountId);
    conditions.push(`account_id = $${params.length}`);
  }
  if (options.channel) {
    params.push(options.channel);
    conditions.push(`channel = $${params.length}`);
  }
  params.push(options.limit ?? 50, options.offset ?? 0);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return mapRows<EventRecord>(
    await query(
      `SELECT ${COLUMNS} FROM events ${where} ORDER BY ingested_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
  );
}

/** Ledger of remote event ids already ingested for an account (scraper dedupe). */
export async function seenRemoteEventIds(accountId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await query<{ remote_event_id: string }>(
    'SELECT remote_event_id FROM events WHERE account_id = $1 AND remote_event_id = ANY($2::text[])',
    [accountId, ids],
  );
  return new Set(rows.map((r) => r.remote_event_id));
}
