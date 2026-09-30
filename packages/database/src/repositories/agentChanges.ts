/**
 * The history of changes an owner asked an agent to make in chat. See
 * `packages/runtime/src/agentManagement.ts` for what a change is and how it is
 * applied; this only keeps the record.
 */
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export const AGENT_CHANGE_STATUSES = ['APPLIED', 'AWAITING_CONFIRMATION', 'DECLINED', 'UNDONE', 'REFUSED', 'FAILED'] as const;
export const AGENT_CHANGE_RISKS = ['LOW', 'CONFIRM', 'NEVER'] as const;
export const AGENT_CHANGE_SUBSYSTEMS = ['PERSONA', 'POLICY', 'POSTING'] as const;

export type AgentChangeStatus = (typeof AGENT_CHANGE_STATUSES)[number];
export type AgentChangeRisk = (typeof AGENT_CHANGE_RISKS)[number];
export type AgentChangeSubsystem = (typeof AGENT_CHANGE_SUBSYSTEMS)[number];

export interface AgentChangeRow {
  id: string;
  agentId: string;
  ownerId: string | null;
  conversationId: string | null;
  messageId: string | null;
  requestText: string;
  kind: string;
  subsystem: AgentChangeSubsystem;
  risk: AgentChangeRisk;
  status: AgentChangeStatus;
  summary: string;
  beforeValue: unknown;
  afterValue: unknown;
  verification: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  undoneAt: string | null;
}

export async function create(input: {
  agentId: string;
  ownerId: string | null;
  conversationId: string | null;
  messageId: string | null;
  requestText: string;
  kind: string;
  subsystem: AgentChangeSubsystem;
  risk: AgentChangeRisk;
  status: AgentChangeStatus;
  summary: string;
  beforeValue: unknown;
  afterValue: unknown;
  verification?: Record<string, unknown>;
  error?: string | null;
}): Promise<AgentChangeRow> {
  const row = await queryOne(
    `INSERT INTO agent_changes (agent_id, owner_id, conversation_id, message_id, request_text, kind, subsystem, risk,
                                status, summary, before_value, after_value, verification, error, decided_at)
     VALUES ($1,$2,$3,$4,left($5, 2000),$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,
             CASE WHEN $9 IN ('APPLIED', 'REFUSED', 'FAILED') THEN now() ELSE NULL END)
     RETURNING *`,
    [
      input.agentId,
      input.ownerId,
      input.conversationId,
      input.messageId,
      input.requestText,
      input.kind,
      input.subsystem,
      input.risk,
      input.status,
      input.summary,
      JSON.stringify(input.beforeValue ?? null),
      JSON.stringify(input.afterValue ?? null),
      JSON.stringify(input.verification ?? {}),
      input.error ?? null,
    ],
  );
  return mapRow<AgentChangeRow>(row)!;
}

export async function get(id: string): Promise<AgentChangeRow | null> {
  return mapRow<AgentChangeRow>(await queryOne(`SELECT * FROM agent_changes WHERE id = $1`, [id]));
}

/**
 * Moves a change on, only from the state it is expected to be in.
 *
 * Two clicks on Undo, or Confirm pressed in two tabs, must not both happen:
 * the second finds the row already moved and gets null.
 */
export async function transition(
  id: string,
  from: AgentChangeStatus,
  to: AgentChangeStatus,
  extra: { verification?: Record<string, unknown>; error?: string | null } = {},
): Promise<AgentChangeRow | null> {
  return mapRow<AgentChangeRow>(
    await queryOne(
      `UPDATE agent_changes
          SET status = $3,
              verification = CASE WHEN $4::jsonb IS NULL THEN verification ELSE $4::jsonb END,
              error = coalesce($5, error),
              decided_at = CASE WHEN $2 = 'AWAITING_CONFIRMATION' THEN now() ELSE decided_at END,
              undone_at = CASE WHEN $3 = 'UNDONE' THEN now() ELSE undone_at END
        WHERE id = $1 AND status = $2
        RETURNING *`,
      [id, from, to, extra.verification ? JSON.stringify(extra.verification) : null, extra.error ?? null],
    ),
  );
}

/** Newest first. */
export async function listForAgent(agentId: string, since: string | null = null, limit = 50): Promise<AgentChangeRow[]> {
  return mapRows<AgentChangeRow>(
    await query(
      `SELECT * FROM agent_changes
        WHERE agent_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
        ORDER BY created_at DESC LIMIT $3`,
      [agentId, since, Math.min(200, limit)],
    ),
  );
}

/** The newest change to this agent that can still be undone. */
export async function latestUndoable(agentId: string): Promise<AgentChangeRow | null> {
  return mapRow<AgentChangeRow>(
    await queryOne(
      `SELECT * FROM agent_changes WHERE agent_id = $1 AND status = 'APPLIED' ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    ),
  );
}
