import type { VoiceFingerprint } from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface FingerprintRow {
  id: string;
  agentId: string;
  fingerprint: VoiceFingerprint;
  sampleCount: number;
  sources: string[];
  pinned: boolean;
  derivedAt: string;
}

export async function getFingerprint(agentId: string): Promise<FingerprintRow | null> {
  return mapRow<FingerprintRow>(await queryOne('SELECT * FROM voice_fingerprints WHERE agent_id = $1', [agentId]));
}

/**
 * Stores a freshly derived fingerprint.
 *
 * A pinned fingerprint is left alone: the owner corrected it by hand, and a
 * re-derivation quietly undoing that would make the correction pointless.
 */
export async function saveFingerprint(input: {
  agentId: string;
  fingerprint: VoiceFingerprint;
  sources: string[];
  force?: boolean;
}): Promise<FingerprintRow> {
  const row = await queryOne(
    `INSERT INTO voice_fingerprints (agent_id, fingerprint, sample_count, sources, derived_at)
     VALUES ($1,$2::jsonb,$3,$4::jsonb, now())
     ON CONFLICT (agent_id) DO UPDATE
       SET fingerprint = CASE WHEN voice_fingerprints.pinned AND NOT $5 THEN voice_fingerprints.fingerprint
                              ELSE excluded.fingerprint END,
           sample_count = CASE WHEN voice_fingerprints.pinned AND NOT $5 THEN voice_fingerprints.sample_count
                               ELSE excluded.sample_count END,
           sources = CASE WHEN voice_fingerprints.pinned AND NOT $5 THEN voice_fingerprints.sources
                          ELSE excluded.sources END,
           derived_at = CASE WHEN voice_fingerprints.pinned AND NOT $5 THEN voice_fingerprints.derived_at
                             ELSE now() END
     RETURNING *`,
    [
      input.agentId,
      JSON.stringify(input.fingerprint),
      input.fingerprint.sampleCount,
      JSON.stringify(input.sources),
      input.force ?? false,
    ],
  );
  return mapRow<FingerprintRow>(row) as FingerprintRow;
}

export async function setPinned(agentId: string, pinned: boolean): Promise<void> {
  await query('UPDATE voice_fingerprints SET pinned = $2 WHERE agent_id = $1', [agentId, pinned]);
}

/** Records something the agent published, for later similarity checks. */
export async function recordOutput(input: {
  agentId: string;
  actionId?: string | null;
  text: string;
  recipientHandle?: string | null;
}): Promise<void> {
  await query(
    'INSERT INTO recent_output (agent_id, action_id, text, recipient_handle) VALUES ($1,$2,$3,$4)',
    [input.agentId, input.actionId ?? null, input.text, input.recipientHandle ?? null],
  );
}

export interface RecentOutputRow {
  text: string;
  recipientHandle: string | null;
  postedAt: string;
}

/**
 * What the agent has said lately.
 *
 * Bounded by both count and age: comparing against everything an agent has ever
 * written would make an established agent unable to say anything, and reuse
 * from four months ago is not repetition.
 */
export async function recentOutput(agentId: string, limit = 40, withinDays = 21): Promise<RecentOutputRow[]> {
  return mapRows<RecentOutputRow>(
    await query(
      `SELECT text, recipient_handle, posted_at FROM recent_output
        WHERE agent_id = $1 AND posted_at > now() - ($3::int * interval '1 day')
        ORDER BY posted_at DESC LIMIT $2`,
      [agentId, limit, withinDays],
    ),
  );
}

/**
 * Samples to derive a fingerprint from.
 *
 * Only text the agent actually published. A draft that was rejected is not how
 * this agent writes, and including it would teach the fingerprint the thing
 * somebody objected to.
 */
export async function samplesForFingerprint(agentId: string, limit = 400): Promise<string[]> {
  const rows = await query<{ text: string }>(
    `SELECT text FROM recent_output WHERE agent_id = $1 ORDER BY posted_at DESC LIMIT $2`,
    [agentId, limit],
  );
  return rows.map((row) => row.text);
}

/** Keeps the ledger from growing without bound. */
export async function pruneOutput(agentId: string, keep = 500): Promise<number> {
  const rows = await query(
    `DELETE FROM recent_output WHERE id IN (
       SELECT id FROM recent_output WHERE agent_id = $1 ORDER BY posted_at DESC OFFSET $2
     ) RETURNING id`,
    [agentId, keep],
  );
  return rows.length;
}
