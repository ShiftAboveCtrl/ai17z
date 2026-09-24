import { query } from '../pool';
import { mapRows } from '../mapper';

/**
 * What the radar found, and what became of it.
 *
 * This is a read model, not a store. Every field below already exists
 * somewhere -- the post in `events`, which monitor saw it in
 * `event_discoveries`, what the agent decided in `jobs`, what it actually said
 * in `actions`, and the thread in `conversations` and `messages`. Adding a
 * table would mean a second copy of the truth, and the reason the reconciler
 * merges on the remote status id is that there is exactly one.
 *
 * The question it exists to answer is the one nobody could answer before:
 * of everything the mention search scrolled past, who did we reply to, who did
 * we not, which of these is somebody continuing a conversation, and which is a
 * person the agent has never spoken to.
 */

export type MentionState =
  /** A reply went out. `replyText` and `replyUrl` say what and where. */
  | 'REPLIED'
  /** In the pipeline right now. */
  | 'WORKING'
  /** Held for a person to approve or look at. */
  | 'NEEDS_REVIEW'
  /** The agent decided not to answer. `decision` carries the reasons. */
  | 'DECLINED'
  /** Tried and failed. */
  | 'FAILED'
  /** Rehearsed only; nothing was sent. */
  | 'DRY_RUN'
  /**
   * Recorded, but no work was ever created for it: the agent is monitor-only,
   * the link is not triggered by this event type, or nothing is linked at all.
   */
  | 'NOT_ACTIONED';

export interface MentionRow {
  eventId: string;
  type: string;
  authorHandle: string | null;
  authorDisplay: string | null;
  text: string;
  url: string | null;
  occurredAt: string | null;
  ingestedAt: string;
  /** Every monitor that found this post, in the order they first saw it. */
  foundBy: string[];
  state: MentionState;
  jobId: string | null;
  jobStatus: string | null;
  /** The engagement verdict, when one was reached. */
  decision: { decision: string; value: number; reason: string } | null;
  replyText: string | null;
  replyUrl: string | null;
  repliedAt: string | null;
  conversationId: string | null;
  /** Messages in this thread, both directions, including this one. */
  threadMessages: number;
  /** Times the agent has spoken in this thread. */
  ourTurns: number;
  /** Posts from this person the agent has seen before this one. */
  priorFromPerson: number;
}

/**
 * Which kinds of event count as somebody writing to the agent.
 *
 * A keyword match is not one. It is something the agent went looking for,
 * and it arrives in numbers no direct inbound ever does: measured on a live
 * installation, 2,106 keyword matches against 15 mentions and replies in the
 * same 72 hours. Kept available because an owner may want to see what the
 * radar found, and separable because otherwise it drowns everything else.
 */
export const DIRECT_INBOUND_TYPES = ['MENTION', 'REPLY', 'DIRECT_MESSAGE'] as const;
const ALL_INBOUND_TYPES = [...DIRECT_INBOUND_TYPES, 'KEYWORD_MATCH'] as const;

export interface MentionFilter {
  agentId?: string | null;
  accountId?: string | null;
  /** Restrict to one state. Omit for everything. */
  state?: MentionState | null;
  /**
   * Only what somebody addressed to the agent.
   *
   * The inbox exists to answer "who said something and did they get an
   * answer", and with the radar running that question is unanswerable from a
   * list the radar dominates.
   */
  directOnly?: boolean | null;
  /**
   * Everything one person said, rather than everything everybody said.
   *
   * Added so the People screen can answer "what has passed between us" out of
   * the same read model the inbox uses. A second query joining events, jobs and
   * actions would be a second answer to a question this one already answers,
   * and the two would drift.
   *
   * Matched on the handle rather than the numeric id because an event recorded
   * before the radar could see ids has no id to match on -- and a person's
   * history should not begin again the day AI17Z learned who they were. The id
   * is the better key and is used where the record is being written; this is a
   * read of what is already there.
   */
  authorHandle?: string | null;
  limit?: number;
}

/**
 * One row per post the radar found.
 *
 * Written as a single statement on purpose: a page of thirty mentions asking
 * five questions each is a hundred and fifty round trips, and this runs behind
 * a screen somebody refreshes.
 */
export async function listMentions(filter: MentionFilter): Promise<MentionRow[]> {
  const rows = await query(
    `WITH found AS (
       SELECT event_id, array_agg(DISTINCT source_kind) AS found_by
         FROM event_discoveries GROUP BY event_id
     ),
     latest_job AS (
       SELECT DISTINCT ON (event_id) event_id, id, status, conversation_id, agent_id, dry_run,
              resolved_context -> 'meta' -> 'engagement' AS engagement
         FROM jobs
        WHERE ($1::uuid IS NULL OR agent_id = $1)
        ORDER BY event_id, created_at DESC
     )
     SELECT e.id                       AS event_id,
            e.type,
            e.remote_author_handle     AS author_handle,
            e.remote_author_display    AS author_display,
            e.text,
            e.remote_url               AS url,
            e.occurred_at,
            e.ingested_at,
            COALESCE(f.found_by, ARRAY[]::text[]) AS found_by,
            j.id                       AS job_id,
            j.status                   AS job_status,
            j.dry_run,
            j.engagement               AS decision,
            a.payload ->> 'text'       AS reply_text,
            a.remote_action_url        AS reply_url,
            a.executed_at              AS replied_at,
            j.conversation_id,
            COALESCE(m.total, 0)       AS thread_messages,
            COALESCE(m.ours, 0)        AS our_turns,
            COALESCE(p.seen, 0)        AS prior_from_person
       FROM events e
       LEFT JOIN found f ON f.event_id = e.id
       LEFT JOIN latest_job j ON j.event_id = e.id
       LEFT JOIN LATERAL (
         SELECT id, payload, remote_action_url, executed_at
           FROM actions
          WHERE job_id = j.id AND status = 'EXECUTED'
          ORDER BY executed_at DESC NULLS LAST
          LIMIT 1
       ) a ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS total, count(*) FILTER (WHERE direction = 'OUTBOUND') AS ours
           FROM messages WHERE conversation_id = j.conversation_id
       ) m ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS seen
           FROM events earlier
          WHERE earlier.remote_author_handle IS NOT NULL
            AND lower(earlier.remote_author_handle) = lower(e.remote_author_handle)
            AND earlier.ingested_at < e.ingested_at
            AND ($2::uuid IS NULL OR earlier.account_id = $2)
       ) p ON true
      WHERE e.type = ANY ($5::text[])
        AND ($2::uuid IS NULL OR e.account_id = $2)
        AND ($1::uuid IS NULL OR j.agent_id = $1 OR j.id IS NULL)
        AND ($4::text IS NULL OR lower(e.remote_author_handle) = lower($4))
        -- An event whose account has been deleted and which never produced a
        -- job is residue, not a mention: there is no account it arrived on and
        -- no agent that could ever answer it. events.account_id is ON DELETE
        -- SET NULL, deliberately -- removing an account must not erase the
        -- history of what it did -- so these accumulate, and without this the
        -- inbox fills with things nobody can act on. Anything that did produce
        -- a job is kept whatever became of the account.
        AND (e.account_id IS NOT NULL OR j.id IS NOT NULL)
        /*
          A rehearsal is not a mention.

          The Response Lab manufactures one so its rehearsal runs the ordinary
          pipeline, which is what makes the lab worth trusting. Left in, every
          trial of an agent would appear here as somebody having written to it,
          and its dry-run draft as an answer that went out.
        */
        AND coalesce((e.payload ->> 'rehearsal')::boolean, false) = false
        /*
          The state filter, in SQL, ahead of the limit.

          It used to be applied in JavaScript after the LIMIT, which is only
          harmless while the newest rows are a mixture. They are not: with the
          radar running, the most recent two hundred events on a live
          installation were every one of them a keyword match, so asking for
          REPLIED took the newest forty, found no reply among them, and
          answered with an empty list. The three replies that had gone out
          were 449 events further back.

          An owner reading that concluded the agent had stopped answering
          people. It had not; the question was being asked of the wrong forty
          rows.
        */
        AND ($6::text IS NULL OR $6 = CASE
          WHEN j.status IS NULL THEN 'NOT_ACTIONED'
          WHEN j.status = 'EXECUTED' THEN 'REPLIED'
          WHEN j.status = 'DRY_RUN_COMPLETED' THEN 'DRY_RUN'
          WHEN j.status = 'CANCELLED' THEN 'DECLINED'
          WHEN j.status IN ('WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED') THEN 'NEEDS_REVIEW'
          WHEN j.status IN ('PERMANENT_FAILURE', 'RETRYABLE_FAILURE') THEN 'FAILED'
          ELSE 'WORKING'
        END)
      ORDER BY e.ingested_at DESC
      LIMIT $3`,
    [
      filter.agentId ?? null,
      filter.accountId ?? null,
      Math.min(filter.limit ?? 50, 200),
      filter.authorHandle ? filter.authorHandle.replace(/^@+/, '') : null,
      filter.directOnly ? [...DIRECT_INBOUND_TYPES] : [...ALL_INBOUND_TYPES],
      filter.state ?? null,
    ],
  );

  /*
    `stateOf` still decides the word, and the CASE above has to agree with it.
    `tests/integration/mentionsInbox.test.ts` holds one against the other for
    every job status there is, because two spellings of one mapping is exactly
    the thing that goes quietly wrong.
  */
  return mapRows<Omit<MentionRow, 'state'>>(rows).map((row) => ({
    ...row,
    state: stateOf(row.jobStatus),
  }));
}

/**
 * What happened to a mention, in a word.
 *
 * Job status is the machine's vocabulary -- eighteen values, several of which
 * mean "in flight at a different step". Somebody looking at an inbox wants to
 * know whether they answered this person, and the mapping is here rather than
 * in the query so it can be read.
 */
export function stateOf(jobStatus: string | null): MentionState {
  if (!jobStatus) return 'NOT_ACTIONED';
  switch (jobStatus) {
    case 'EXECUTED':
      return 'REPLIED';
    case 'DRY_RUN_COMPLETED':
      return 'DRY_RUN';
    case 'CANCELLED':
      return 'DECLINED';
    case 'WAITING_FOR_APPROVAL':
    case 'REVIEW_REQUIRED':
      return 'NEEDS_REVIEW';
    case 'PERMANENT_FAILURE':
    case 'RETRYABLE_FAILURE':
      return 'FAILED';
    default:
      // Everything else is one of the settled or in-flight pipeline states, all
      // of which mean the same thing to somebody reading an inbox.
      return 'WORKING';
  }
}

/** How many mentions are in each state, for the filter chips above the list. */
export async function countMentionStates(filter: MentionFilter): Promise<Record<MentionState, number>> {
  /*
    Counted over everything, not over a window.

    This used to count the newest two hundred rows, which on a live
    installation were two hundred keyword matches, so every chip read zero
    except DECLINED. A count that disagrees with the list beneath it is bad;
    a count that agrees with it and is wrong about the system is worse,
    because there is then nothing to notice.

    The window that remains is the caller's own `limit` on the list, which is
    about how much to render rather than about what is true.
  */
  const types = filter.directOnly ? [...DIRECT_INBOUND_TYPES] : [...ALL_INBOUND_TYPES];
  const rows = await query<{ state: string; n: string }>(
    `WITH latest_job AS (
       SELECT DISTINCT ON (event_id) event_id, agent_id, status
         FROM jobs
        WHERE ($1::uuid IS NULL OR agent_id = $1)
        ORDER BY event_id, created_at DESC
     )
     SELECT CASE
              WHEN j.status IS NULL THEN 'NOT_ACTIONED'
              WHEN j.status = 'EXECUTED' THEN 'REPLIED'
              WHEN j.status = 'DRY_RUN_COMPLETED' THEN 'DRY_RUN'
              WHEN j.status = 'CANCELLED' THEN 'DECLINED'
              WHEN j.status IN ('WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED') THEN 'NEEDS_REVIEW'
              WHEN j.status IN ('PERMANENT_FAILURE', 'RETRYABLE_FAILURE') THEN 'FAILED'
              ELSE 'WORKING'
            END AS state,
            count(*)::text AS n
       FROM events e
       LEFT JOIN latest_job j ON j.event_id = e.id
      WHERE e.type = ANY ($3::text[])
        AND ($2::uuid IS NULL OR e.account_id = $2)
        AND ($1::uuid IS NULL OR j.agent_id = $1 OR j.event_id IS NULL)
        AND ($4::text IS NULL OR lower(e.remote_author_handle) = lower($4))
        AND (e.account_id IS NOT NULL OR j.event_id IS NOT NULL)
        AND coalesce((e.payload ->> 'rehearsal')::boolean, false) = false
      GROUP BY 1`,
    [
      filter.agentId ?? null,
      filter.accountId ?? null,
      types,
      filter.authorHandle ? filter.authorHandle.replace(/^@+/, '') : null,
    ],
  );

  const counts = {
    REPLIED: 0,
    WORKING: 0,
    NEEDS_REVIEW: 0,
    DECLINED: 0,
    FAILED: 0,
    DRY_RUN: 0,
    NOT_ACTIONED: 0,
  } as Record<MentionState, number>;
  for (const row of rows) {
    if (row.state in counts) counts[row.state as MentionState] = Number(row.n);
  }
  return counts;
}
