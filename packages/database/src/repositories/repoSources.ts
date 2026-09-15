import { openSecret, sealSecret, secretFingerprint } from '@xbam/shared';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

/**
 * Repositories an installation is watching, and what they did.
 *
 * Read only. There is no push, merge, close, comment or release here and no
 * column one could be built on -- an agent that could act on a repository is a
 * different product with a different threat model.
 *
 * The token, where there is one, is sealed under the master key exactly as a
 * provider API key is and is readable only through `getDecryptedToken`. It is
 * never in `COLUMNS`, so no route, log, trace or audit row can reach it by
 * accident: to get the token somebody has to call the function whose name says
 * that is what it does.
 */

export const REPO_EVENT_KINDS = ['RELEASE', 'COMMIT', 'PULL_REQUEST', 'ISSUE', 'WORKFLOW'] as const;
export type RepoEventKind = (typeof REPO_EVENT_KINDS)[number];

export const REPO_STATUSES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'FAILING', 'DISABLED'] as const;
export type RepoStatus = (typeof REPO_STATUSES)[number];

export interface RepoSourceRow {
  id: string;
  ownerUserId: string;
  agentId: string | null;
  provider: string;
  repo: string;
  kinds: RepoEventKind[];
  enabled: boolean;
  etags: Record<string, string>;
  cursors: Record<string, string>;
  /** Whether a token is stored. Never the token. */
  hasToken: boolean;
  tokenFingerprint: string | null;
  pollSeconds: number;
  nextPollAt: string;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  status: RepoStatus;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, owner_user_id, agent_id, provider, repo, kinds, enabled, etags, cursors,
  (sealed_token IS NOT NULL) AS has_token, token_fingerprint, poll_seconds, next_poll_at,
  last_poll_at, last_success_at, status, last_error, consecutive_failures, created_at, updated_at`;

export async function watchRepo(input: {
  ownerUserId: string;
  agentId?: string | null;
  repo: string;
  kinds?: RepoEventKind[];
  token?: string | null;
  pollSeconds?: number;
}): Promise<RepoSourceRow> {
  const sealed = input.token ? sealSecret(input.token) : null;
  const row = await queryOne(
    `INSERT INTO repo_sources (owner_user_id, agent_id, repo, kinds, sealed_token, token_fingerprint, poll_seconds)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
     ON CONFLICT (owner_user_id, provider, lower(repo), coalesce(agent_id::text, 'all')) DO UPDATE
       SET kinds = excluded.kinds,
           enabled = true,
           poll_seconds = excluded.poll_seconds,
           -- A token supplied again replaces the old one; one omitted leaves
           -- whatever was there. Clearing is its own deliberate operation.
           sealed_token = coalesce(excluded.sealed_token, repo_sources.sealed_token),
           token_fingerprint = coalesce(excluded.token_fingerprint, repo_sources.token_fingerprint),
           -- Somebody who just edited this is asking for it to be looked at,
           -- not for it to be looked at after the old interval.
           next_poll_at = now(),
           updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      input.ownerUserId,
      input.agentId ?? null,
      input.repo.trim(),
      JSON.stringify(input.kinds ?? ['RELEASE', 'COMMIT', 'PULL_REQUEST', 'ISSUE']),
      sealed,
      input.token ? secretFingerprint(input.token) : null,
      input.pollSeconds ?? 900,
    ],
  );
  return mapRow<RepoSourceRow>(row) as RepoSourceRow;
}

export async function listRepos(ownerUserId: string, agentId?: string | null): Promise<RepoSourceRow[]> {
  const params: unknown[] = [ownerUserId];
  const clauses = ['owner_user_id = $1'];
  if (agentId) {
    params.push(agentId);
    // An agent sees what it watches and what the installation watches for
    // everybody. The second is the ordinary case for a project.
    clauses.push(`(agent_id = $${params.length} OR agent_id IS NULL)`);
  }
  return mapRows<RepoSourceRow>(
    await query(`SELECT ${COLUMNS} FROM repo_sources WHERE ${clauses.join(' AND ')} ORDER BY repo`, params),
  );
}

export async function getRepo(id: string): Promise<RepoSourceRow | null> {
  return mapRow<RepoSourceRow>(await queryOne(`SELECT ${COLUMNS} FROM repo_sources WHERE id = $1`, [id]));
}

/**
 * The token, for the one caller that has to have it.
 *
 * Named so that reaching for a secret is visible at the call site, exactly as
 * `providers.getDecryptedApiKey` is. Nothing else selects the column.
 */
export async function getDecryptedToken(id: string): Promise<string | null> {
  const rows = await query<{ sealed_token: string | null }>(
    'SELECT sealed_token FROM repo_sources WHERE id = $1',
    [id],
  );
  const sealed = rows[0]?.sealed_token;
  return sealed ? openSecret(sealed) : null;
}

export async function forgetRepo(ownerUserId: string, id: string): Promise<boolean> {
  const rows = await query('DELETE FROM repo_sources WHERE id = $1 AND owner_user_id = $2 RETURNING id', [
    id,
    ownerUserId,
  ]);
  return rows.length > 0;
}

export async function setRepoEnabled(ownerUserId: string, id: string, enabled: boolean): Promise<void> {
  await query(
    `UPDATE repo_sources SET enabled = $3, status = CASE WHEN $3 THEN 'UNKNOWN' ELSE 'DISABLED' END,
        next_poll_at = CASE WHEN $3 THEN now() ELSE next_poll_at END, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2`,
    [id, ownerUserId, enabled],
  );
}

/**
 * Repositories due for a look, claimed so two workers cannot both take one.
 *
 * The claim moves the due time forward in the statement that selects the row.
 * Same shape as the account poller, the feed watcher and the wake loop.
 */
export async function claimDueRepos(limit: number, holdSeconds: number): Promise<RepoSourceRow[]> {
  return mapRows<RepoSourceRow>(
    await query(
      `UPDATE repo_sources SET next_poll_at = now() + make_interval(secs => $2), last_poll_at = now()
        WHERE id IN (
          SELECT id FROM repo_sources WHERE enabled AND next_poll_at <= now()
          ORDER BY next_poll_at LIMIT $1 FOR UPDATE SKIP LOCKED
        )
        RETURNING ${COLUMNS}`,
      [limit, holdSeconds],
    ),
  );
}

/** What the poll found, and what to send next time. */
export async function noteRepoPoll(
  id: string,
  input: { etags?: Record<string, string>; cursors?: Record<string, string>; error?: string | null },
): Promise<void> {
  if (input.error) {
    await query(
      `UPDATE repo_sources
          SET consecutive_failures = consecutive_failures + 1,
              last_error = $2,
              -- Three strikes before it is called failing. A forge having a bad
              -- minute is not a broken watch, and an owner told their watch is
              -- failing every time GitHub hiccups stops reading the word.
              status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'FAILING' ELSE 'DEGRADED' END,
              -- Back off while it is failing rather than hammering a forge that
              -- has already said no.
              next_poll_at = now() + make_interval(secs => least(3600, poll_seconds * (consecutive_failures + 1))),
              updated_at = now()
        WHERE id = $1`,
      [id, input.error.slice(0, 1000)],
    );
    return;
  }
  await query(
    `UPDATE repo_sources
        SET etags = coalesce($2::jsonb, etags),
            cursors = coalesce($3::jsonb, cursors),
            consecutive_failures = 0,
            last_error = NULL,
            status = 'HEALTHY',
            last_success_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [id, input.etags ? JSON.stringify(input.etags) : null, input.cursors ? JSON.stringify(input.cursors) : null],
  );
}

// ── What the repositories did ───────────────────────────────────────────────

export interface RepoEventRow {
  id: string;
  sourceId: string;
  kind: RepoEventKind;
  remoteId: string;
  title: string;
  body: string;
  url: string;
  actor: string | null;
  state: string | null;
  occurredAt: string | null;
  payload: Record<string, unknown>;
  seenAt: string;
}

const EVENT_COLUMNS = `id, source_id, kind, remote_id, title, body, url, actor, state,
  occurred_at, payload, seen_at`;

/**
 * Record something a repository did, once.
 *
 * Returns null when it was already known, which is how the caller counts what
 * is genuinely new. A poll that overlaps the last one is the ordinary case, and
 * without this an agent would announce the same release on every tick.
 */
export async function recordRepoEvent(input: {
  sourceId: string;
  kind: RepoEventKind;
  remoteId: string;
  title?: string;
  body?: string;
  url?: string;
  actor?: string | null;
  state?: string | null;
  occurredAt?: string | null;
  payload?: Record<string, unknown>;
}): Promise<RepoEventRow | null> {
  const row = await queryOne(
    `INSERT INTO repo_events (source_id, kind, remote_id, title, body, url, actor, state, occurred_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (source_id, kind, remote_id) DO NOTHING
     RETURNING ${EVENT_COLUMNS}`,
    [
      input.sourceId,
      input.kind,
      input.remoteId,
      (input.title ?? '').slice(0, 500),
      (input.body ?? '').slice(0, 8_000),
      input.url ?? '',
      input.actor ?? null,
      input.state ?? null,
      input.occurredAt ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return mapRow<RepoEventRow>(row);
}

export async function recentRepoEvents(input: {
  ownerUserId: string;
  agentId?: string | null;
  sinceIso?: string;
  limit?: number;
}): Promise<(RepoEventRow & { repo: string })[]> {
  const params: unknown[] = [input.ownerUserId];
  const clauses = ['s.owner_user_id = $1'];
  if (input.agentId) {
    params.push(input.agentId);
    clauses.push(`(s.agent_id = $${params.length} OR s.agent_id IS NULL)`);
  }
  if (input.sinceIso) {
    params.push(input.sinceIso);
    /*
      When this installation first saw it, never when it happened upstream.

      A repository poll runs every quarter of an hour and a commit is minutes
      to days old by the time it comes back, so a window on `occurred_at` is
      almost never open at the moment the thing happened -- and an event missed
      that way is missed for good, because the window only ever moves forward.
      Watching a repository produced nothing on a real installation for exactly
      this reason: forty-three real events, every one of them invisible.

      Ordering still uses `occurred_at`, because what is newest is a question
      about the events and not about when we noticed them.
    */
    clauses.push(`e.seen_at >= $${params.length}`);
  }
  params.push(Math.min(Math.max(input.limit ?? 50, 1), 300));
  return mapRows<RepoEventRow & { repo: string }>(
    await query(
      `SELECT ${EVENT_COLUMNS.split(', ').map((c) => `e.${c.trim()}`).join(', ')}, s.repo
         FROM repo_events e JOIN repo_sources s ON s.id = e.source_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY coalesce(e.occurred_at, e.seen_at) DESC
        LIMIT $${params.length}`,
      params,
    ),
  );
}
