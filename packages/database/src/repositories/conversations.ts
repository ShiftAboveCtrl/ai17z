import type { ChannelId, ContextMessage } from '@xbam/shared/contracts';
import { query, queryOne, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface ConversationRecord {
  id: string;
  agentId: string;
  accountId: string | null;
  channel: ChannelId;
  remoteConversationId: string;
  remoteUserId: string | null;
  remoteHandle: string | null;
  startedAt: string;
  lastActivityAt: string;
}

export async function upsertConversation(
  tx: Tx,
  input: {
    agentId: string;
    accountId: string | null;
    channel: ChannelId;
    remoteConversationId: string;
    remoteUserId?: string | null;
    remoteHandle?: string | null;
  },
): Promise<ConversationRecord> {
  const row = await tx.one(
    `INSERT INTO conversations (agent_id, account_id, channel, remote_conversation_id, remote_user_id, remote_handle)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (agent_id, channel, remote_conversation_id) DO UPDATE
       SET last_activity_at = now(),
           remote_handle = coalesce(excluded.remote_handle, conversations.remote_handle),
           remote_user_id = coalesce(excluded.remote_user_id, conversations.remote_user_id)
     RETURNING *`,
    [
      input.agentId,
      input.accountId,
      input.channel,
      input.remoteConversationId,
      input.remoteUserId ?? null,
      input.remoteHandle ?? null,
    ],
  );
  return mapRow<ConversationRecord>(row) as ConversationRecord;
}

export async function getConversation(id: string): Promise<ConversationRecord | null> {
  return mapRow<ConversationRecord>(await queryOne('SELECT * FROM conversations WHERE id = $1', [id]));
}

export async function recordMessage(
  tx: Tx,
  input: {
    conversationId: string;
    direction: 'INBOUND' | 'OUTBOUND';
    remoteMessageId?: string | null;
    parentRemoteMessageId?: string | null;
    authorRemoteId?: string | null;
    authorHandle?: string | null;
    body: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO messages (conversation_id, direction, remote_message_id, parent_remote_message_id,
       author_remote_id, author_handle, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (conversation_id, remote_message_id) WHERE remote_message_id IS NOT NULL DO NOTHING`,
    [
      input.conversationId,
      input.direction,
      input.remoteMessageId ?? null,
      input.parentRemoteMessageId ?? null,
      input.authorRemoteId ?? null,
      input.authorHandle ?? null,
      input.body,
    ],
  );
}

export async function recentMessages(conversationId: string, limit = 20): Promise<ContextMessage[]> {
  const rows = await query(
    `SELECT direction AS role, remote_message_id, author_handle, body AS text, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return mapRows<ContextMessage>(rows).reverse();
}

export async function listConversations(agentId: string, limit = 50): Promise<ConversationRecord[]> {
  return mapRows<ConversationRecord>(
    await query('SELECT * FROM conversations WHERE agent_id = $1 ORDER BY last_activity_at DESC LIMIT $2', [
      agentId,
      limit,
    ]),
  );
}
