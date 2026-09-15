import type {
  AttentionKind,
  AttentionState,
  AutonomyLevel,
  EvidenceRef,
  GoalOrigin,
  GoalStatus,
  ReflectionKind,
  SalienceFactor,
} from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

/**
 * What an agent is currently thinking about, and what it means to do about it.
 *
 * The rows behind persistent autonomous deliberation. Nothing here decides
 * anything: the judgements live in `packages/runtime`, and this is the store
 * they are kept in, in the shape the rest of the product reads them.
 *
 * Two properties are worth naming because they are enforced here rather than
 * hoped for above:
 *
 * **Reinforcement, not repetition.** `remember` upserts on a fingerprint, so
 * the same observation arriving four times is one item that four things point
 * at rather than four items that look like an obsession. Without that, every
 * "write down what you noticed" design fills with near-duplicates within a day.
 *
 * **Supersession, not overwriting.** A wrong belief is replaced by pointing the
 * old row at the new one and leaving it standing. That is what lets an agent
 * say "I thought X, then I found out Y", which is the difference between
 * learning and quietly changing its mind. Stances already work this way.
 */

export interface AttentionRow {
  id: string;
  agentId: string;
  kind: AttentionKind;
  summary: string;
  detail: string;
  salience: number;
  factors: SalienceFactor[];
  confidence: number;
  evidence: EvidenceRef[];
  origin: string;
  state: AttentionState;
  supersededBy: string | null;
  resolution: string;
  fingerprint: string;
  reinforcements: number;
  firstObservedAt: string;
  lastReinforcedAt: string;
  reviewAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ATTENTION_COLUMNS = `id, agent_id, kind, summary, detail, salience, factors, confidence,
  evidence, origin, state, superseded_by, resolution, fingerprint, reinforcements,
  first_observed_at, last_reinforced_at, review_at, created_at, updated_at`;

export interface RememberInput {
  agentId: string;
  kind: AttentionKind;
  summary: string;
  detail?: string;
  salience: number;
  factors?: SalienceFactor[];
  confidence?: number;
  evidence?: EvidenceRef[];
  origin?: string;
  fingerprint: string;
  reviewAt?: string | null;
}

/**
 * Put something on the agent's mind, or reinforce what is already there.
 *
 * On a repeat the summary is **not** replaced. The first way something was put
 * is usually the clearest, and letting every later sighting rewrite it makes an
 * item drift with the last thing that happened to mention it. What a repeat
 * does change is the things a repeat is evidence about: it counts, it refreshes
 * the clock, it takes the higher salience and confidence, and it adds whatever
 * new evidence came with it.
 */
export async function remember(input: RememberInput): Promise<AttentionRow> {
  const row = await queryOne(
    `INSERT INTO agent_attention
       (agent_id, kind, summary, detail, salience, factors, confidence, evidence, origin,
        fingerprint, review_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11)
     ON CONFLICT (agent_id, kind, fingerprint) DO UPDATE
       SET reinforcements = agent_attention.reinforcements + 1,
           last_reinforced_at = now(),
           -- The stronger reading wins. A second sighting that mattered less
           -- is not a reason to care less about the thing.
           salience = greatest(agent_attention.salience, excluded.salience),
           confidence = greatest(agent_attention.confidence, excluded.confidence),
           factors = excluded.factors,
           -- Bounded, newest first. Evidence is a reference list, not an
           -- archive, and an item nothing can stop growing is a leak.
           evidence = (
             SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM (
               SELECT item FROM jsonb_array_elements(excluded.evidence || agent_attention.evidence) AS item
               LIMIT 12
             ) kept
           ),
           detail = CASE WHEN excluded.detail <> '' THEN excluded.detail ELSE agent_attention.detail END,
           review_at = coalesce(excluded.review_at, agent_attention.review_at),
           -- A retired item that turns up again is live again. That is the
           -- point of decay being reversible rather than deletion.
           state = CASE WHEN agent_attention.state = 'RETIRED' THEN 'ACTIVE' ELSE agent_attention.state END,
           updated_at = now()
     RETURNING ${ATTENTION_COLUMNS}`,
    [
      input.agentId,
      input.kind,
      input.summary.trim(),
      input.detail ?? '',
      Math.round(input.salience),
      JSON.stringify(input.factors ?? []),
      input.confidence ?? 0.5,
      JSON.stringify(input.evidence ?? []),
      input.origin ?? 'REFLECTION',
      input.fingerprint,
      input.reviewAt ?? null,
    ],
  );
  return mapRow<AttentionRow>(row) as AttentionRow;
}

/** What is on this agent's mind, strongest first. */
export async function onItsMind(
  agentId: string,
  options: { limit?: number; kinds?: AttentionKind[]; state?: AttentionState } = {},
): Promise<AttentionRow[]> {
  const params: unknown[] = [agentId];
  const clauses = ['agent_id = $1'];
  params.push(options.state ?? 'ACTIVE');
  clauses.push(`state = $${params.length}`);
  if (options.kinds && options.kinds.length > 0) {
    params.push(options.kinds);
    clauses.push(`kind = ANY($${params.length}::text[])`);
  }
  params.push(Math.min(Math.max(options.limit ?? 20, 1), 200));
  return mapRows<AttentionRow>(
    await query(
      `SELECT ${ATTENTION_COLUMNS} FROM agent_attention WHERE ${clauses.join(' AND ')}
        ORDER BY salience DESC, last_reinforced_at DESC LIMIT $${params.length}`,
      params,
    ),
  );
}

export async function getAttention(id: string): Promise<AttentionRow | null> {
  return mapRow<AttentionRow>(
    await queryOne(`SELECT ${ATTENTION_COLUMNS} FROM agent_attention WHERE id = $1`, [id]),
  );
}

/** Items due for another look, for the periodic pass. */
export async function dueForReview(agentId: string, limit = 20): Promise<AttentionRow[]> {
  return mapRows<AttentionRow>(
    await query(
      `SELECT ${ATTENTION_COLUMNS} FROM agent_attention
        WHERE agent_id = $1 AND state = 'ACTIVE' AND review_at IS NOT NULL AND review_at <= now()
        ORDER BY review_at LIMIT $2`,
      [agentId, limit],
    ),
  );
}

/**
 * Close an item off, in the agent's own words.
 *
 * `RESOLVED` is a question answered or a curiosity satisfied; `RETIRED` is one
 * that stopped mattering. Both keep the row, because "what did it used to be
 * wondering about" is a question an owner can reasonably ask.
 */
export async function settle(
  id: string,
  state: Exclude<AttentionState, 'ACTIVE'>,
  resolution: string,
  supersededBy?: string | null,
): Promise<void> {
  await query(
    `UPDATE agent_attention SET state = $2, resolution = $3, superseded_by = $4, updated_at = now()
      WHERE id = $1`,
    [id, state, resolution.slice(0, 2000), supersededBy ?? null],
  );
}

export async function reprice(id: string, salience: number, factors: SalienceFactor[]): Promise<void> {
  await query(
    'UPDATE agent_attention SET salience = $2, factors = $3::jsonb, updated_at = now() WHERE id = $1',
    [id, Math.round(salience), JSON.stringify(factors)],
  );
}

export async function noteReviewed(id: string, reviewAt: string | null): Promise<void> {
  await query('UPDATE agent_attention SET review_at = $2, updated_at = now() WHERE id = $1', [id, reviewAt]);
}

/** Everything still live, for decay and for the size bound. */
export async function liveItems(agentId: string): Promise<AttentionRow[]> {
  return mapRows<AttentionRow>(
    await query(
      `SELECT ${ATTENTION_COLUMNS} FROM agent_attention WHERE agent_id = $1 AND state = 'ACTIVE'
        ORDER BY salience DESC`,
      [agentId],
    ),
  );
}

export async function countLive(agentId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM agent_attention WHERE agent_id = $1 AND state = 'ACTIVE'",
    [agentId],
  );
  return rows[0]?.n ?? 0;
}

// ── Goals ───────────────────────────────────────────────────────────────────

export interface GoalRow {
  id: string;
  agentId: string;
  summary: string;
  reason: string;
  origin: GoalOrigin;
  pinned: boolean;
  priority: number;
  status: GoalStatus;
  progress: number;
  evidence: EvidenceRef[];
  resolution: string;
  nextReviewAt: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

const GOAL_COLUMNS = `id, agent_id, summary, reason, origin, pinned, priority, status, progress,
  evidence, resolution, next_review_at, created_at, updated_at, resolved_at`;

export async function addGoal(input: {
  agentId: string;
  summary: string;
  reason?: string;
  origin?: GoalOrigin;
  priority?: number;
  pinned?: boolean;
  evidence?: EvidenceRef[];
  nextReviewAt?: string | null;
}): Promise<GoalRow> {
  const row = await queryOne(
    `INSERT INTO agent_goals (agent_id, summary, reason, origin, priority, pinned, evidence, next_review_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING ${GOAL_COLUMNS}`,
    [
      input.agentId,
      input.summary.trim(),
      input.reason ?? '',
      input.origin ?? 'AGENT',
      input.priority ?? 50,
      input.pinned ?? false,
      JSON.stringify(input.evidence ?? []),
      input.nextReviewAt ?? null,
    ],
  );
  return mapRow<GoalRow>(row) as GoalRow;
}

export async function listGoals(
  agentId: string,
  options: { status?: GoalStatus | null; limit?: number } = {},
): Promise<GoalRow[]> {
  const params: unknown[] = [agentId];
  const clauses = ['agent_id = $1'];
  if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  return mapRows<GoalRow>(
    await query(
      `SELECT ${GOAL_COLUMNS} FROM agent_goals WHERE ${clauses.join(' AND ')}
        ORDER BY (status = 'ACTIVE') DESC, priority DESC, created_at DESC LIMIT $${params.length}`,
      params,
    ),
  );
}

export async function updateGoal(
  id: string,
  patch: Partial<{
    summary: string;
    reason: string;
    priority: number;
    status: GoalStatus;
    progress: number;
    pinned: boolean;
    resolution: string;
    nextReviewAt: string | null;
  }>,
): Promise<GoalRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (patch.summary !== undefined) push('summary = $?', patch.summary);
  if (patch.reason !== undefined) push('reason = $?', patch.reason);
  if (patch.priority !== undefined) push('priority = $?', patch.priority);
  if (patch.progress !== undefined) push('progress = $?', Math.max(0, Math.min(100, patch.progress)));
  if (patch.pinned !== undefined) push('pinned = $?', patch.pinned);
  if (patch.resolution !== undefined) push('resolution = $?', patch.resolution);
  if (patch.nextReviewAt !== undefined) push('next_review_at = $?', patch.nextReviewAt);
  if (patch.status !== undefined) {
    push('status = $?', patch.status);
    // A goal that ended records when. Without it "completed" and "completed
    // three weeks ago" look the same on a screen.
    sets.push("resolved_at = CASE WHEN $" + params.length + " IN ('COMPLETED','ABANDONED') THEN now() ELSE NULL END");
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = now()');
  return mapRow<GoalRow>(
    await queryOne(`UPDATE agent_goals SET ${sets.join(', ')} WHERE id = $1 RETURNING ${GOAL_COLUMNS}`, params),
  );
}

/** Add evidence that something moved a goal along, bounded. */
export async function noteGoalEvidence(id: string, evidence: EvidenceRef[]): Promise<void> {
  if (evidence.length === 0) return;
  await query(
    `UPDATE agent_goals
        SET evidence = (
              SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM (
                SELECT item FROM jsonb_array_elements($2::jsonb || evidence) AS item LIMIT 20
              ) kept
            ),
            updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(evidence)],
  );
}

export async function deleteGoal(agentId: string, id: string): Promise<boolean> {
  const rows = await query('DELETE FROM agent_goals WHERE id = $1 AND agent_id = $2 RETURNING id', [id, agentId]);
  return rows.length > 0;
}

// ── Reflections ─────────────────────────────────────────────────────────────

export interface ReflectionRow {
  id: string;
  agentId: string;
  kind: ReflectionKind;
  considered: number;
  produced: number;
  reinforced: number;
  retired: number;
  summary: string;
  model: string | null;
  durationMs: number;
  createdAt: string;
}

export async function recordReflection(input: {
  agentId: string;
  kind: ReflectionKind;
  considered?: number;
  produced?: number;
  reinforced?: number;
  retired?: number;
  summary?: string;
  model?: string | null;
  durationMs?: number;
}): Promise<ReflectionRow> {
  const row = await queryOne(
    `INSERT INTO agent_reflections (agent_id, kind, considered, produced, reinforced, retired, summary, model, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, agent_id, kind, considered, produced, reinforced, retired, summary, model, duration_ms, created_at`,
    [
      input.agentId,
      input.kind,
      input.considered ?? 0,
      input.produced ?? 0,
      input.reinforced ?? 0,
      input.retired ?? 0,
      (input.summary ?? '').slice(0, 2000),
      input.model ?? null,
      input.durationMs ?? 0,
    ],
  );
  return mapRow<ReflectionRow>(row) as ReflectionRow;
}

export async function recentReflections(agentId: string, limit = 20): Promise<ReflectionRow[]> {
  return mapRows<ReflectionRow>(
    await query(
      `SELECT id, agent_id, kind, considered, produced, reinforced, retired, summary, model, duration_ms, created_at
         FROM agent_reflections WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [agentId, Math.min(Math.max(limit, 1), 100)],
    ),
  );
}

// ── The wake schedule ───────────────────────────────────────────────────────

export interface WakeRow {
  agentId: string;
  enabled: boolean;
  autonomy: AutonomyLevel;
  intervalSeconds: number;
  deepIntervalSeconds: number;
  nextWakeAt: string;
  lastWakeAt: string | null;
  nextDeepAt: string;
  lastDeepAt: string | null;
  lastReason: string;
  quietWakes: number;
  createdAt: string;
  updatedAt: string;
}

const WAKE_COLUMNS = `agent_id, enabled, autonomy, interval_seconds, deep_interval_seconds,
  next_wake_at, last_wake_at, next_deep_at, last_deep_at, last_reason, quiet_wakes,
  created_at, updated_at`;

export async function getWake(agentId: string): Promise<WakeRow | null> {
  return mapRow<WakeRow>(await queryOne(`SELECT ${WAKE_COLUMNS} FROM agent_wake WHERE agent_id = $1`, [agentId]));
}

/** The owner's settings. Creates the row on first use, switched off. */
export async function setWake(
  agentId: string,
  patch: Partial<{
    enabled: boolean;
    autonomy: AutonomyLevel;
    intervalSeconds: number;
    deepIntervalSeconds: number;
  }>,
): Promise<WakeRow> {
  const row = await queryOne(
    `INSERT INTO agent_wake (agent_id, enabled, autonomy, interval_seconds, deep_interval_seconds)
     VALUES ($1, coalesce($2, false), coalesce($3, 'OBSERVE'), coalesce($4, 1800), coalesce($5, 86400))
     ON CONFLICT (agent_id) DO UPDATE
       SET enabled = coalesce($2, agent_wake.enabled),
           autonomy = coalesce($3, agent_wake.autonomy),
           interval_seconds = coalesce($4, agent_wake.interval_seconds),
           deep_interval_seconds = coalesce($5, agent_wake.deep_interval_seconds),
           -- An owner who just changed something is asking for it to take
           -- effect, not to take effect after the old interval.
           next_wake_at = least(agent_wake.next_wake_at, now()),
           quiet_wakes = 0,
           updated_at = now()
     RETURNING ${WAKE_COLUMNS}`,
    [
      agentId,
      patch.enabled ?? null,
      patch.autonomy ?? null,
      patch.intervalSeconds ?? null,
      patch.deepIntervalSeconds ?? null,
    ],
  );
  return mapRow<WakeRow>(row) as WakeRow;
}

/**
 * Agents due to think, claimed so two workers cannot wake one.
 *
 * The same shape as the account poller and the feed watcher: the claim moves
 * the due time forward in the statement that selects the row. That is what
 * stops a restart waking every agent at once and what makes the loop
 * restart-safe without any state in the process.
 */
export async function claimDueWakes(limit: number, holdSeconds: number): Promise<WakeRow[]> {
  return mapRows<WakeRow>(
    await query(
      `UPDATE agent_wake SET next_wake_at = now() + make_interval(secs => $2), last_wake_at = now()
        WHERE agent_id IN (
          SELECT w.agent_id FROM agent_wake w
            JOIN agents a ON a.id = w.agent_id
           WHERE w.enabled AND w.next_wake_at <= now() AND a.state = 'ACTIVE'
           ORDER BY w.next_wake_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${WAKE_COLUMNS}`,
      [limit, holdSeconds],
    ),
  );
}

/** What the wake decided, and when to come back. */
export async function noteWake(
  agentId: string,
  input: { reason: string; quiet: boolean; nextWakeAt?: string | null; didDeep?: boolean },
): Promise<void> {
  const sets = [
    'last_reason = $2',
    // Backing off a quiet agent is what stops it asking the same question of a
    // paid model every half hour for ever. Reset the moment anything happens.
    'quiet_wakes = CASE WHEN $3 THEN agent_wake.quiet_wakes + 1 ELSE 0 END',
    /*
      Recorded when the wake finishes rather than when it was claimed.

      `claimDueWakes` also stamps it, which covers the scheduled path. An owner
      pressing "think now" never goes through the claim, so without this their
      agent said it had never looked however often they asked -- and the next
      wake would read the same window again, because the window starts at the
      last wake.
    */
    'last_wake_at = now()',
    'updated_at = now()',
  ];
  const params: unknown[] = [agentId, input.reason.slice(0, 1000), input.quiet];
  if (input.nextWakeAt) {
    params.push(input.nextWakeAt);
    sets.push(`next_wake_at = $${params.length}`);
  }
  if (input.didDeep) {
    sets.push('last_deep_at = now()', 'next_deep_at = now() + make_interval(secs => deep_interval_seconds)');
  }
  await query(`UPDATE agent_wake SET ${sets.join(', ')} WHERE agent_id = $1`, params);
}

/** Whether a deep consolidation is due for this agent. */
export async function deepIsDue(agentId: string): Promise<boolean> {
  const rows = await query<{ due: boolean }>(
    'SELECT (next_deep_at <= now()) AS due FROM agent_wake WHERE agent_id = $1',
    [agentId],
  );
  return rows[0]?.due ?? false;
}

// ── What has happened, out of what the pipeline already wrote ───────────────

export interface ObservationRow extends Record<string, unknown> {
  source: string;
  id: string;
  text: string;
  at: string | null;
  handle: string | null;
  author_id: string | null;
  url: string | null;
  metrics: Record<string, number>;
}

/**
 * What has happened lately, from the records that already exist.
 *
 * **Nothing here is a new store.** `docs/ENGINEERING.md` is blunt that a second
 * record of what happened drifts from the first and the first is the one that
 * is true -- the inbox makes the same argument about being a read model rather
 * than a table, and the growth screens make it again. Deliberation observes by
 * reading events the radar discovered, actions the agent published and
 * conclusions it has already drawn.
 *
 * One statement rather than five round trips, because this runs on every wake
 * of every agent and the common answer is "nothing new".
 */
export async function recentObservations(input: {
  agentId: string;
  accountId: string | null;
  sinceIso: string;
  limit?: number;
}): Promise<ObservationRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 120, 1), 500);
  return query<ObservationRow>(
    `(
       -- What people said, and what found it.
       SELECT 'DISCOVERY'::text        AS source,
              e.id::text               AS id,
              e.text                   AS text,
              COALESCE(e.occurred_at, e.ingested_at) AS at,
              e.remote_author_handle   AS handle,
              e.remote_author_id       AS author_id,
              e.remote_url             AS url,
              COALESCE(e.payload -> 'metrics', '{}'::jsonb) AS metrics
         FROM events e
        WHERE ($2::uuid IS NULL OR e.account_id = $2)
          /*
            When AI17Z first saw it, never when it happened.

            The window answers "what has this agent not looked at yet", and an
            agent finds out about a post when the radar brings it back, not when
            somebody wrote it. Windowing on occurred_at looked equivalent and
            is not: on a real installation the median gap between a post
            happening and AI17Z ingesting it is nineteen hours, against a wake
            interval measured in minutes. So the window almost never contained
            the moment a post was written, deliberation observed nothing on
            almost every wake, and the feature did nothing at all outside its
            own tests -- where fixtures make events that happened just now.

            An old post arriving today is still a real question, and it is
            answered in the right place: salience.ts declines anything past
            STALE_HOURS as history rather than something happening. When it
            arrived and how old it is are two different facts and each belongs
            to a different layer.
          */
          AND e.ingested_at >= $3
          AND e.type <> 'SCHEDULED_TRIGGER'
        ORDER BY COALESCE(e.occurred_at, e.ingested_at) DESC
        LIMIT $4
     ) UNION ALL (
       -- What the agent itself published, and how it went. Its own posts are
       -- observations about itself rather than news, which is why they arrive
       -- under their own source and are scored differently.
       SELECT 'ACTION_RESULT'::text,
              a.id::text,
              COALESCE(a.payload ->> 'text', ''),
              a.executed_at,
              NULL,
              NULL,
              a.remote_action_url,
              '{}'::jsonb
         FROM actions a
         JOIN jobs j ON j.id = a.job_id
        WHERE j.agent_id = $1 AND a.status = 'EXECUTED' AND a.executed_at >= $3
        ORDER BY a.executed_at DESC
        LIMIT 40
     ) UNION ALL (
       -- Positions it has taken. A stance that has just gained evidence is a
       -- thing worth noticing about itself.
       SELECT 'STANCE'::text,
              s.id::text,
              s.subject || ': ' || s.summary,
              s.updated_at,
              NULL, NULL, NULL, '{}'::jsonb
         FROM stances s
        WHERE s.agent_id = $1 AND s.status = 'ACTIVE' AND s.updated_at >= $3
        ORDER BY s.updated_at DESC
        LIMIT 20
     ) UNION ALL (
       -- Promises it made and has not kept. The one observation that is about
       -- an obligation rather than an interest.
       SELECT 'COMMITMENT'::text,
              c.id::text,
              c.promise,
              c.created_at,
              c.recipient_handle,
              NULL, c.remote_url, '{}'::jsonb
         FROM commitments c
        WHERE c.agent_id = $1 AND c.status = 'OPEN'
        ORDER BY c.created_at DESC
        LIMIT 20
     )
     ORDER BY at DESC NULLS LAST
     LIMIT $4`,
    [input.agentId, input.accountId, input.sinceIso, limit],
  );
}

/** What the agent has said lately, so deliberation does not rediscover it. */
export async function recentlySaid(agentId: string, limit = 25): Promise<string[]> {
  const rows = await query<{ text: string }>(
    `SELECT COALESCE(a.payload ->> 'text', '') AS text
       FROM actions a JOIN jobs j ON j.id = a.job_id
      WHERE j.agent_id = $1 AND a.status = 'EXECUTED'
      ORDER BY a.executed_at DESC NULLS LAST LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((row) => row.text).filter((text) => text.trim().length > 0);
}
