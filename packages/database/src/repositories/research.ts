/**
 * The Research Fabric's store: objects, the families that saw them, and the
 * runs that went looking.
 *
 * Every observation any adapter makes enters through `recordObservation`, which
 * is where the three rules that make this worth having are enforced, in one
 * transaction, so no adapter has to remember them:
 *
 *   - one object per thing, whatever copy it was found through;
 *   - one sighting per family, however many hosts that family answers on;
 *   - the thing's own home is its text, and a copy that says something else is
 *     recorded as disagreeing, never merged into it.
 */
import { createHash } from 'node:crypto';
import {
  copiesDisagree,
  readingPrecedence,
  RESEARCH_NORMALIZATION_VERSION,
  type EvidenceCompleteness,
  type ResearchObservation,
  type ResearchRunKind,
  type ResearchRunStatus,
  type SourceAvailability,
  type SourceFamily,
  type SourceTrustTier,
} from '@xbam/shared/contracts';
import { query, queryOne, withTransaction, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

export function evidenceHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface ResearchRunRow {
  id: string;
  ownerId: string;
  agentId: string | null;
  kind: ResearchRunKind;
  brief: Record<string, unknown>;
  plan: Record<string, unknown>;
  status: ResearchRunStatus;
  stage: string;
  stageLog: { stage: string; at: string; detail: string }[];
  budget: Record<string, unknown>;
  spent: Record<string, unknown>;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export async function createRun(input: {
  ownerId: string;
  agentId?: string | null;
  kind: ResearchRunKind;
  brief: Record<string, unknown>;
  plan?: Record<string, unknown>;
  budget?: Record<string, unknown>;
}): Promise<ResearchRunRow> {
  return mapRow<ResearchRunRow>(
    await queryOne(
      `INSERT INTO research_runs (owner_id, agent_id, kind, brief, plan, budget)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) RETURNING *`,
      [
        input.ownerId,
        input.agentId ?? null,
        input.kind,
        JSON.stringify(input.brief),
        JSON.stringify(input.plan ?? {}),
        JSON.stringify(input.budget ?? {}),
      ],
    ),
  )!;
}

export async function getRun(id: string): Promise<ResearchRunRow | null> {
  return mapRow<ResearchRunRow>(await queryOne('SELECT * FROM research_runs WHERE id = $1', [id]));
}

export async function listRuns(filter: { ownerId: string; agentId?: string | null; limit?: number }): Promise<ResearchRunRow[]> {
  return mapRows<ResearchRunRow>(
    await query(
      `SELECT * FROM research_runs
        WHERE owner_id = $1 AND ($2::uuid IS NULL OR agent_id = $2)
        ORDER BY created_at DESC LIMIT $3`,
      [filter.ownerId, filter.agentId ?? null, Math.min(100, filter.limit ?? 20)],
    ),
  );
}

/**
 * Takes the next run that is due, under a lease.
 *
 * The claim and the lease are one statement, like every other loop here, so two
 * workers never advance one run and a restart does not stampede every run at
 * once. A lease that expires makes the run claimable again at the stage it had
 * committed, which is why a stage must be safe to repeat.
 */
export async function claimDueRun(workerId: string, leaseMs: number): Promise<ResearchRunRow | null> {
  return mapRow<ResearchRunRow>(
    await queryOne(
      `UPDATE research_runs r
          SET claimed_by = $1,
              lease_expires_at = now() + ($2::int * interval '1 millisecond'),
              status = 'RUNNING',
              attempts = r.attempts + 1,
              updated_at = now()
        WHERE r.id = (
          SELECT id FROM research_runs
           WHERE status IN ('QUEUED', 'RUNNING')
             AND next_attempt_at <= now()
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
           ORDER BY next_attempt_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING r.*`,
      [workerId, leaseMs],
    ),
  );
}

/**
 * Commits what a stage produced and moves the run on.
 *
 * Only the holder of the lease may commit: a worker whose lease expired while
 * it was working finds its commit refused, and the stage is redone by whoever
 * holds it now. Returns false when refused.
 */
export async function commitStage(
  runId: string,
  workerId: string,
  input: {
    stage: string;
    detail: string;
    plan?: Record<string, unknown>;
    spent?: Record<string, unknown>;
    status?: ResearchRunStatus;
    /** Hand the lease back so the next stage can be claimed, by this worker or another. */
    release?: boolean;
    /** Keep holding it this much longer, for a run that goes straight on to its next stage. */
    extendMs?: number;
    lastError?: string | null;
  },
): Promise<boolean> {
  const finishing = input.status === 'READY' || input.status === 'FAILED' || input.status === 'CANCELLED';
  const row = await queryOne(
    `UPDATE research_runs
        SET stage = $3,
            stage_log = stage_log || jsonb_build_array(jsonb_build_object('stage', $3::text, 'at', now(), 'detail', $4::text)),
            plan = COALESCE($5::jsonb, plan),
            spent = COALESCE($6::jsonb, spent),
            status = COALESCE($7, status),
            claimed_by = CASE WHEN $8 THEN NULL ELSE claimed_by END,
            lease_expires_at = CASE WHEN $8 THEN NULL
                                    WHEN $11::int > 0 THEN now() + ($11::int * interval '1 millisecond')
                                    ELSE lease_expires_at END,
            last_error = $9,
            finished_at = CASE WHEN $10 THEN now() ELSE finished_at END,
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2
      RETURNING id`,
    [
      runId,
      workerId,
      input.stage,
      input.detail.slice(0, 2_000),
      input.plan ? JSON.stringify(input.plan) : null,
      input.spent ? JSON.stringify(input.spent) : null,
      input.status ?? null,
      input.release === true || finishing,
      input.lastError ?? null,
      finishing,
      Math.max(0, Math.round(input.extendMs ?? 0)),
    ],
  );
  return row !== null;
}

/** Backs a run off after a failure it may recover from, keeping its stage. */
export async function deferRun(runId: string, workerId: string, delayMs: number, lastError: string): Promise<void> {
  await query(
    `UPDATE research_runs
        SET claimed_by = NULL, lease_expires_at = NULL,
            next_attempt_at = now() + ($3::int * interval '1 millisecond'),
            last_error = $4, updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [runId, workerId, delayMs, lastError.slice(0, 2_000)],
  );
}

/** Stops a run at the owner's request. Evidence already gathered is kept. */
export async function cancelRun(runId: string, ownerId: string): Promise<boolean> {
  const row = await queryOne(
    `UPDATE research_runs
        SET status = 'CANCELLED', claimed_by = NULL, lease_expires_at = NULL,
            finished_at = now(), updated_at = now(),
            stage_log = stage_log || jsonb_build_array(jsonb_build_object('stage', stage, 'at', now(), 'detail', 'Stopped by the owner.'))
      WHERE id = $1 AND owner_id = $2 AND status IN ('QUEUED', 'RUNNING')
      RETURNING id`,
    [runId, ownerId],
  );
  return row !== null;
}

// ── Objects and sightings ────────────────────────────────────────────────────

export interface ResearchObjectRow {
  id: string;
  ownerId: string;
  objectKey: string;
  kind: string;
  platform: string | null;
  externalId: string | null;
  canonicalUrl: string | null;
  author: string | null;
  inReplyTo: string | null;
  publishedAt: string | null;
  content: string;
  contentHash: string;
  language: string | null;
  completeness: EvidenceCompleteness;
  bestTier: SourceTrustTier;
  bestFamily: SourceFamily;
  confirmedOnPlatform: boolean;
  normalizationVersion: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ResearchSightingRow {
  id: string;
  objectId: string;
  runId: string | null;
  family: SourceFamily;
  tier: SourceTrustTier;
  completeness: EvidenceCompleteness;
  originalUrls: string[];
  content: string;
  contentHash: string;
  disagrees: boolean;
  meta: Record<string, unknown>;
  fetchedAt: string;
  firstSeenAt: string;
}

export interface RecordOutcome {
  objectId: string;
  /** The first time anything saw this object. */
  created: boolean;
  /** This copy became the object's text. */
  becameBest: boolean;
  /** This family's copy says something different from the object's text. */
  disagrees: boolean;
}

/**
 * Records one sighting of one object.
 *
 * Safe to repeat: the same family seeing the same object again updates its
 * sighting rather than adding one, and a later run re-reading a page is how a
 * refresh works.
 */
export async function recordObservation(
  ownerId: string,
  runId: string | null,
  observation: ResearchObservation,
): Promise<RecordOutcome> {
  return withTransaction((tx) => recordIn(tx, ownerId, runId, observation));
}

async function recordIn(tx: Tx, ownerId: string, runId: string | null, o: ResearchObservation): Promise<RecordOutcome> {
  const hash = evidenceHash(o.content);
  const inserted = await tx.one<{ id: string }>(
    `INSERT INTO research_objects
       (owner_id, object_key, kind, platform, external_id, canonical_url, author, in_reply_to, published_at,
        content, content_hash, language, completeness, best_tier, best_family, confirmed_on_platform, normalization_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (owner_id, object_key) DO NOTHING
     RETURNING id`,
    [
      ownerId,
      o.objectKey,
      o.kind,
      o.platform,
      o.externalId,
      o.canonicalUrl,
      o.author,
      o.inReplyTo,
      o.publishedAt,
      o.content,
      hash,
      o.language,
      o.completeness,
      o.tier,
      o.family,
      o.tier === 'PRIMARY_PLATFORM',
      RESEARCH_NORMALIZATION_VERSION,
    ],
  );

  let objectId: string;
  let becameBest = false;
  if (inserted) {
    objectId = inserted.id;
    becameBest = true;
  } else {
    const current = await tx.one<{
      id: string;
      content: string;
      completeness: EvidenceCompleteness;
      best_tier: SourceTrustTier;
    }>(
      `SELECT id, content, completeness, best_tier FROM research_objects
        WHERE owner_id = $1 AND object_key = $2 FOR UPDATE`,
      [ownerId, o.objectKey],
    );
    objectId = current!.id;
    becameBest =
      readingPrecedence(o.tier, o.completeness) > readingPrecedence(current!.best_tier, current!.completeness);
    if (becameBest) {
      await tx.query(
        `UPDATE research_objects
            SET kind = $2, canonical_url = COALESCE($3, canonical_url), author = COALESCE($4, author),
                in_reply_to = COALESCE($5, in_reply_to), published_at = COALESCE($6, published_at),
                content = $7, content_hash = $8, language = COALESCE($9, language), completeness = $10,
                best_tier = $11, best_family = $12, normalization_version = $13
          WHERE id = $1`,
        [
          objectId,
          o.kind,
          o.canonicalUrl,
          o.author,
          o.inReplyTo,
          o.publishedAt,
          o.content,
          hash,
          o.language,
          o.completeness,
          o.tier,
          o.family,
          RESEARCH_NORMALIZATION_VERSION,
        ],
      );
    } else {
      // Fill in what the better copy did not say, without replacing what it did.
      await tx.query(
        `UPDATE research_objects
            SET published_at = COALESCE(published_at, $2), author = COALESCE(author, $3),
                in_reply_to = COALESCE(in_reply_to, $4), language = COALESCE(language, $5)
          WHERE id = $1`,
        [objectId, o.publishedAt, o.author, o.inReplyTo, o.language],
      );
    }
    await tx.query(
      `UPDATE research_objects
          SET last_seen_at = now(),
              confirmed_on_platform = confirmed_on_platform OR $2
        WHERE id = $1`,
      [objectId, o.tier === 'PRIMARY_PLATFORM'],
    );
  }

  const best = await tx.one<{ content: string; completeness: EvidenceCompleteness }>(
    'SELECT content, completeness FROM research_objects WHERE id = $1',
    [objectId],
  );
  const disagrees = !becameBest && copiesDisagree(best!, { content: o.content, completeness: o.completeness });

  await tx.query(
    `INSERT INTO research_sightings
       (object_id, run_id, family, tier, completeness, original_urls, content, content_hash, disagrees, meta, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10::jsonb, $11)
     ON CONFLICT (object_id, family) DO UPDATE
       SET run_id = COALESCE(excluded.run_id, research_sightings.run_id),
           tier = excluded.tier,
           completeness = excluded.completeness,
           original_urls = (
             SELECT array_agg(DISTINCT u) FROM unnest(research_sightings.original_urls || excluded.original_urls) AS u
           ),
           content = excluded.content,
           content_hash = excluded.content_hash,
           disagrees = excluded.disagrees,
           meta = research_sightings.meta || excluded.meta,
           fetched_at = GREATEST(research_sightings.fetched_at, excluded.fetched_at)`,
    [
      objectId,
      runId,
      o.family,
      o.tier,
      o.completeness,
      o.originalUrl ? [o.originalUrl] : [],
      o.content,
      hash,
      disagrees,
      JSON.stringify(o.meta ?? {}),
      o.fetchedAt,
    ],
  );

  if (becameBest) {
    // A new best reading changes what every other copy is measured against.
    const others = await tx.many<{ id: string; content: string; completeness: EvidenceCompleteness }>(
      'SELECT id, content, completeness FROM research_sightings WHERE object_id = $1 AND family <> $2',
      [objectId, o.family],
    );
    for (const other of others) {
      await tx.query('UPDATE research_sightings SET disagrees = $2 WHERE id = $1', [
        other.id,
        copiesDisagree({ content: o.content, completeness: o.completeness }, other),
      ]);
    }
  }

  if (runId) {
    await tx.query(
      'INSERT INTO research_run_objects (run_id, object_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [runId, objectId],
    );
  }

  return { objectId, created: Boolean(inserted), becameBest, disagrees };
}

export async function getObjectByKey(ownerId: string, objectKey: string): Promise<ResearchObjectRow | null> {
  return mapRow<ResearchObjectRow>(
    await queryOne('SELECT * FROM research_objects WHERE owner_id = $1 AND object_key = $2', [ownerId, objectKey]),
  );
}

export async function sightingsOf(objectId: string): Promise<ResearchSightingRow[]> {
  return mapRows<ResearchSightingRow>(
    await query('SELECT * FROM research_sightings WHERE object_id = $1 ORDER BY first_seen_at', [objectId]),
  );
}

export interface RunEvidence extends ResearchObjectRow {
  families: SourceFamily[];
  disagreeingFamilies: SourceFamily[];
}

/** What a run gathered, each object with the families that saw it. */
export async function runEvidence(
  runId: string,
  filter: { author?: string | null; kinds?: string[]; limit?: number } = {},
): Promise<RunEvidence[]> {
  return mapRows<RunEvidence>(
    await query(
      `SELECT o.*,
              array_agg(s.family ORDER BY s.family) AS families,
              coalesce(array_agg(s.family ORDER BY s.family) FILTER (WHERE s.disagrees), '{}') AS disagreeing_families
         FROM research_run_objects ro
         JOIN research_objects o ON o.id = ro.object_id
         JOIN research_sightings s ON s.object_id = o.id
        WHERE ro.run_id = $1
          AND ($2::text IS NULL OR lower(o.author) = lower($2))
          AND ($3::text[] IS NULL OR o.kind = ANY($3))
        GROUP BY o.id
        ORDER BY o.published_at DESC NULLS LAST, o.first_seen_at DESC
        LIMIT $4`,
      [runId, filter.author ?? null, filter.kinds ?? null, Math.min(5_000, filter.limit ?? 1_000)],
    ),
  );
}

/** How many objects a run gathered, by the family that holds each one's text. */
export async function runCoverage(runId: string): Promise<{ family: SourceFamily; objects: number; confirmed: number }[]> {
  return mapRows(
    await query(
      `SELECT o.best_family AS family, count(*)::int AS objects,
              count(*) FILTER (WHERE o.confirmed_on_platform)::int AS confirmed
         FROM research_run_objects ro JOIN research_objects o ON o.id = ro.object_id
        WHERE ro.run_id = $1
        GROUP BY o.best_family ORDER BY 2 DESC`,
      [runId],
    ),
  );
}

// ── Source health ────────────────────────────────────────────────────────────

export interface SourceHealthRow {
  family: SourceFamily;
  state: SourceAvailability;
  detail: string | null;
  failures: number;
  openUntil: string | null;
  lastOkAt: string | null;
  checkedAt: string;
}

export async function sourceHealth(family: SourceFamily): Promise<SourceHealthRow | null> {
  return mapRow<SourceHealthRow>(await queryOne('SELECT * FROM research_source_health WHERE family = $1', [family]));
}

export async function allSourceHealth(): Promise<SourceHealthRow[]> {
  return mapRows<SourceHealthRow>(await query('SELECT * FROM research_source_health ORDER BY family'));
}

/**
 * Records how a source answered.
 *
 * `openForMs` holds the source closed that long: a bot check or a string of
 * failures is not asked again on every run. Success clears the count.
 */
export async function noteSource(
  family: SourceFamily,
  state: SourceAvailability,
  detail: string | null,
  openForMs = 0,
): Promise<void> {
  const ok = state === 'AVAILABLE';
  await query(
    `INSERT INTO research_source_health (family, state, detail, failures, open_until, last_ok_at, checked_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN 0 ELSE 1 END,
             CASE WHEN $5::int > 0 THEN now() + ($5::int * interval '1 millisecond') ELSE NULL END,
             CASE WHEN $4 THEN now() ELSE NULL END, now())
     ON CONFLICT (family) DO UPDATE
       SET state = excluded.state,
           detail = excluded.detail,
           failures = CASE WHEN $4 THEN 0 ELSE research_source_health.failures + 1 END,
           open_until = excluded.open_until,
           last_ok_at = COALESCE(excluded.last_ok_at, research_source_health.last_ok_at),
           checked_at = now()`,
    [family, state, detail?.slice(0, 1_000) ?? null, ok, Math.max(0, Math.round(openForMs))],
  );
}
