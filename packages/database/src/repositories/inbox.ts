import { mapRows } from '../mapper';
import { query } from '../pool';
import { stateOf, type MentionState } from './mentions';

/**
 * One place to operate every agent an owner has.
 *
 * The Activity table already lists everything that happened, and that is the
 * problem it has: it answers "what occurred" and an owner is asking "what do I
 * need to do". Those produce different lists. A reply that went out perfectly
 * is the most interesting row in a log and the least interesting thing in an
 * inbox.
 *
 * So this is bucketed by what somebody would do about it, not by what kind of
 * record it is, and every row names its agent -- an owner with four agents
 * cannot act on "somebody needs approval".
 */

export const INBOX_BUCKETS = [
  /** Held for a person. Nothing moves until somebody decides. */
  'NEEDS_REVIEW',
  /** Somebody asked something and has not been answered. */
  'QUESTIONS',
  /** Addressed to the agent. */
  'MENTIONS',
  /** Somebody answered the agent, which is a conversation it is already in. */
  'REPLIES',
  /** Posts the agent went looking for rather than was sent. */
  'OUTREACH',
  /** Tried and did not work. */
  'ERRORS',
] as const;
export type InboxBucket = (typeof INBOX_BUCKETS)[number];

export interface InboxItem {
  eventId: string;
  agentId: string | null;
  agentName: string | null;
  type: string;
  authorHandle: string | null;
  text: string;
  url: string | null;
  occurredAt: string | null;
  ingestedAt: string;
  state: MentionState;
  jobId: string | null;
  jobStatus: string | null;
  /** What went wrong, when something did. The class, never a raw message. */
  errorClass: string | null;
  /** What the agent said, when it said anything. */
  replyText: string | null;
  replyUrl: string | null;
  repliedAt: string | null;
}

/** Whether a message is asking something rather than saying something. */
const ASKS = /\?|^(what|why|how|when|where|who|which|is|are|do|does|did|can|could|would|should|will)\b/i;

/**
 * Which bucket a row belongs in.
 *
 * Order matters and is the whole design. Something waiting on a person is in
 * NEEDS_REVIEW whatever else it also is, because that is the only bucket with
 * an action in it. A failure is next for the same reason. Only then does the
 * kind of message decide, and an unanswered question outranks a plain mention
 * because somebody is waiting for an answer to it.
 */
export function bucketOf(item: Pick<InboxItem, 'state' | 'type' | 'text'>): InboxBucket {
  if (item.state === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
  if (item.state === 'FAILED') return 'ERRORS';
  if (item.type === 'KEYWORD_MATCH') return 'OUTREACH';
  // An answered question is no longer a question anybody is waiting on.
  if (item.state !== 'REPLIED' && ASKS.test(item.text.trim())) return 'QUESTIONS';
  if (item.type === 'REPLY') return 'REPLIES';
  return 'MENTIONS';
}

/**
 * Everything across an owner's agents, in one statement.
 *
 * One query rather than one per agent: an owner with four agents refreshing a
 * screen should not cost four round trips, and the counts have to be consistent
 * with the list or the chips lie.
 */
export async function ownerInbox(ownerId: string, limit = 200): Promise<InboxItem[]> {
  const rows = await query(
    `WITH latest_job AS (
       SELECT DISTINCT ON (event_id) event_id, id, status, agent_id, error_class
         FROM jobs
        ORDER BY event_id, created_at DESC
     )
     SELECT e.id                    AS event_id,
            j.agent_id,
            ag.name                 AS agent_name,
            e.type,
            e.remote_author_handle  AS author_handle,
            e.text,
            e.remote_url            AS url,
            e.occurred_at,
            e.ingested_at,
            j.id                    AS job_id,
            j.status                AS job_status,
            j.error_class,
            a.payload ->> 'text'    AS reply_text,
            a.remote_action_url     AS reply_url,
            a.executed_at           AS replied_at
       FROM events e
       LEFT JOIN latest_job j ON j.event_id = e.id
       LEFT JOIN agents ag ON ag.id = j.agent_id
       LEFT JOIN accounts acc ON acc.id = e.account_id
       LEFT JOIN LATERAL (
         SELECT payload, remote_action_url, executed_at
           FROM actions
          WHERE job_id = j.id AND status = 'EXECUTED'
          ORDER BY executed_at DESC NULLS LAST
          LIMIT 1
       ) a ON true
      WHERE e.type IN ('MENTION', 'REPLY', 'DIRECT_MESSAGE', 'KEYWORD_MATCH')
        -- Owned through either side: an event belongs to this owner if its
        -- account does, or if the agent that worked it does. An account deleted
        -- since must not take its history out of the inbox.
        AND (acc.owner_id = $1 OR ag.owner_id = $1)
      ORDER BY e.ingested_at DESC
      LIMIT $2`,
    [ownerId, Math.min(limit, 500)],
  );

  return mapRows<Omit<InboxItem, 'state'>>(rows).map((row) => ({ ...row, state: stateOf(row.jobStatus) }));
}

/** How many are in each bucket, counted from the same rows the list shows. */
export function countBuckets(items: InboxItem[]): Record<InboxBucket, number> {
  const counts = Object.fromEntries(INBOX_BUCKETS.map((b) => [b, 0])) as Record<InboxBucket, number>;
  for (const item of items) counts[bucketOf(item)] += 1;
  return counts;
}
