import { hashToken, randomToken, sealSecret } from '@xbam/shared';
import { query, queryOne, withTransaction } from '../pool';

export interface McpGrant extends Record<string, unknown> {
  id: string;
  owner_id: string;
  agent_ids: string[];
}

/** The bearer follows the sender-token scheme: only its hash reaches the DB. */
export async function issue(ownerId: string, agentIds: string[], hourlyQuota: number) {
  const token = `ai17z_mcp_${randomToken(32)}`;
  const sealed = sealSecret(token);
  return withTransaction(async tx => {
    const row = await tx.one<{ id: string }>(
      `INSERT INTO agent_mcp_tokens (owner_id, token_hash, agent_ids, hourly_quota)
       VALUES ($1, $2, $3, $4) RETURNING id`, [ownerId, hashToken(token), agentIds, hourlyQuota],
    );
    await tx.query(
      `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, data)
       VALUES ($1, 'agent_mcp.issue', 'agent_mcp', $2, '{}')`, [ownerId, row!.id],
    );
    return { id: row!.id, sealed };
  });
}

export async function resolve(token: string): Promise<McpGrant | null> {
  return queryOne<McpGrant>(
    `SELECT t.id, t.owner_id, t.agent_ids FROM agent_mcp_tokens t JOIN users u ON u.id = t.owner_id
     WHERE token_hash = $1 AND revoked_at IS NULL AND u.role = 'OWNER'`, [hashToken(token)],
  );
}

/** A single conditional UPDATE makes quota spending safe across processes. */
export async function spend(id: string): Promise<boolean> {
  return (await query(
    `UPDATE agent_mcp_tokens SET
       calls = CASE WHEN window_start < date_trunc('hour', now()) THEN 1 ELSE calls + 1 END,
       window_start = date_trunc('hour', now())
     WHERE id = $1 AND revoked_at IS NULL
       AND (window_start < date_trunc('hour', now()) OR calls < hourly_quota) RETURNING id`, [id],
  )).length === 1;
}

/** Persistent coalescing also bounds audit traffic across stdio processes. */
export async function admitAudit(id: string | null, kind: 'protocol' | 'refusal'): Promise<boolean> {
  return (await query(
    `INSERT INTO agent_mcp_audit_windows (bucket, token_id) VALUES ($1, $2)
     ON CONFLICT (bucket) DO UPDATE SET window_start = date_trunc('minute', now())
       WHERE agent_mcp_audit_windows.window_start < date_trunc('minute', now())
     RETURNING bucket`, [`${id ?? 'unauthenticated'}:${kind}`, id],
  )).length === 1;
}

export async function revoke(ownerId: string, id: string): Promise<boolean> {
  return withTransaction(async tx => {
    const rows = await tx.many('UPDATE agent_mcp_tokens SET revoked_at = now() WHERE id = $1 AND owner_id = $2 RETURNING id', [id, ownerId]);
    await tx.query(
      `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, data)
       VALUES ($1, 'agent_mcp.revoke', 'agent_mcp', $2, '{}')`, [ownerId, id],
    );
    return rows.length === 1;
  });
}
