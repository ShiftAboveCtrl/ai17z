import { mapRow, mapRows } from '../mapper';
import { query, queryOne, type Tx } from '../pool';

export const TARGET_DISPOSITIONS = [
  'CONSIDERING',
  'AWAITING_APPROVAL',
  'INTERACTED',
  'INTENTIONAL_NO_ACTION',
  'DUPLICATE',
  'ALREADY_HANDLED',
  'COOLDOWN',
  'POLICY_REFUSAL',
  'ACCOUNT_DEGRADED',
  'STALE',
  'BLOCKED_EXTERNAL',
  'WATCH_ONLY',
] as const;

export type TargetDisposition = (typeof TARGET_DISPOSITIONS)[number];

export interface TargetStateRow {
  id: string;
  agentId: string;
  sourceId: string;
  mode: 'WATCH' | 'PRIORITIZE' | 'ENGAGE';
  remoteUserId: string | null;
  handle: string;
  displayName: string | null;
  lastSeenPostId: string | null;
  lastSeenAt: string | null;
  lastProcessedPostId: string | null;
  lastProcessedAt: string | null;
  lastInteractionAt: string | null;
  lastInteractionPostId: string | null;
  recentInteractions: number;
  pacedUntil: string | null;
  pacedReason: string | null;
  enabled: boolean;
  priority: number;
  latestDisposition: TargetDisposition | null;
  latestReason: string | null;
  latestDecidedAt: string | null;
}

export interface TargetIngestOutcome {
  agentId: string;
  jobId: string | null;
  created: boolean;
  disposition: TargetDisposition;
  reason: string;
}

/**
 * Records one watched post and what happened for every linked agent.
 *
 * This runs in the ingest transaction. The invariant is therefore stronger
 * than "we usually write an audit row afterwards": a target post cannot commit
 * a job (or a deliberate refusal) without committing its disposition too.
 */
export async function recordIngest(
  tx: Tx,
  input: {
    sourceId: string;
    eventId: string;
    remotePostId: string;
    remoteUserId: string | null;
    handle: string;
    displayName: string | null;
    mode: 'WATCH' | 'PRIORITIZE' | 'ENGAGE';
    outcomes: TargetIngestOutcome[];
  },
): Promise<void> {
  for (const outcome of input.outcomes) {
    const state = await tx.one<{ id: string }>(
      `INSERT INTO agent_target_state (
         agent_id, source_id, mode, remote_user_id, handle, display_name,
         last_seen_post_id, last_seen_at,
         last_processed_post_id, last_processed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8::text,CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (agent_id, source_id) DO UPDATE
         SET mode = excluded.mode,
             remote_user_id = coalesce(excluded.remote_user_id, agent_target_state.remote_user_id),
             handle = excluded.handle,
             display_name = coalesce(excluded.display_name, agent_target_state.display_name),
             -- Only ever forward. One poll returns several posts and they are
             -- recorded one at a time, so "the last one written" is usually an
             -- older post than one already recorded. X ids are snowflakes: a
             -- newer post has a longer id, or an equally long and larger one.
             last_seen_post_id = CASE
               WHEN agent_target_state.last_seen_post_id IS NULL
                 OR length(excluded.last_seen_post_id) > length(agent_target_state.last_seen_post_id)
                 OR (length(excluded.last_seen_post_id) = length(agent_target_state.last_seen_post_id)
                     AND excluded.last_seen_post_id > agent_target_state.last_seen_post_id)
               THEN excluded.last_seen_post_id
               ELSE agent_target_state.last_seen_post_id
             END,
             last_seen_at = now(),
             last_processed_post_id = CASE
               WHEN excluded.last_processed_post_id IS NULL THEN agent_target_state.last_processed_post_id
               WHEN agent_target_state.last_processed_post_id IS NULL
                 OR length(excluded.last_processed_post_id) > length(agent_target_state.last_processed_post_id)
                 OR (length(excluded.last_processed_post_id) = length(agent_target_state.last_processed_post_id)
                     AND excluded.last_processed_post_id > agent_target_state.last_processed_post_id)
               THEN excluded.last_processed_post_id
               ELSE agent_target_state.last_processed_post_id
             END,
             last_processed_at = CASE
               WHEN excluded.last_processed_post_id IS NULL THEN agent_target_state.last_processed_at
               ELSE now()
             END,
             updated_at = now()
       RETURNING id`,
      [
        outcome.agentId,
        input.sourceId,
        input.mode,
        input.remoteUserId,
        input.handle,
        input.displayName,
        input.remotePostId,
        outcome.disposition === 'WATCH_ONLY' ? null : input.remotePostId,
      ],
    );
    if (!state) continue;

    await tx.many(
      `INSERT INTO target_post_dispositions (
         agent_id, target_state_id, remote_post_id, event_id, job_id, disposition, reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (target_state_id, remote_post_id) DO UPDATE
         SET event_id = coalesce(target_post_dispositions.event_id, excluded.event_id),
             job_id = coalesce(target_post_dispositions.job_id, excluded.job_id),
             disposition = CASE
               -- Re-polling a post must never turn a terminal truth back into
               -- "considering" or "already handled".
               WHEN target_post_dispositions.disposition IN ('CONSIDERING','AWAITING_APPROVAL')
                AND excluded.disposition NOT IN ('CONSIDERING','ALREADY_HANDLED','DUPLICATE')
                 THEN excluded.disposition
               ELSE target_post_dispositions.disposition
             END,
             reason = CASE
               WHEN target_post_dispositions.disposition IN ('CONSIDERING','AWAITING_APPROVAL')
                AND excluded.disposition NOT IN ('CONSIDERING','ALREADY_HANDLED','DUPLICATE')
                 THEN excluded.reason
               ELSE target_post_dispositions.reason
             END,
             decided_at = CASE
               WHEN target_post_dispositions.disposition IN ('CONSIDERING','AWAITING_APPROVAL')
                AND excluded.disposition NOT IN ('CONSIDERING','ALREADY_HANDLED','DUPLICATE')
                 THEN now()
               ELSE target_post_dispositions.decided_at
             END`,
      [
        outcome.agentId,
        state.id,
        input.remotePostId,
        input.eventId,
        outcome.jobId,
        outcome.disposition,
        outcome.reason.slice(0, 500),
      ],
    );
  }
}

/** Moves the target audit row with the canonical job lifecycle. */
export async function setDispositionForJob(
  jobId: string,
  disposition: TargetDisposition,
  reason: string,
): Promise<void> {
  const row = await queryOne<{ target_state_id: string; remote_post_id: string }>(
    `UPDATE target_post_dispositions
        SET disposition = $2, reason = $3, decided_at = now()
      WHERE job_id = $1
        AND disposition NOT IN ('INTERACTED','POLICY_REFUSAL','STALE','WATCH_ONLY')
      RETURNING target_state_id, remote_post_id`,
    [jobId, disposition, reason.slice(0, 500)],
  );
  if (!row) return;

  await query(
    `UPDATE agent_target_state
        SET last_processed_post_id = CASE
              WHEN last_processed_post_id IS NULL
                OR length($2::text) > length(last_processed_post_id)
                OR (length($2::text) = length(last_processed_post_id) AND $2::text > last_processed_post_id)
              THEN $2::text
              ELSE last_processed_post_id
            END,
            last_processed_at = now(),
            last_interaction_post_id = CASE WHEN $3 = 'INTERACTED' THEN $2::text ELSE last_interaction_post_id END,
            last_interaction_at = CASE WHEN $3 = 'INTERACTED' THEN now() ELSE last_interaction_at END,
            recent_interactions = CASE WHEN $3 = 'INTERACTED' THEN recent_interactions + 1 ELSE recent_interactions END,
            updated_at = now()
      WHERE id = $1`,
    [row.target_state_id, row.remote_post_id, disposition],
  );
}

/** Owner-visible state, joined to the canonical watch for enabled/priority. */
export async function listAgentTargets(agentId: string): Promise<TargetStateRow[]> {
  return mapRows<TargetStateRow>(
    await query(
      `SELECT ts.*,
              rs.enabled,
              coalesce((rs.config ->> 'priority')::int, 50) AS priority,
              latest.disposition AS latest_disposition,
              latest.reason AS latest_reason,
              latest.decided_at AS latest_decided_at
         FROM agent_target_state ts
         JOIN radar_sources rs ON rs.id = ts.source_id
         LEFT JOIN LATERAL (
           SELECT disposition, reason, decided_at
             FROM target_post_dispositions d
            WHERE d.target_state_id = ts.id
            ORDER BY d.decided_at DESC
            LIMIT 1
         ) latest ON true
        WHERE ts.agent_id = $1
        ORDER BY rs.enabled DESC, priority DESC, ts.updated_at DESC`,
      [agentId],
    ),
  );
}

export async function dispositionForJob(jobId: string) {
  return mapRow<{ disposition: TargetDisposition; reason: string; decidedAt: string }>(
    await queryOne(
      `SELECT disposition, reason, decided_at
         FROM target_post_dispositions WHERE job_id = $1`,
      [jobId],
    ),
  );
}
