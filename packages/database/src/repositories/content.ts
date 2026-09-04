import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface IdeaRow {
  id: string;
  agentId: string;
  kind: string;
  summary: string;
  detail: string;
  source: string;
  sourceHandle: string | null;
  score: number;
  status: string;
  usedAt: string | null;
  createdAt: string;
  /** The job currently drafting it, or the one that last tried. */
  jobId: string | null;
  /** How many times a post from this idea was attempted and not published. */
  attempts: number;
  /** Why the last attempt produced nothing, in words. */
  lastError: string;
  /**
   * The score after ageing, which is what actually decides what gets posted.
   * Shown to the owner because a list ordered differently from the queue is a
   * list that answers a question nobody asked.
   */
  effectiveScore: number;
}

export async function addIdea(input: {
  agentId: string;
  kind?: string;
  summary: string;
  detail?: string;
  source?: string;
  sourceJobId?: string | null;
  sourceHandle?: string | null;
  score?: number;
}): Promise<IdeaRow> {
  const row = await queryOne(
    `INSERT INTO content_ideas (agent_id, kind, summary, detail, source, source_job_id, source_handle, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.agentId,
      input.kind ?? 'observation',
      input.summary.slice(0, 500),
      input.detail ?? '',
      input.source ?? 'manual',
      input.sourceJobId ?? null,
      input.sourceHandle ?? null,
      input.score ?? 50,
    ],
  );
  return mapRow<IdeaRow>(row) as IdeaRow;
}

/**
 * How many points a harvested idea loses per day.
 *
 * An idea comes from something that happened, so it is worth less the further
 * that thing recedes: "somebody asked about the launch" is a good post the same
 * week and an odd one a month later. Five a day means a 60 turns into a 30 in
 * under a week, which is roughly how long a conversation stays current.
 *
 * Nothing an owner typed decays. That is a decision, not an observation, and it
 * waits until it is used.
 */
const DECAY_PER_DAY = 5;

/**
 * How long a harvested idea stays in the backlog at all.
 *
 * Past this it is set aside rather than left to sit at a score that will never
 * win. Fourteen days is after decay has taken any realistic score below the
 * floor, so this is a tidy-up rather than a second, competing rule.
 */
export const IDEA_SHELF_LIFE_DAYS = 14;

/** The decayed score, as SQL, for ordering and for showing the owner. */
const EFFECTIVE_SCORE = `CASE WHEN source = 'you' THEN score
       ELSE greatest(0, score - (extract(epoch FROM (now() - created_at)) / 86400) * ${DECAY_PER_DAY})
  END`;

export async function listIdeas(agentId: string, status?: string, limit = 50): Promise<IdeaRow[]> {
  const clauses = ['agent_id = $1'];
  const params: unknown[] = [agentId];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(limit);
  return mapRows<IdeaRow>(
    await query(
      `SELECT *, round((${EFFECTIVE_SCORE})::numeric)::int AS effective_score
         FROM content_ideas WHERE ${clauses.join(' AND ')}
        -- The order the agent will actually take them in. Ordering this list by
        -- the raw score showed the owner a queue that was not the queue.
        ORDER BY status = 'unused' DESC, (${EFFECTIVE_SCORE}) DESC, created_at DESC
        LIMIT $${params.length}`,
      params,
    ),
  );
}

export async function counts(agentId: string): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM content_ideas WHERE agent_id = $1 GROUP BY status',
    [agentId],
  );
  const result: Record<string, number> = { unused: 0, drafting: 0, used: 0, discarded: 0 };
  for (const row of rows) result[row.status] = row.n;
  return result;
}

/**
 * The best unused idea.
 *
 * Claimed by moving it to drafting in the same statement, so two scheduled
 * posts cannot pick up the same thought.
 */
export async function claimBestIdea(agentId: string): Promise<IdeaRow | null> {
  return mapRow<IdeaRow>(
    await queryOne(
      `UPDATE content_ideas SET status = 'drafting', updated_at = now()
        WHERE id = (
          SELECT id FROM content_ideas
           WHERE agent_id = $1 AND status = 'unused'
           -- Newest first among equals. The old ordering was created_at
           -- ascending, so an agent worked through its backlog oldest thought
           -- first and the very first thing it ever posted was the stalest
           -- thing it had.
           ORDER BY (${EFFECTIVE_SCORE}) DESC, created_at DESC
           LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [agentId],
    ),
  );
}

/**
 * Change an idea's status, within one agent.
 *
 * The agent is part of the key rather than something a caller checks first.
 * An id on its own is a guess anybody can make, and a route that had already
 * confirmed the caller owns *an* agent went on to update an idea by id alone --
 * so any signed-in owner could discard a stranger's backlog. Scoping the write
 * means the query cannot reach the row at all, whatever the route forgets.
 *
 * Returns whether it matched, so a caller can answer 404 rather than pretend.
 */
export async function resolveIdea(
  agentId: string,
  id: string,
  status: 'used' | 'discarded' | 'unused',
  jobId?: string | null,
): Promise<boolean> {
  const rows = await query(
    `UPDATE content_ideas
        SET status = $3, used_job_id = $4,
            used_at = CASE WHEN $3 = 'used' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND agent_id = $2
      RETURNING id`,
    [id, agentId, status, jobId ?? null],
  );
  return rows.length > 0;
}

/**
 * Whatever identifies the same thought however it was typed.
 *
 * Exact lowercase equality caught nothing in practice. The same question
 * arrives with a different handle in front of it, a line break the client
 * inserted, or a stray space, and every copy was captured as a new idea -- a
 * real backlog held four near-identical "what's your thoughts on this?" rows.
 * Matches `questionKey` in @xbam/shared, which normalises the same way.
 */
const NORMALISED = `regexp_replace(regexp_replace(lower($COLUMN$), '@[a-z0-9_]+', ' ', 'g'), '[^a-z0-9]+', '', 'g')`;

/** Stops the same thought being captured twice from two conversations. */
export async function similarExists(agentId: string, summary: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM content_ideas
      WHERE agent_id = $1 AND status <> 'discarded'
        AND ${NORMALISED.replace('$COLUMN$', 'summary')} = ${NORMALISED.replace('$COLUMN$', '$2')}`,
    [agentId, summary.slice(0, 500)],
  );
  return (row?.n ?? 0) > 0;
}


/** Records which job took an idea, so the reconciler can ask that job how it went. */
export async function attachJob(agentId: string, ideaId: string, jobId: string): Promise<void> {
  await query('UPDATE content_ideas SET job_id = $3, updated_at = now() WHERE id = $1 AND agent_id = $2', [
    ideaId,
    agentId,
    jobId,
  ]);
}

export interface IdeaReconciliation {
  /** Put back in the backlog, because nothing was published from them. */
  released: number;
  /** Given up on after too many attempts, so they stop blocking the queue. */
  discarded: number;
  /** Confirmed used, where the job published but the learn step did not record it. */
  used: number;
}

/**
 * Brings claimed ideas back into line with what their job actually did.
 *
 * `claimBestIdea` marks an idea 'drafting' and, before this existed, nothing
 * ever marked it anything else. A post that hit a validator refusal, a revoked
 * capability, a person pressing stop, or a worker that died left its idea
 * 'drafting' for ever -- invisible to the next claim and to the owner. Every
 * failure quietly spent one idea, and an agent whose backlog had drained that
 * way reported "nothing in the idea backlog was worth posting", which was false.
 *
 * A reconciler rather than a hook on each ending, because there are five
 * endings and the one that matters most -- the worker died -- has no code
 * running to hook. Each claimed idea names its job; this asks that job.
 *
 * `staleMs` covers the gap between claiming an idea and creating its job. Only
 * a crash lands there, so it needs to be longer than that window and nothing
 * else.
 */
export async function reconcileDrafting(staleMs = 10 * 60_000, maxAttempts = 3): Promise<IdeaReconciliation> {
  const seconds = Math.max(1, Math.round(staleMs / 1000));

  // Published. Normally the learn step has already done this; a job that
  // executed and then failed to record it would otherwise hold the idea open.
  const used = await query(
    `UPDATE content_ideas i SET status = 'used', used_job_id = i.job_id, used_at = now(), updated_at = now()
       FROM jobs j
      WHERE i.status = 'drafting' AND i.job_id = j.id AND j.status = 'EXECUTED'
      RETURNING i.id`,
  );

  // A rehearsal said nothing, so it costs the idea nothing. Not an attempt.
  const rehearsed = await query(
    `UPDATE content_ideas i SET status = 'unused', job_id = NULL, updated_at = now()
       FROM jobs j
      WHERE i.status = 'drafting' AND i.job_id = j.id AND j.status = 'DRY_RUN_COMPLETED'
      RETURNING i.id`,
  );

  // Ended without publishing. Charge one attempt and say why.
  const failed = await query<{ id: string; attempts: number }>(
    `UPDATE content_ideas i
        SET attempts = i.attempts + 1,
            last_error = coalesce(nullif(j.last_error, ''), j.error_class, 'The post did not go out.'),
            status = 'unused', job_id = NULL, updated_at = now()
       FROM jobs j
      WHERE i.status = 'drafting' AND i.job_id = j.id
        AND j.status IN ('PERMANENT_FAILURE', 'CANCELLED')
      RETURNING i.id, i.attempts`,
  );

  // Claimed, then the worker died before it could create the job. There is no
  // job to ask, so age is the only signal -- and only a crash lands here.
  const stranded = await query(
    `UPDATE content_ideas SET status = 'unused', updated_at = now()
      WHERE status = 'drafting' AND job_id IS NULL
        AND updated_at < now() - make_interval(secs => $1)
      RETURNING id`,
    [seconds],
  );

  // An idea that cannot be published keeps winning the claim -- the scheduler
  // takes the highest score every time -- so it would block everything behind
  // it for ever. After enough tries it is set aside, with its reason kept.
  const discarded = await query(
    `UPDATE content_ideas SET status = 'discarded', updated_at = now()
      WHERE status = 'unused' AND attempts >= $1
      RETURNING id`,
    [maxAttempts],
  );

  // And harvested ideas nobody used before they stopped being current. An
  // owner's own idea never expires: that is a decision waiting its turn.
  const expired = await query(
    `UPDATE content_ideas
        SET status = 'discarded',
            last_error = 'Nobody used it while it was still current.',
            updated_at = now()
      WHERE status = 'unused' AND source <> 'you'
        AND created_at < now() - make_interval(days => $1)
      RETURNING id`,
    [IDEA_SHELF_LIFE_DAYS],
  );

  return {
    released: rehearsed.length + failed.length + stranded.length,
    discarded: discarded.length + expired.length,
    used: used.length,
  };
}
