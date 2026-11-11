import { mapRow, mapRows } from '../mapper';
import { query, queryOne, type Tx } from '../pool';

/**
 * Development updates: what a project shipped, on its way to being a post.
 *
 * Two tables. `dev_update_projects` maps a project key to the agent and account
 * that talk about it, with the owner's rules for how often and whether a person
 * decides. `dev_updates` is one submitted update and everything that happened
 * to it. The runtime module `devUpdates.ts` owns the lifecycle; this file is
 * only the queries, and the unique indexes in migration 0113 are what make
 * duplicate refusal hold under concurrency.
 */

export const DEV_UPDATE_MODES = ['DRAFT', 'AUTO'] as const;
export type DevUpdateMode = (typeof DEV_UPDATE_MODES)[number];

export const DEV_UPDATE_KINDS = ['FEATURE', 'FIX', 'IMPROVEMENT', 'MILESTONE', 'RELEASE'] as const;
export type DevUpdateKind = (typeof DEV_UPDATE_KINDS)[number];

export const DEV_UPDATE_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'DISPATCHED',
  'PUBLISHED',
  'REHEARSED',
  'SKIPPED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
] as const;
export type DevUpdateStatus = (typeof DEV_UPDATE_STATUSES)[number];

/** Statuses that are over: nothing will happen to the update again. */
export const DEV_UPDATE_FINAL_STATUSES: readonly DevUpdateStatus[] = [
  'PUBLISHED',
  'REHEARSED',
  'SKIPPED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
];

export interface DevUpdateEvidence {
  type: string;
  ref: string | null;
  detail: string;
}

/** A file that goes out with the post, by reference. The path is never stored here. */
export interface DevUpdateMediaRef {
  artifactId: string;
  kind: 'IMAGE' | 'GIF' | 'VIDEO';
  mime: string;
  bytes: number;
  sha256: string;
}

export interface DevUpdateHistoryEntry {
  at: string;
  status: DevUpdateStatus;
  actor: 'sender' | 'owner' | 'system';
  reason: string;
}

export interface DevUpdateProjectRow {
  id: string;
  ownerUserId: string;
  projectKey: string;
  displayName: string;
  agentId: string;
  accountId: string;
  mode: DevUpdateMode;
  enabled: boolean;
  dailyCap: number;
  minSpacingMinutes: number;
  rehearse: boolean;
  senderTokenHash: string | null;
  senderTokenHint: string | null;
  senderTokenIssuedAt: string | null;
  lastDispatchReason: string;
  lastConsideredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevUpdateRow {
  id: string;
  projectId: string;
  kind: DevUpdateKind;
  title: string;
  summary: string;
  why: string;
  evidence: DevUpdateEvidence[];
  postText: string;
  approvedText: string | null;
  factFingerprint: string;
  textFingerprint: string;
  evidenceKeys: string[];
  clientRequestId: string | null;
  /** Pictures or a video that go with the post, in order. Empty for a text-only update. */
  media: DevUpdateMediaRef[];
  status: DevUpdateStatus;
  statusReason: string;
  jobId: string | null;
  remoteUrl: string | null;
  history: DevUpdateHistoryEntry[];
  decidedBy: string | null;
  decidedAt: string | null;
  dispatchedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Projects ────────────────────────────────────────────────────────────────

export async function createProject(input: {
  ownerUserId: string;
  projectKey: string;
  displayName: string;
  agentId: string;
  accountId: string;
  mode: DevUpdateMode;
  enabled: boolean;
  dailyCap: number;
  minSpacingMinutes: number;
  rehearse: boolean;
  senderTokenHash: string;
  senderTokenHint: string;
}): Promise<DevUpdateProjectRow> {
  const row = await queryOne(
    `INSERT INTO dev_update_projects
       (owner_user_id, project_key, display_name, agent_id, account_id, mode, enabled, daily_cap,
        min_spacing_minutes, rehearse, sender_token_hash, sender_token_hint, sender_token_issued_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     RETURNING *`,
    [
      input.ownerUserId,
      input.projectKey,
      input.displayName,
      input.agentId,
      input.accountId,
      input.mode,
      input.enabled,
      input.dailyCap,
      input.minSpacingMinutes,
      input.rehearse,
      input.senderTokenHash,
      input.senderTokenHint,
    ],
  );
  return mapRow<DevUpdateProjectRow>(row) as DevUpdateProjectRow;
}

export async function getProject(id: string): Promise<DevUpdateProjectRow | null> {
  return mapRow<DevUpdateProjectRow>(await queryOne('SELECT * FROM dev_update_projects WHERE id = $1', [id]));
}

export async function findProjectByKey(ownerUserId: string, projectKey: string): Promise<DevUpdateProjectRow | null> {
  return mapRow<DevUpdateProjectRow>(
    await queryOne('SELECT * FROM dev_update_projects WHERE owner_user_id = $1 AND project_key = $2', [
      ownerUserId,
      projectKey,
    ]),
  );
}

export async function findProjectByTokenHash(hash: string): Promise<DevUpdateProjectRow | null> {
  return mapRow<DevUpdateProjectRow>(
    await queryOne('SELECT * FROM dev_update_projects WHERE sender_token_hash = $1', [hash]),
  );
}

export async function listProjects(ownerUserId: string): Promise<DevUpdateProjectRow[]> {
  return mapRows<DevUpdateProjectRow>(
    await query('SELECT * FROM dev_update_projects WHERE owner_user_id = $1 ORDER BY created_at', [ownerUserId]),
  );
}

export async function updateProject(
  id: string,
  patch: Partial<{
    displayName: string;
    agentId: string;
    accountId: string;
    mode: DevUpdateMode;
    enabled: boolean;
    dailyCap: number;
    minSpacingMinutes: number;
    rehearse: boolean;
  }>,
): Promise<DevUpdateProjectRow> {
  const columns: Record<string, string> = {
    displayName: 'display_name',
    agentId: 'agent_id',
    accountId: 'account_id',
    mode: 'mode',
    enabled: 'enabled',
    dailyCap: 'daily_cap',
    minSpacingMinutes: 'min_spacing_minutes',
    rehearse: 'rehearse',
  };
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  const sql = sets.length
    ? `UPDATE dev_update_projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`
    : 'SELECT * FROM dev_update_projects WHERE id = $1';
  return mapRow<DevUpdateProjectRow>(await queryOne(sql, params)) as DevUpdateProjectRow;
}

/** Replaces or clears the sender credential. Only a hash is ever written. */
export async function setSenderToken(id: string, hash: string | null, hint: string | null): Promise<DevUpdateProjectRow> {
  return mapRow<DevUpdateProjectRow>(
    await queryOne(
      `UPDATE dev_update_projects
          SET sender_token_hash = $2, sender_token_hint = $3,
              sender_token_issued_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, hash, hint],
    ),
  ) as DevUpdateProjectRow;
}

export async function setDispatchReason(id: string, reason: string, tx?: Tx): Promise<void> {
  const sql = `UPDATE dev_update_projects SET last_dispatch_reason = $2 WHERE id = $1`;
  const params = [id, reason.slice(0, 500)];
  if (tx) await tx.query(sql, params);
  else await query(sql, params);
}

/**
 * Takes a project row lock for the rest of the transaction.
 *
 * Submissions and dispatches for one project queue behind each other here,
 * which is what keeps the evidence check and the daily ceiling honest when two
 * arrive at once. Different projects never wait for each other.
 */
export async function lockProject(tx: Tx, id: string, skipLocked = false): Promise<DevUpdateProjectRow | null> {
  return mapRow<DevUpdateProjectRow>(
    await tx.one(`SELECT * FROM dev_update_projects WHERE id = $1 FOR UPDATE${skipLocked ? ' SKIP LOCKED' : ''}`, [id]),
  );
}

/** Moves a project to the back of the dispatcher's queue. */
export async function markConsidered(tx: Tx, id: string): Promise<void> {
  await tx.query('UPDATE dev_update_projects SET last_considered_at = clock_timestamp() WHERE id = $1', [id]);
}

/** Projects with something approved and waiting, least recently considered first. */
export async function projectsWithApproved(limit: number): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT p.id FROM dev_update_projects p
      WHERE p.enabled
        AND EXISTS (SELECT 1 FROM dev_updates u WHERE u.project_id = p.id AND u.status = 'APPROVED')
      ORDER BY p.last_considered_at NULLS FIRST, p.created_at
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.id);
}

// ── Updates ─────────────────────────────────────────────────────────────────

export async function getUpdate(id: string, tx?: Tx): Promise<DevUpdateRow | null> {
  const sql = 'SELECT * FROM dev_updates WHERE id = $1';
  return mapRow<DevUpdateRow>(tx ? await tx.one(sql, [id]) : await queryOne(sql, [id]));
}

export async function listUpdates(input: {
  projectIds: string[];
  statuses?: DevUpdateStatus[];
  limit: number;
}): Promise<DevUpdateRow[]> {
  if (input.projectIds.length === 0) return [];
  const params: unknown[] = [input.projectIds, input.limit];
  let statusFilter = '';
  if (input.statuses?.length) {
    params.push(input.statuses);
    statusFilter = 'AND status = ANY($3::text[])';
  }
  return mapRows<DevUpdateRow>(
    await query(
      `SELECT * FROM dev_updates WHERE project_id = ANY($1::uuid[]) ${statusFilter}
        ORDER BY created_at DESC LIMIT $2`,
      params,
    ),
  );
}

/** An earlier update the new one would repeat, and which rule matched. */
export async function findDuplicate(
  tx: Tx,
  input: { projectId: string; clientRequestId: string | null; factFingerprint: string; textFingerprint: string },
): Promise<{ row: DevUpdateRow; match: 'REQUEST' | 'FACT' | 'TEXT' } | null> {
  if (input.clientRequestId) {
    const byRequest = await tx.one(
      'SELECT * FROM dev_updates WHERE project_id = $1 AND client_request_id = $2',
      [input.projectId, input.clientRequestId],
    );
    if (byRequest) return { row: mapRow<DevUpdateRow>(byRequest) as DevUpdateRow, match: 'REQUEST' };
  }
  const byFact = await tx.one('SELECT * FROM dev_updates WHERE project_id = $1 AND fact_fingerprint = $2', [
    input.projectId,
    input.factFingerprint,
  ]);
  if (byFact) return { row: mapRow<DevUpdateRow>(byFact) as DevUpdateRow, match: 'FACT' };
  const byText = await tx.one('SELECT * FROM dev_updates WHERE project_id = $1 AND text_fingerprint = $2', [
    input.projectId,
    input.textFingerprint,
  ]);
  if (byText) return { row: mapRow<DevUpdateRow>(byText) as DevUpdateRow, match: 'TEXT' };
  return null;
}

/** Every evidence reference this project has already used. */
export async function knownEvidenceKeys(tx: Tx, projectId: string): Promise<Set<string>> {
  const rows = await tx.many<{ key: string }>(
    'SELECT DISTINCT unnest(evidence_keys) AS key FROM dev_updates WHERE project_id = $1',
    [projectId],
  );
  return new Set(rows.map((r) => r.key));
}

export async function countOpen(tx: Tx, projectId: string): Promise<number> {
  const row = await tx.one<{ count: number }>(
    `SELECT count(*)::int AS count FROM dev_updates
      WHERE project_id = $1 AND status IN ('PENDING_REVIEW', 'APPROVED', 'DISPATCHED')`,
    [projectId],
  );
  return Number(row?.count ?? 0);
}

export async function insertUpdate(
  tx: Tx,
  input: {
    projectId: string;
    kind: DevUpdateKind;
    title: string;
    summary: string;
    why: string;
    evidence: DevUpdateEvidence[];
    postText: string;
    factFingerprint: string;
    textFingerprint: string;
    evidenceKeys: string[];
    clientRequestId: string | null;
    media?: DevUpdateMediaRef[];
    status: DevUpdateStatus;
    statusReason: string;
    history: DevUpdateHistoryEntry[];
  },
): Promise<DevUpdateRow> {
  const row = await tx.one(
    `INSERT INTO dev_updates
       (project_id, kind, title, summary, why, evidence, post_text, fact_fingerprint, text_fingerprint,
        evidence_keys, client_request_id, status, status_reason, history, media)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::text[],$11,$12,$13,$14::jsonb,$15::jsonb)
     RETURNING *`,
    [
      input.projectId,
      input.kind,
      input.title,
      input.summary,
      input.why,
      JSON.stringify(input.evidence),
      input.postText,
      input.factFingerprint,
      input.textFingerprint,
      input.evidenceKeys,
      input.clientRequestId,
      input.status,
      input.statusReason,
      JSON.stringify(input.history),
      JSON.stringify(input.media ?? []),
    ],
  );
  return mapRow<DevUpdateRow>(row) as DevUpdateRow;
}

// ── Media ───────────────────────────────────────────────────────────────────
//
// A file a sender uploaded is an artifact of kind POST_MEDIA whose meta names
// the project (`devUpdateProjectId`) and, once an update takes it, that update
// (`attachedTo`). Nothing else ties them together, so a file nobody attached is
// exactly the ones with no `attachedTo`.

/** How many uploaded files this project has not attached to anything yet. */
export async function countUnattachedMedia(projectId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM artifacts
      WHERE kind = 'POST_MEDIA' AND meta->>'devUpdateProjectId' = $1 AND NOT (meta ? 'attachedTo')`,
    [projectId],
  );
  return Number(row?.count ?? 0);
}

/**
 * The project's own unattached files among these ids, locked for the rest of the
 * transaction. Fewer rows than ids means one was not this project's, was
 * already taken, or does not exist.
 */
export async function lockUnattachedMedia(tx: Tx, projectId: string, ids: string[]): Promise<DevUpdateMediaRef[]> {
  const rows = await tx.many<{ id: string; mime_type: string; bytes: number; meta: Record<string, unknown> }>(
    `SELECT id, mime_type, bytes, meta FROM artifacts
      WHERE id = ANY($2::uuid[]) AND kind = 'POST_MEDIA'
        AND meta->>'devUpdateProjectId' = $1 AND NOT (meta ? 'attachedTo')
      FOR UPDATE`,
    [projectId, ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const refs: DevUpdateMediaRef[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    refs.push({
      artifactId: r.id,
      kind: r.meta.mediaKind as DevUpdateMediaRef['kind'],
      mime: r.mime_type,
      bytes: Number(r.bytes),
      sha256: String(r.meta.sha256),
    });
  }
  return refs;
}

export async function markMediaAttached(tx: Tx, ids: string[], updateId: string): Promise<void> {
  await tx.query(
    `UPDATE artifacts SET meta = meta || jsonb_build_object('attachedTo', $2::text) WHERE id = ANY($1::uuid[])`,
    [ids, updateId],
  );
}

/** Uploaded files nobody attached, older than this many hours. */
export async function staleUnattachedMedia(olderThanHours: number, limit = 100): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM artifacts
      WHERE kind = 'POST_MEDIA' AND meta ? 'devUpdateProjectId' AND NOT (meta ? 'attachedTo')
        AND created_at < now() - ($1::int * interval '1 hour')
      ORDER BY created_at LIMIT $2`,
    [olderThanHours, limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Moves an update to a new status, only if it is still in one of `from`.
 *
 * The condition is the concurrency guarantee: an approval and a rejection
 * racing for one update cannot both win, and a dispatcher cannot pick up an
 * update somebody rejected a moment ago.
 */
export async function transition(
  input: {
    id: string;
    from: readonly DevUpdateStatus[];
    to: DevUpdateStatus;
    reason: string;
    actor: DevUpdateHistoryEntry['actor'];
    approvedText?: string | null;
    decidedBy?: string | null;
    jobId?: string | null;
    remoteUrl?: string | null;
    dispatched?: boolean;
    finished?: boolean;
    /** Empties the words, keeping fingerprints, for an update the owner rejected. */
    scrub?: boolean;
  },
  tx?: Tx,
): Promise<DevUpdateRow | null> {
  const entry: DevUpdateHistoryEntry = {
    at: new Date().toISOString(),
    status: input.to,
    actor: input.actor,
    reason: input.reason.slice(0, 500),
  };
  const params: unknown[] = [input.id, [...input.from], input.to, entry.reason, JSON.stringify([entry])];
  const sets = ['status = $3', 'status_reason = $4', 'history = history || $5::jsonb', 'updated_at = now()'];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (input.approvedText !== undefined) push('approved_text = $?', input.approvedText);
  if (input.decidedBy !== undefined) {
    push('decided_by = $?', input.decidedBy);
    sets.push('decided_at = now()');
  }
  if (input.jobId !== undefined) push('job_id = $?', input.jobId);
  if (input.remoteUrl !== undefined) push('remote_url = $?', input.remoteUrl);
  if (input.dispatched) sets.push('dispatched_at = now()');
  if (input.finished) sets.push('finished_at = now()');
  if (input.scrub) {
    sets.push(`title = '', summary = '', why = '', evidence = '[]'::jsonb, post_text = '', approved_text = NULL, media = '[]'::jsonb`);
  }
  const sql = `UPDATE dev_updates SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`;
  const row = tx ? await tx.one(sql, params) : await queryOne(sql, params);
  return mapRow<DevUpdateRow>(row);
}

/** An owner decision on an update already in the pipeline, recorded without moving it. */
export async function recordGateDecision(input: {
  id: string;
  decidedBy: string;
  approvedText: string | null;
  reason: string;
}): Promise<DevUpdateRow | null> {
  const entry: DevUpdateHistoryEntry = {
    at: new Date().toISOString(),
    status: 'DISPATCHED',
    actor: 'owner',
    reason: input.reason.slice(0, 500),
  };
  return mapRow<DevUpdateRow>(
    await queryOne(
      `UPDATE dev_updates
          SET decided_by = $2, decided_at = now(), approved_text = $3, status_reason = $4,
              history = history || $5::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'DISPATCHED'
        RETURNING *`,
      [input.id, input.decidedBy, input.approvedText, entry.reason, JSON.stringify([entry])],
    ),
  );
}

/** Updates the reason on a row without changing its status, when something is still pending. */
export async function noteReason(id: string, status: DevUpdateStatus, reason: string): Promise<void> {
  await query(
    `UPDATE dev_updates SET status_reason = $3, updated_at = now()
      WHERE id = $1 AND status = $2 AND status_reason IS DISTINCT FROM $3`,
    [id, status, reason.slice(0, 500)],
  );
}

/** How many went out in the last day, and when the latest did. */
export async function dispatchWindow(
  tx: Tx,
  projectId: string,
): Promise<{ lastDay: number; lastDispatchedAt: string | null }> {
  const row = await tx.one<{ last_day: number; last_at: Date | null }>(
    `SELECT count(*) FILTER (WHERE dispatched_at > now() - interval '24 hours')::int AS last_day,
            max(dispatched_at) AS last_at
       FROM dev_updates WHERE project_id = $1 AND dispatched_at IS NOT NULL`,
    [projectId],
  );
  return {
    lastDay: Number(row?.last_day ?? 0),
    lastDispatchedAt: row?.last_at ? new Date(row.last_at).toISOString() : null,
  };
}

/** Updates handed to the pipeline and not yet settled. */
export async function countInFlight(tx: Tx, projectId: string): Promise<number> {
  const row = await tx.one<{ count: number }>(
    `SELECT count(*)::int AS count FROM dev_updates WHERE project_id = $1 AND status = 'DISPATCHED'`,
    [projectId],
  );
  return Number(row?.count ?? 0);
}

/**
 * What this project actually sent, by the time the action went out.
 *
 * The ceiling and the spacing are about posts people see, so they are measured
 * on real executed actions, not on hand-overs: a job that waited a day at an
 * approval gate counts from when it was published. Read by the executor while
 * it holds the account lease, which is what makes the count and the send one
 * step for that account.
 */
export async function sentWindow(projectId: string, excludeJobId: string | null = null): Promise<{ lastDay: number; lastSentAt: string | null; oldestInDayAt: string | null }> {
  const row = await queryOne<{ last_day: number; last_at: Date | null; oldest_at: Date | null }>(
    `SELECT count(*) FILTER (WHERE a.executed_at > now() - interval '24 hours')::int AS last_day,
            max(a.executed_at) AS last_at,
            min(a.executed_at) FILTER (WHERE a.executed_at > now() - interval '24 hours') AS oldest_at
       FROM dev_updates u
       JOIN actions a ON a.job_id = u.job_id
      WHERE u.project_id = $1 AND a.status = 'EXECUTED' AND NOT a.dry_run AND a.executed_at IS NOT NULL
        AND ($2::uuid IS NULL OR a.job_id <> $2::uuid)`,
    [projectId, excludeJobId],
  );
  return {
    lastDay: Number(row?.last_day ?? 0),
    lastSentAt: row?.last_at ? new Date(row.last_at).toISOString() : null,
    oldestInDayAt: row?.oldest_at ? new Date(row.oldest_at).toISOString() : null,
  };
}

/** The approved update that has waited longest, locked for the caller. */
export async function oldestApproved(tx: Tx, projectId: string): Promise<DevUpdateRow | null> {
  return mapRow<DevUpdateRow>(
    await tx.one(
      `SELECT * FROM dev_updates WHERE project_id = $1 AND status = 'APPROVED'
        ORDER BY decided_at NULLS LAST, created_at LIMIT 1 FOR UPDATE`,
      [projectId],
    ),
  );
}

export async function listDispatched(limit: number): Promise<DevUpdateRow[]> {
  return mapRows<DevUpdateRow>(
    await query(`SELECT * FROM dev_updates WHERE status = 'DISPATCHED' ORDER BY dispatched_at LIMIT $1`, [limit]),
  );
}
