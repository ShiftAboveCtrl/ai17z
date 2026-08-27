import type { Stance, StancePosition } from '@xbam/shared/contracts';
import { subjectKey } from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne, withTransaction } from '../pool';

export interface StanceRow extends Stance {
  updatedAt: string;
}

export interface EvidenceRow {
  id: string;
  stanceId: string;
  kind: string;
  excerpt: string;
  remoteUrl: string | null;
  createdAt: string;
}

export async function get(id: string): Promise<StanceRow | null> {
  return mapRow<StanceRow>(await queryOne('SELECT * FROM stances WHERE id = $1', [id]));
}

/** The position currently held on a subject, if any. */
export async function active(agentId: string, subject: string): Promise<StanceRow | null> {
  return mapRow<StanceRow>(
    await queryOne(`SELECT * FROM stances WHERE agent_id = $1 AND subject_key = $2 AND status = 'ACTIVE'`, [
      agentId,
      subjectKey(subject),
    ]),
  );
}

export async function listActive(agentId: string, limit = 100): Promise<StanceRow[]> {
  return mapRows<StanceRow>(
    await query(
      `SELECT * FROM stances WHERE agent_id = $1 AND status = 'ACTIVE'
        ORDER BY confidence DESC, last_reinforced_at DESC LIMIT $2`,
      [agentId, limit],
    ),
  );
}

/**
 * Positions relevant to a piece of text.
 *
 * Matched on the subject key appearing in the text rather than by embedding
 * search: the subjects are short, the set is small, and a stance retrieved for
 * the wrong reason is worse than one not retrieved at all.
 */
export async function relevantTo(agentId: string, text: string, limit = 4): Promise<StanceRow[]> {
  const haystack = ` ${subjectKey(text)} `;
  const all = await listActive(agentId, 200);
  return all
    .filter((stance) => stance.subjectKey.length >= 3 && haystack.includes(` ${stance.subjectKey} `))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Records a position, or reinforces one already held.
 *
 * Reinforcement raises confidence, but with a ceiling: repeating something is
 * not the same as having grounds for it, and an agent that says a thing forty
 * times should not end up certain of it on that basis alone.
 */
export async function assert(input: {
  agentId: string;
  subject: string;
  position: StancePosition;
  summary: string;
  confidence?: number;
  pinned?: boolean;
  evidence?: { kind?: string; excerpt: string; jobId?: string | null; eventId?: string | null; remoteUrl?: string | null };
}): Promise<StanceRow> {
  const key = subjectKey(input.subject);

  return withTransaction(async (tx) => {
    const existing = mapRow<StanceRow>(
      await tx.one(`SELECT * FROM stances WHERE agent_id = $1 AND subject_key = $2 AND status = 'ACTIVE'`, [
        input.agentId,
        key,
      ]),
    );

    let stanceId: string;

    if (existing && existing.position === input.position) {
      const reinforced = Math.min(0.92, Number(existing.confidence) + 0.05);
      const row = await tx.one(
        `UPDATE stances SET confidence = $2, summary = $3, last_reinforced_at = now(), updated_at = now()
          WHERE id = $1 RETURNING id`,
        [existing.id, reinforced, input.summary || existing.summary],
      );
      stanceId = (row as { id: string }).id;
    } else if (existing) {
      // A different position on the same subject supersedes rather than
      // overwrites. The old row is the record that the agent used to think
      // otherwise, which is what lets it say so.
      const created = await tx.one(
        `INSERT INTO stances (agent_id, subject, subject_key, position, summary, confidence, pinned)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          input.agentId,
          input.subject,
          key,
          input.position,
          input.summary,
          input.confidence ?? 0.5,
          input.pinned ?? false,
        ],
      );
      stanceId = (created as { id: string }).id;
      await tx.query(
        `UPDATE stances SET status = 'SUPERSEDED', superseded_by = $2, updated_at = now() WHERE id = $1`,
        [existing.id, stanceId],
      );
    } else {
      const created = await tx.one(
        `INSERT INTO stances (agent_id, subject, subject_key, position, summary, confidence, pinned)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          input.agentId,
          input.subject,
          key,
          input.position,
          input.summary,
          input.confidence ?? 0.5,
          input.pinned ?? false,
        ],
      );
      stanceId = (created as { id: string }).id;
    }

    if (input.evidence) {
      await tx.query(
        `INSERT INTO stance_evidence (stance_id, kind, excerpt, job_id, event_id, remote_url)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          stanceId,
          input.evidence.kind ?? 'said',
          input.evidence.excerpt.slice(0, 2_000),
          input.evidence.jobId ?? null,
          input.evidence.eventId ?? null,
          input.evidence.remoteUrl ?? null,
        ],
      );
    }

    return mapRow<StanceRow>(await tx.one('SELECT * FROM stances WHERE id = $1', [stanceId])) as StanceRow;
  });
}

export async function listEvidence(stanceId: string, limit = 20): Promise<EvidenceRow[]> {
  return mapRows<EvidenceRow>(
    await query('SELECT * FROM stance_evidence WHERE stance_id = $1 ORDER BY created_at DESC LIMIT $2', [
      stanceId,
      limit,
    ]),
  );
}

/** The chain of positions previously held on a subject, newest first. */
export async function history(agentId: string, subject: string): Promise<StanceRow[]> {
  return mapRows<StanceRow>(
    await query('SELECT * FROM stances WHERE agent_id = $1 AND subject_key = $2 ORDER BY created_at DESC', [
      agentId,
      subjectKey(subject),
    ]),
  );
}

/** Positions the agent has changed recently, so a reply can acknowledge it. */
export async function recentlyRevised(agentId: string, withinHours = 720, limit = 5) {
  return mapRows<{ subject: string; fromPosition: string; toPosition: string; changedAt: string }>(
    await query(
      `SELECT old.subject, old.position AS from_position, new.position AS to_position, new.created_at AS changed_at
         FROM stances old JOIN stances new ON new.id = old.superseded_by
        WHERE old.agent_id = $1 AND new.created_at > now() - ($2::int * interval '1 hour')
        ORDER BY new.created_at DESC LIMIT $3`,
      [agentId, withinHours, limit],
    ),
  );
}

export async function update(
  id: string,
  patch: Partial<{ summary: string; position: StancePosition; confidence: number; pinned: boolean; status: string }>,
): Promise<StanceRow> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (patch.summary !== undefined) push('summary = $?', patch.summary);
  if (patch.position !== undefined) push('position = $?', patch.position);
  if (patch.confidence !== undefined) push('confidence = $?', patch.confidence);
  if (patch.pinned !== undefined) push('pinned = $?', patch.pinned);
  if (patch.status !== undefined) push('status = $?', patch.status);
  sets.push('updated_at = now()');
  return mapRow<StanceRow>(
    await queryOne(`UPDATE stances SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params),
  ) as StanceRow;
}

// ── Predictions ─────────────────────────────────────────────────────────────

export async function recordPrediction(input: {
  agentId: string;
  claim: string;
  confidence?: number;
  reviewAt?: string | null;
  stanceId?: string | null;
  jobId?: string | null;
  remoteUrl?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO predictions (agent_id, claim, confidence, review_at, stance_id, job_id, remote_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.agentId,
      input.claim.slice(0, 2_000),
      input.confidence ?? 0.5,
      input.reviewAt ?? null,
      input.stanceId ?? null,
      input.jobId ?? null,
      input.remoteUrl ?? null,
    ],
  );
}

export async function listPredictions(agentId: string, outcome?: string, limit = 50) {
  const clauses = ['agent_id = $1'];
  const params: unknown[] = [agentId];
  if (outcome) {
    params.push(outcome);
    clauses.push(`outcome = $${params.length}`);
  }
  params.push(limit);
  return mapRows(
    await query(
      `SELECT * FROM predictions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    ),
  );
}

/** Predictions whose review date has arrived and nobody has judged yet. */
export async function predictionsDue(agentId: string, limit = 20) {
  return mapRows(
    await query(
      `SELECT * FROM predictions WHERE agent_id = $1 AND outcome = 'OPEN'
         AND review_at IS NOT NULL AND review_at <= now()
       ORDER BY review_at LIMIT $2`,
      [agentId, limit],
    ),
  );
}

/** Only a person judges a prediction. Nothing here decides it automatically. */
export async function resolvePrediction(id: string, outcome: string, note: string): Promise<void> {
  await query('UPDATE predictions SET outcome = $2, outcome_note = $3, resolved_at = now() WHERE id = $1', [
    id,
    outcome,
    note,
  ]);
}

// ── Commitments ─────────────────────────────────────────────────────────────

export async function recordCommitment(input: {
  agentId: string;
  promise: string;
  recipientHandle?: string | null;
  relationshipId?: string | null;
  confidence?: number;
  dueAt?: string | null;
  jobId?: string | null;
  remoteUrl?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO commitments (agent_id, promise, recipient_handle, relationship_id, confidence, due_at, job_id, remote_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.agentId,
      input.promise.slice(0, 1_000),
      input.recipientHandle ?? null,
      input.relationshipId ?? null,
      input.confidence ?? 0.5,
      input.dueAt ?? null,
      input.jobId ?? null,
      input.remoteUrl ?? null,
    ],
  );
}

export async function listCommitments(agentId: string, status = 'OPEN', limit = 50) {
  return mapRows(
    await query(
      'SELECT * FROM commitments WHERE agent_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3',
      [agentId, status, limit],
    ),
  );
}

/** Open promises to one person, so a reply can pick one up where it left off. */
export async function openCommitmentsTo(agentId: string, handle: string, limit = 3) {
  return mapRows<{ id: string; promise: string; createdAt: string }>(
    await query(
      `SELECT id, promise, created_at FROM commitments
        WHERE agent_id = $1 AND status = 'OPEN' AND lower(recipient_handle) = lower($2)
        ORDER BY created_at DESC LIMIT $3`,
      [agentId, handle.replace(/^@+/, ''), limit],
    ),
  );
}

export async function resolveCommitment(id: string, status: 'DONE' | 'DROPPED'): Promise<void> {
  await query('UPDATE commitments SET status = $2, resolved_at = now() WHERE id = $1', [id, status]);
}
