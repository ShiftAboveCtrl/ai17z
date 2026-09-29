/**
 * What an agent can find out about itself, for its owner.
 *
 * Read only and per agent: every query here is scoped by `agent_id`, so one
 * agent's owner chat can never read another agent's rows by asking about them.
 * Nothing here is new state. It is the questions an owner asks ("what did you
 * do this week", "why did you not answer that") put to rows the runtime
 * already writes.
 */
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface ActivityCounts {
  since: string;
  published: { type: string; count: number }[];
  dryRuns: number;
  failedActions: number;
  jobs: { status: string; count: number }[];
  inbound: { type: string; count: number }[];
  distinctPeople: number;
  conversationsContinued: number;
}

/** What the agent did and was asked, over one window. */
export async function activitySince(agentId: string, sinceIso: string): Promise<ActivityCounts> {
  const [published, other, jobs, inbound, people, continued] = await Promise.all([
    query<{ type: string; count: string }>(
      `SELECT type, count(*)::text AS count FROM actions
        WHERE agent_id = $1 AND status = 'EXECUTED' AND NOT dry_run AND executed_at >= $2
        GROUP BY type ORDER BY count(*) DESC`,
      [agentId, sinceIso],
    ),
    queryOne<{ dry: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE dry_run)::text AS dry,
              count(*) FILTER (WHERE status = 'FAILED')::text AS failed
         FROM actions WHERE agent_id = $1 AND created_at >= $2`,
      [agentId, sinceIso],
    ),
    query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM jobs
        WHERE agent_id = $1 AND created_at >= $2 AND NOT dry_run
        GROUP BY status ORDER BY count(*) DESC`,
      [agentId, sinceIso],
    ),
    query<{ type: string; count: string }>(
      `SELECT e.type, count(DISTINCT e.id)::text AS count
         FROM events e JOIN agent_accounts l ON l.account_id = e.account_id
        WHERE l.agent_id = $1 AND e.ingested_at >= $2
          AND coalesce((e.payload ->> 'rehearsal')::boolean, false) = false
        GROUP BY e.type ORDER BY count(DISTINCT e.id) DESC`,
      [agentId, sinceIso],
    ),
    queryOne<{ count: string }>(
      `SELECT count(DISTINCT lower(e.remote_author_handle))::text AS count
         FROM actions a JOIN jobs j ON j.id = a.job_id JOIN events e ON e.id = j.event_id
        WHERE a.agent_id = $1 AND a.status = 'EXECUTED' AND NOT a.dry_run AND a.executed_at >= $2
          AND e.remote_author_handle IS NOT NULL`,
      [agentId, sinceIso],
    ),
    // A conversation counts as continued when the agent published into it
    // more than once in the window: somebody answered and it answered back.
    queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT j.conversation_id FROM actions a JOIN jobs j ON j.id = a.job_id
          WHERE a.agent_id = $1 AND a.status = 'EXECUTED' AND NOT a.dry_run AND a.executed_at >= $2
            AND j.conversation_id IS NOT NULL
          GROUP BY j.conversation_id HAVING count(*) > 1) c`,
      [agentId, sinceIso],
    ),
  ]);
  return {
    since: sinceIso,
    published: published.map((r) => ({ type: r.type, count: Number(r.count) })),
    dryRuns: Number(other?.dry ?? 0),
    failedActions: Number(other?.failed ?? 0),
    jobs: jobs.map((r) => ({ status: r.status, count: Number(r.count) })),
    inbound: inbound.map((r) => ({ type: r.type, count: Number(r.count) })),
    distinctPeople: Number(people?.count ?? 0),
    conversationsContinued: Number(continued?.count ?? 0),
  };
}

export interface RecentAction {
  id: string;
  jobId: string;
  type: string;
  text: string | null;
  url: string | null;
  targetRef: string | null;
  inReplyTo: string | null;
  executedAt: string | null;
}

/** The last things it actually published. Dry runs are not things it did. */
export async function recentActions(agentId: string, limit = 10): Promise<RecentAction[]> {
  return mapRows<RecentAction>(
    await query(
      `SELECT a.id, a.job_id, a.type, a.payload ->> 'text' AS text, a.remote_action_url AS url,
              a.target_ref, e.remote_author_handle AS in_reply_to, a.executed_at
         FROM actions a LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN events e ON e.id = j.event_id
        WHERE a.agent_id = $1 AND a.status = 'EXECUTED' AND NOT a.dry_run
        ORDER BY a.executed_at DESC NULLS LAST LIMIT $2`,
      [agentId, limit],
    ),
  );
}

export interface FailureGroup {
  errorClass: string | null;
  status: string;
  count: number;
  lastError: string | null;
  lastAt: string;
  lastJobId: string;
}

/** Failed and held work over a window, grouped by what went wrong. */
export async function jobFailures(agentId: string, sinceIso: string): Promise<FailureGroup[]> {
  return mapRows<FailureGroup>(
    await query(
      `SELECT DISTINCT ON (status, error_class, left(coalesce(last_error, ''), 80))
              error_class, status,
              count(*) OVER (PARTITION BY status, error_class, left(coalesce(last_error, ''), 80))::int AS count,
              last_error, updated_at AS last_at, id AS last_job_id
         FROM jobs
        WHERE agent_id = $1 AND updated_at >= $2 AND NOT dry_run
          AND status IN ('PERMANENT_FAILURE', 'REVIEW_REQUIRED', 'RETRYABLE_FAILURE')
        ORDER BY status, error_class, left(coalesce(last_error, ''), 80), updated_at DESC
        LIMIT 20`,
      [agentId, sinceIso],
    ),
  );
}

export interface OwnerDecision {
  kind: 'APPROVAL' | 'ENGAGEMENT' | 'SIGNAL';
  decision: string;
  subject: string | null;
  note: string | null;
  at: string;
}

/** What the owner approved, edited or turned down. */
export async function ownerDecisions(agentId: string, sinceIso: string, limit = 20): Promise<OwnerDecision[]> {
  const rows = await query<{ kind: OwnerDecision['kind']; decision: string; subject: string | null; note: string | null; at: string }>(
    `(SELECT 'APPROVAL' AS kind, ap.status AS decision, left(coalesce(ap.edited_output, ap.original_output), 200) AS subject,
             ap.note, ap.decided_at AS at
        FROM approvals ap JOIN jobs j ON j.id = ap.job_id
       WHERE j.agent_id = $1 AND ap.decided_at >= $2)
     UNION ALL
     (SELECT 'SIGNAL', CASE WHEN s.last_rejected_at = s.last_decision_at THEN 'REJECTED' ELSE 'ACCEPTED' END,
             s.family, s.last_reason, s.last_decision_at
        FROM owner_decision_signals s
       WHERE s.agent_id = $1 AND s.last_decision_at >= $2)
     ORDER BY at DESC LIMIT $3`,
    [agentId, sinceIso, limit],
  );
  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
}

export interface ConfigChange {
  what: string;
  version: number | null;
  note: string | null;
  at: string;
}

/** Persona and policy versions and audited setting changes, newest first. */
export async function recentChanges(agentId: string, sinceIso: string, limit = 20): Promise<ConfigChange[]> {
  const rows = await query<{ what: string; version: number | null; note: string | null; at: string }>(
    `(SELECT 'persona' AS what, pv.version, pv.change_note AS note, pv.created_at AS at
        FROM persona_versions pv JOIN personas p ON p.id = pv.persona_id
       WHERE p.agent_id = $1 AND pv.created_at >= $2)
     UNION ALL
     (SELECT 'policy', v.version, v.change_note, v.created_at
        FROM policy_versions v JOIN policies p ON p.id = v.policy_id
       WHERE p.agent_id = $1 AND v.created_at >= $2)
     UNION ALL
     (SELECT a.action, NULL, NULL, a.at FROM audit_events a
       WHERE a.at >= $2 AND (a.entity_id = $1::text OR a.data ->> 'agentId' = $1::text)
         AND a.action NOT LIKE 'persona.%' AND a.action NOT LIKE 'policy.%')
     ORDER BY at DESC LIMIT $3`,
    [agentId, sinceIso, limit],
  );
  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
}

export interface EventLookup {
  eventId: string;
  type: string;
  authorHandle: string | null;
  text: string;
  url: string | null;
  occurredAt: string | null;
  ingestedAt: string;
  skipReason: string | null;
  jobs: { id: string; status: string; actionType: string; dryRun: boolean; lastError: string | null }[];
}

/**
 * A post this agent's accounts recorded, found by its status id, and what
 * became of it for this agent.
 */
export async function eventForAgent(agentId: string, remoteId: string): Promise<EventLookup | null> {
  const event = mapRow<Omit<EventLookup, 'jobs' | 'skipReason'>>(
    await queryOne(
      `SELECT e.id AS event_id, e.type, e.remote_author_handle AS author_handle, e.text, e.remote_url AS url,
              e.occurred_at, e.ingested_at
         FROM events e JOIN agent_accounts l ON l.account_id = e.account_id
        WHERE l.agent_id = $1 AND (e.remote_event_id = $2 OR e.remote_message_id = $2)
          AND coalesce((e.payload ->> 'rehearsal')::boolean, false) = false
        ORDER BY e.ingested_at LIMIT 1`,
      [agentId, remoteId],
    ),
  );
  if (!event) return null;
  const [jobs, skip] = await Promise.all([
    query<{ id: string; status: string; action_type: string; dry_run: boolean; last_error: string | null }>(
      `SELECT id, status, action_type, dry_run, last_error FROM jobs
        WHERE agent_id = $1 AND event_id = $2 ORDER BY created_at`,
      [agentId, event.eventId],
    ),
    queryOne<{ reason: string }>(`SELECT reason FROM event_agent_skips WHERE event_id = $1 AND agent_id = $2`, [
      event.eventId,
      agentId,
    ]),
  ]);
  return {
    ...event,
    skipReason: skip?.reason ?? null,
    jobs: jobs.map((j) => ({ id: j.id, status: j.status, actionType: j.action_type, dryRun: j.dry_run, lastError: j.last_error })),
  };
}

/** An action of this agent's, by its own id, its job, or the post it sent. */
export async function actionForAgent(agentId: string, ref: string): Promise<{ id: string; jobId: string } | null> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const row = await queryOne<{ id: string; job_id: string }>(
    `SELECT a.id, a.job_id FROM actions a
      WHERE a.agent_id = $1 AND NOT a.dry_run
        AND (${uuid ? 'a.id = $2::uuid OR a.job_id = $2::uuid OR ' : ''}a.remote_action_id = $2 OR a.target_ref = $2)
      ORDER BY a.executed_at DESC NULLS LAST LIMIT 1`,
    [agentId, ref],
  );
  return row ? { id: row.id, jobId: row.job_id } : null;
}

/** Readings of what the agent published, over one window. */
export async function outcomesSince(
  agentId: string,
  sinceIso: string,
): Promise<{ measured: number; views: number | null; likes: number; replies: number; reposts: number }> {
  const row = await queryOne<{ measured: string; views: string | null; likes: string; replies: string; reposts: string }>(
    `SELECT count(*)::text AS measured, sum(views)::text AS views, coalesce(sum(likes), 0)::text AS likes,
            coalesce(sum(replies), 0)::text AS replies, coalesce(sum(reposts), 0)::text AS reposts
       FROM (SELECT DISTINCT ON (p.remote_post_id) p.views, p.likes, p.replies, p.reposts
               FROM post_analytics p JOIN actions a ON a.id = p.action_id
              WHERE p.agent_id = $1 AND a.executed_at >= $2
              ORDER BY p.remote_post_id, p.observed_at DESC) latest`,
    [agentId, sinceIso],
  );
  return {
    measured: Number(row?.measured ?? 0),
    // Absent is not zero: a window with no view readings has no view count.
    views: row?.views === null || row?.views === undefined ? null : Number(row.views),
    likes: Number(row?.likes ?? 0),
    replies: Number(row?.replies ?? 0),
    reposts: Number(row?.reposts ?? 0),
  };
}
