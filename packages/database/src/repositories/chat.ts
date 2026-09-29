/**
 * Owner chat: conversations, who is in them, and what was said.
 *
 * Every read here is scoped by owner, so one owner can never open another's
 * conversation by guessing an id. What a conversation says is history and
 * never memory: nothing here writes to `memories`. A save is recorded in
 * `chat_saves` beside the memory or knowledge source it made.
 */
import { query, queryOne, withTransaction } from '../pool';
import { mapRow, mapRows } from '../mapper';

export const CHAT_KINDS = ['AGENT', 'ROOM'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];
export const CHAT_AUTHOR_KINDS = ['OWNER', 'AGENT', 'NOTICE'] as const;
export const CHAT_MESSAGE_STATUSES = ['PENDING', 'ANSWERING', 'DONE', 'FAILED', 'CANCELLED'] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];
export const CHAT_SAVE_TARGETS = ['MEMORY', 'KNOWLEDGE'] as const;

/**
 * How many agents one room may hold.
 *
 * Every owner message in a room is one model call per agent that answers, and
 * a later agent reads the earlier ones, so the cost of "ask all" grows with
 * the square of this. Four is a conversation; more is a meeting nobody can
 * follow.
 */
export const MAX_ROOM_AGENTS = 4;

export interface ChatConversation {
  id: string;
  ownerId: string;
  title: string;
  kind: ChatKind;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatParticipant {
  agentId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  position: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  authorKind: (typeof CHAT_AUTHOR_KINDS)[number];
  agentId: string | null;
  content: string;
  status: ChatMessageStatus;
  answers: string | null;
  evidence: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  answeredAt: string | null;
}

const MESSAGE_COLUMNS = `id, conversation_id, author_kind, agent_id, content, status, answers, evidence, error, created_at, answered_at`;

export async function createConversation(input: {
  ownerId: string;
  kind: ChatKind;
  title: string;
  agentIds: string[];
}): Promise<ChatConversation> {
  return withTransaction(async (tx) => {
    const row = await tx.one(
      `INSERT INTO chat_conversations (owner_id, kind, title) VALUES ($1,$2,$3) RETURNING *`,
      [input.ownerId, input.kind, input.title],
    );
    let position = 0;
    for (const agentId of input.agentIds) {
      await tx.many(
        `INSERT INTO chat_participants (conversation_id, agent_id, position)
         SELECT $1, a.id, $3 FROM agents a WHERE a.id = $2 AND a.owner_id = $4`,
        [row!.id as string, agentId, position, input.ownerId],
      );
      position += 1;
    }
    return mapRow<ChatConversation>(row)!;
  });
}

export async function listConversations(
  ownerId: string,
  options: { archived?: boolean; agentId?: string | null } = {},
): Promise<(ChatConversation & { participants: string[]; lastMessage: string | null; lastAt: string | null })[]> {
  const params: unknown[] = [ownerId, options.archived === true];
  let agentClause = '';
  if (options.agentId) {
    params.push(options.agentId);
    agentClause = `AND EXISTS (SELECT 1 FROM chat_participants p WHERE p.conversation_id = c.id AND p.agent_id = $${params.length})`;
  }
  return mapRows(
    await query(
      `SELECT c.*,
              coalesce((SELECT array_agg(p.agent_id::text ORDER BY p.position) FROM chat_participants p WHERE p.conversation_id = c.id), '{}') AS participants,
              (SELECT left(m.content, 160) FROM chat_messages m WHERE m.conversation_id = c.id AND m.status = 'DONE' ORDER BY m.seq DESC LIMIT 1) AS last_message,
              (SELECT max(m.created_at) FROM chat_messages m WHERE m.conversation_id = c.id) AS last_at
         FROM chat_conversations c
        WHERE c.owner_id = $1 AND (c.archived_at IS NOT NULL) = $2 ${agentClause}
        ORDER BY c.updated_at DESC
        LIMIT 200`,
      params,
    ),
  );
}

/** A conversation, only if it belongs to this owner. */
export async function getConversation(ownerId: string, id: string): Promise<ChatConversation | null> {
  return mapRow<ChatConversation>(
    await queryOne(`SELECT * FROM chat_conversations WHERE id = $1 AND owner_id = $2`, [id, ownerId]),
  );
}

/** A conversation by id alone, for the worker answering in it. Never for a route. */
export async function conversationById(id: string): Promise<ChatConversation | null> {
  return mapRow<ChatConversation>(await queryOne(`SELECT * FROM chat_conversations WHERE id = $1`, [id]));
}

export async function participants(conversationId: string): Promise<ChatParticipant[]> {
  return mapRows<ChatParticipant>(
    await query(
      `SELECT p.agent_id, a.name, a.slug, a.avatar_url, p.position
         FROM chat_participants p JOIN agents a ON a.id = p.agent_id
        WHERE p.conversation_id = $1 ORDER BY p.position`,
      [conversationId],
    ),
  );
}

export async function updateConversation(
  ownerId: string,
  id: string,
  patch: { title?: string; archived?: boolean },
): Promise<ChatConversation | null> {
  return mapRow<ChatConversation>(
    await queryOne(
      `UPDATE chat_conversations
          SET title = coalesce($3, title),
              archived_at = CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4 THEN coalesce(archived_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [id, ownerId, patch.title ?? null, patch.archived ?? null],
    ),
  );
}

/**
 * Deletes a conversation and its messages.
 *
 * What was saved from it stays saved: `chat_saves` keeps the row with its
 * conversation set to null, and the memory or knowledge it made is untouched.
 */
export async function deleteConversation(ownerId: string, id: string): Promise<boolean> {
  const rows = await query(`DELETE FROM chat_conversations WHERE id = $1 AND owner_id = $2 RETURNING id`, [id, ownerId]);
  return rows.length > 0;
}

/** Empties a conversation but keeps it, its title and who is in it. */
export async function clearMessages(ownerId: string, id: string): Promise<number> {
  const rows = await query(
    `DELETE FROM chat_messages m USING chat_conversations c
      WHERE m.conversation_id = c.id AND c.id = $1 AND c.owner_id = $2 RETURNING m.id`,
    [id, ownerId],
  );
  return rows.length;
}

export async function listMessages(conversationId: string, limit = 200): Promise<ChatMessage[]> {
  return mapRows<ChatMessage>(
    await query(
      `SELECT ${MESSAGE_COLUMNS} FROM (
         SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2
       ) recent ORDER BY seq`,
      [conversationId, limit],
    ),
  );
}

export async function getMessage(id: string): Promise<ChatMessage | null> {
  return mapRow<ChatMessage>(await queryOne(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = $1`, [id]));
}

/**
 * The owner says something, and the agents it is for are queued to answer.
 *
 * One answer per addressed agent, in room order, written with the message in
 * one transaction. Answers are only ever created here, from an owner message,
 * so no agent's answer can cause another answer: the room cannot run away.
 */
export async function postOwnerMessage(input: {
  conversationId: string;
  content: string;
  answerers: string[];
}): Promise<{ message: ChatMessage; pending: ChatMessage[] }> {
  return withTransaction(async (tx) => {
    const message = mapRow<ChatMessage>(
      await tx.one(
        `INSERT INTO chat_messages (conversation_id, author_kind, content, status)
         VALUES ($1, 'OWNER', $2, 'DONE') RETURNING ${MESSAGE_COLUMNS}`,
        [input.conversationId, input.content],
      ),
    )!;
    const pending: ChatMessage[] = [];
    for (const agentId of input.answerers) {
      pending.push(
        mapRow<ChatMessage>(
          await tx.one(
            `INSERT INTO chat_messages (conversation_id, author_kind, agent_id, status, answers)
             VALUES ($1, 'AGENT', $2, 'PENDING', $3) RETURNING ${MESSAGE_COLUMNS}`,
            [input.conversationId, agentId, message.id],
          ),
        )!,
      );
    }
    await tx.many(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [input.conversationId]);
    return { message, pending };
  });
}

/** Asks one agent to answer an owner message again, after a failure. */
export async function requeueAnswer(ownerId: string, answerId: string): Promise<ChatMessage | null> {
  return mapRow<ChatMessage>(
    await queryOne(
      `UPDATE chat_messages m SET status = 'PENDING', error = NULL, content = '', evidence = '{}'::jsonb,
              locked_by = NULL, lock_expires_at = NULL, answered_at = NULL
         FROM chat_conversations c
        WHERE m.id = $1 AND m.conversation_id = c.id AND c.owner_id = $2
          AND m.author_kind = 'AGENT' AND m.status IN ('FAILED', 'CANCELLED')
        RETURNING ${MESSAGE_COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')}`,
      [answerId, ownerId],
    ),
  );
}

/** Stops answers that have not started. One already being written finishes. */
export async function cancelPending(ownerId: string, conversationId: string): Promise<number> {
  const rows = await query(
    `UPDATE chat_messages m SET status = 'CANCELLED', error = 'Stopped by the owner.'
       FROM chat_conversations c
      WHERE m.conversation_id = c.id AND c.id = $1 AND c.owner_id = $2 AND m.status = 'PENDING'
      RETURNING m.id`,
    [conversationId, ownerId],
  );
  return rows.length;
}

/**
 * The next answer that may be written, held under a lease.
 *
 * Only the earliest unfinished answer in a conversation is claimable, so in a
 * room the second agent reads what the first said. An answer whose lease ran
 * out (a worker died writing it) is taken again.
 */
export async function claimNextAnswer(workerId: string, leaseMs: number): Promise<ChatMessage | null> {
  return mapRow<ChatMessage>(
    await queryOne(
      `UPDATE chat_messages SET status = 'ANSWERING', locked_by = $1,
              lock_expires_at = now() + ($2::int * interval '1 millisecond')
        WHERE id = (
          SELECT m.id FROM chat_messages m
           WHERE (m.status = 'PENDING' OR (m.status = 'ANSWERING' AND m.lock_expires_at < now()))
             AND NOT EXISTS (
               SELECT 1 FROM chat_messages e
                WHERE e.conversation_id = m.conversation_id AND e.seq < m.seq
                  AND e.status IN ('PENDING', 'ANSWERING'))
           ORDER BY m.seq
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING ${MESSAGE_COLUMNS}`,
      [workerId, leaseMs],
    ),
  );
}

/** Settles an answer, only if this worker still holds it. */
export async function settleAnswer(
  id: string,
  workerId: string,
  outcome: { status: 'DONE' | 'FAILED'; content: string; evidence: Record<string, unknown>; error: string | null },
): Promise<boolean> {
  const rows = await query(
    `UPDATE chat_messages SET status = $3, content = $4, evidence = $5::jsonb, error = $6,
            locked_by = NULL, lock_expires_at = NULL, answered_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'ANSWERING' RETURNING id`,
    [id, workerId, outcome.status, outcome.content, JSON.stringify(outcome.evidence), outcome.error],
  );
  if (rows.length > 0) {
    await query(
      `UPDATE chat_conversations SET updated_at = now() WHERE id = (SELECT conversation_id FROM chat_messages WHERE id = $1)`,
      [id],
    );
  }
  return rows.length > 0;
}

export interface ChatSave {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  agentId: string;
  target: (typeof CHAT_SAVE_TARGETS)[number];
  memoryId: string | null;
  knowledgeSourceId: string | null;
  content: string;
  createdAt: string;
}

export async function recordSave(input: Omit<ChatSave, 'id' | 'createdAt'> & { savedBy: string | null }): Promise<ChatSave> {
  return mapRow<ChatSave>(
    await queryOne(
      `INSERT INTO chat_saves (conversation_id, message_id, agent_id, target, memory_id, knowledge_source_id, content, saved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.conversationId, input.messageId, input.agentId, input.target, input.memoryId, input.knowledgeSourceId, input.content, input.savedBy],
    ),
  )!;
}

export async function savesFor(conversationId: string): Promise<ChatSave[]> {
  return mapRows<ChatSave>(await query(`SELECT * FROM chat_saves WHERE conversation_id = $1 ORDER BY created_at`, [conversationId]));
}
