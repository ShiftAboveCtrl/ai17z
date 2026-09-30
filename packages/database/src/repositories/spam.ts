/**
 * The spam record: verdicts on inbound posts, campaigns (templates), and what
 * is known about the accounts that send them. See `packages/runtime/src/spam.ts`
 * for how a verdict is reached; this only keeps and counts.
 */
import { query, queryOne, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

export const SPAM_VERDICT_VALUES = ['SPAM', 'SUSPECT', 'CLEAN'] as const;
export const SPAM_DECIDERS = ['CLASSIFIER', 'OWNER'] as const;

/** How many distinct author handles a template remembers by name. The count is exact beyond it. */
const ACTOR_NAMES_KEPT = 50;

export interface SpamTemplateRow {
  id: string;
  accountId: string;
  fingerprint: string;
  sample: string;
  items: number;
  actors: number;
  actorHandles: string[];
  ownerSpam: number;
  ownerNotSpam: number;
  firstSeen: string;
  lastSeen: string;
}

export interface SpamActorRow {
  accountId: string;
  handleKey: string;
  spamItems: number;
  cleanItems: number;
  ownerSpam: number;
  ownerNotSpam: number;
  muted: boolean;
}

export function handleKey(handle: string | null | undefined): string {
  return (handle ?? '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Counts one more post with this text, and its author if new to it.
 *
 * Called before judging, so the third account to paste a text is judged as
 * the third.
 */
export async function noteTemplate(
  tx: Tx,
  input: { accountId: string; fingerprint: string; sample: string; author: string },
): Promise<SpamTemplateRow> {
  const row = await tx.one(
    `INSERT INTO spam_templates (account_id, fingerprint, sample, items, actors, actor_handles)
     VALUES ($1, $2, left($3, 300), 1, CASE WHEN $4 = '' THEN 0 ELSE 1 END,
             CASE WHEN $4 = '' THEN '{}'::text[] ELSE ARRAY[$4] END)
     ON CONFLICT (account_id, fingerprint) DO UPDATE SET
       items = spam_templates.items + 1,
       actors = spam_templates.actors +
         CASE WHEN $4 = '' OR $4 = ANY (spam_templates.actor_handles) THEN 0
              WHEN cardinality(spam_templates.actor_handles) >= ${ACTOR_NAMES_KEPT} THEN 0
              ELSE 1 END,
       actor_handles = CASE
         WHEN $4 = '' OR $4 = ANY (spam_templates.actor_handles)
           OR cardinality(spam_templates.actor_handles) >= ${ACTOR_NAMES_KEPT} THEN spam_templates.actor_handles
         ELSE array_append(spam_templates.actor_handles, $4) END,
       last_seen = now()
     RETURNING *`,
    [input.accountId, input.fingerprint, input.sample, input.author],
  );
  return mapRow<SpamTemplateRow>(row)!;
}

export async function getActor(accountId: string, handle: string): Promise<SpamActorRow | null> {
  return mapRow<SpamActorRow>(
    await queryOne(`SELECT * FROM spam_actors WHERE account_id = $1 AND handle_key = $2`, [accountId, handleKey(handle)]),
  );
}

export async function noteActorVerdict(tx: Tx, accountId: string, handle: string, spam: boolean): Promise<void> {
  const key = handleKey(handle);
  if (!key) return;
  await tx.many(
    `INSERT INTO spam_actors (account_id, handle_key, spam_items, clean_items)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, handle_key) DO UPDATE SET
       spam_items = spam_actors.spam_items + excluded.spam_items,
       clean_items = spam_actors.clean_items + excluded.clean_items,
       updated_at = now()`,
    [accountId, key, spam ? 1 : 0, spam ? 0 : 1],
  );
}

export async function recordVerdict(
  tx: Tx,
  input: { eventId: string; accountId: string; verdict: string; score: number; reasons: string[]; templateId: string | null },
): Promise<void> {
  await tx.many(
    `INSERT INTO inbound_spam (event_id, account_id, verdict, score, reasons, template_id, decided_by, classifier_verdict)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'CLASSIFIER', $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [input.eventId, input.accountId, input.verdict, input.score, JSON.stringify(input.reasons), input.templateId],
  );
}

export interface InboundVerdictRow {
  eventId: string;
  accountId: string;
  verdict: string;
  score: number;
  reasons: string[];
  templateId: string | null;
  decidedBy: string;
  classifierVerdict: string;
}

export async function verdictFor(eventId: string, tx?: Tx): Promise<InboundVerdictRow | null> {
  const sql = `SELECT * FROM inbound_spam WHERE event_id = $1`;
  return mapRow<InboundVerdictRow>(tx ? await tx.one(sql, [eventId]) : await queryOne(sql, [eventId]));
}

/**
 * The owner's word on one post.
 *
 * Applies to that post. It also counts once toward its template and its
 * author, and a verdict changed from one side to the other moves its count
 * across rather than counting twice.
 */
export async function ownerLabel(eventId: string, label: 'SPAM' | 'NOT_SPAM'): Promise<InboundVerdictRow | null> {
  const before = await verdictFor(eventId);
  if (!before) return null;
  const wasOwner = before.decidedBy === 'OWNER' ? (before.verdict === 'SPAM' ? 'SPAM' : 'NOT_SPAM') : null;
  if (wasOwner === label) return before;
  const verdict = label === 'SPAM' ? 'SPAM' : 'CLEAN';
  const spamDelta = (label === 'SPAM' ? 1 : 0) - (wasOwner === 'SPAM' ? 1 : 0);
  const notDelta = (label === 'NOT_SPAM' ? 1 : 0) - (wasOwner === 'NOT_SPAM' ? 1 : 0);
  await query(
    `UPDATE inbound_spam SET verdict = $2, decided_by = 'OWNER', updated_at = now() WHERE event_id = $1`,
    [eventId, verdict],
  );
  if (before.templateId) {
    await query(
      `UPDATE spam_templates SET owner_spam = greatest(0, owner_spam + $2), owner_not_spam = greatest(0, owner_not_spam + $3) WHERE id = $1`,
      [before.templateId, spamDelta, notDelta],
    );
  }
  const author = await queryOne<{ handle: string | null }>(`SELECT remote_author_handle AS handle FROM events WHERE id = $1`, [eventId]);
  const key = handleKey(author?.handle);
  if (key) {
    await query(
      `INSERT INTO spam_actors (account_id, handle_key, owner_spam, owner_not_spam) VALUES ($1, $2, greatest(0, $3), greatest(0, $4))
       ON CONFLICT (account_id, handle_key) DO UPDATE SET
         owner_spam = greatest(0, spam_actors.owner_spam + $3),
         owner_not_spam = greatest(0, spam_actors.owner_not_spam + $4),
         updated_at = now()`,
      [before.accountId, key, spamDelta, notDelta],
    );
  }
  return verdictFor(eventId);
}

export async function setMuted(accountId: string, handle: string, muted: boolean): Promise<void> {
  const key = handleKey(handle);
  if (!key) return;
  await query(
    `INSERT INTO spam_actors (account_id, handle_key, muted) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, handle_key) DO UPDATE SET muted = excluded.muted, updated_at = now()`,
    [accountId, key, muted],
  );
}

export interface SpamMetrics {
  since: string;
  seen: number;
  filtered: number;
  suspect: number;
  campaigns: number;
  collapsed: number;
  spamActors: number;
  mutedActors: number;
  ownerCorrections: number;
  falsePositiveCorrections: number;
}

/** What the defense did over a window, for the owner. Never exposed through an agent. */
export async function metrics(accountIds: string[], sinceIso: string): Promise<SpamMetrics> {
  const row = await queryOne<Record<string, string>>(
    `SELECT count(*)::text AS seen,
            count(*) FILTER (WHERE verdict = 'SPAM')::text AS filtered,
            count(*) FILTER (WHERE verdict = 'SUSPECT')::text AS suspect,
            count(*) FILTER (WHERE decided_by = 'OWNER')::text AS owner_corrections,
            count(*) FILTER (WHERE decided_by = 'OWNER' AND verdict = 'CLEAN' AND classifier_verdict = 'SPAM')::text AS false_positives
       FROM inbound_spam WHERE account_id = ANY ($1::uuid[]) AND created_at >= $2`,
    [accountIds, sinceIso],
  );
  const campaigns = await queryOne<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE items > 1)::text AS campaigns,
            coalesce(sum(items - 1) FILTER (WHERE items > 1), 0)::text AS collapsed
       FROM spam_templates t
      WHERE account_id = ANY ($1::uuid[]) AND last_seen >= $2
        AND EXISTS (SELECT 1 FROM inbound_spam s WHERE s.template_id = t.id AND s.verdict = 'SPAM')`,
    [accountIds, sinceIso],
  );
  const actors = await queryOne<Record<string, string>>(
    `SELECT count(*) FILTER (WHERE spam_items > 0)::text AS spam_actors, count(*) FILTER (WHERE muted)::text AS muted
       FROM spam_actors WHERE account_id = ANY ($1::uuid[])`,
    [accountIds],
  );
  return {
    since: sinceIso,
    seen: Number(row?.seen ?? 0),
    filtered: Number(row?.filtered ?? 0),
    suspect: Number(row?.suspect ?? 0),
    campaigns: Number(campaigns?.campaigns ?? 0),
    collapsed: Number(campaigns?.collapsed ?? 0),
    spamActors: Number(actors?.spam_actors ?? 0),
    mutedActors: Number(actors?.muted ?? 0),
    ownerCorrections: Number(row?.owner_corrections ?? 0),
    falsePositiveCorrections: Number(row?.false_positives ?? 0),
  };
}

export interface QuarantinedRow {
  eventId: string;
  authorHandle: string | null;
  text: string;
  url: string | null;
  score: number;
  reasons: string[];
  decidedBy: string;
  templateItems: number | null;
  templateActors: number | null;
  createdAt: string;
}

export async function quarantined(accountIds: string[], limit = 50): Promise<QuarantinedRow[]> {
  return mapRows<QuarantinedRow>(
    await query(
      `SELECT s.event_id, e.remote_author_handle AS author_handle, left(e.text, 400) AS text, e.remote_url AS url,
              s.score, s.reasons, s.decided_by, t.items AS template_items, t.actors AS template_actors, s.created_at
         FROM inbound_spam s JOIN events e ON e.id = s.event_id LEFT JOIN spam_templates t ON t.id = s.template_id
        WHERE s.account_id = ANY ($1::uuid[]) AND s.verdict = 'SPAM'
        ORDER BY s.created_at DESC LIMIT $2`,
      [accountIds, limit],
    ),
  );
}
