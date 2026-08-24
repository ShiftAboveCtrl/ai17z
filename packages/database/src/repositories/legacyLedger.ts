import { createHash } from 'node:crypto';
import { query, queryOne } from '../pool';

/** The signature format AI4CZ wrote into posted_index.json. */
export function legacySignature(targetRef: string, text: string): string {
  return `${targetRef}|${createHash('sha1').update(text.trim(), 'utf8').digest('hex')}`;
}

export async function recordLegacyAction(input: {
  agentId: string;
  source: string;
  channel: string;
  targetRef: string | null;
  legacySignature: string;
}): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO legacy_action_ledger (agent_id, source, channel, target_ref, legacy_signature)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (agent_id, legacy_signature) DO NOTHING
     RETURNING id`,
    [input.agentId, input.source, input.channel, input.targetRef, input.legacySignature],
  );
  return row !== null;
}

/** True when a previous system already sent this exact text to this target. */
export async function legacyActionExists(agentId: string, signature: string): Promise<boolean> {
  const row = await queryOne<{ count: number }>(
    'SELECT count(*)::int AS count FROM legacy_action_ledger WHERE agent_id = $1 AND legacy_signature = $2',
    [agentId, signature],
  );
  return (row?.count ?? 0) > 0;
}

export async function countLegacyActions(agentId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    'SELECT count(*)::int AS count FROM legacy_action_ledger WHERE agent_id = $1',
    [agentId],
  );
  return row?.count ?? 0;
}
