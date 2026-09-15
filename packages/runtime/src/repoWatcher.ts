import { createLogger, errorMessage } from '@xbam/shared';
import { repoSources, type RepoEventKind, type RepoSourceRow } from '@xbam/database';

const log = createLogger('repo-watch');

/**
 * Following what a project actually did.
 *
 * An agent whose whole subject is a piece of software and which has no idea
 * what shipped in it can only repeat what it was told once. It cannot say what
 * changed, cannot answer "is that fixed yet", and its project updates are
 * marketing rather than news -- because it has no source of fact about the
 * thing it talks about all day.
 *
 * ## Read only, and there is nothing to argue about
 *
 * Four endpoints, all GET, all public. No push, no merge, no comment, no
 * release. Nothing here holds a write scope even when a token is configured,
 * because nothing here writes.
 *
 * ## Polling, and why that is the durable answer rather than the lazy one
 *
 * GitHub supports webhooks and they are better when they can be used. AI17Z
 * runs on somebody's own machine, usually behind a router with nowhere for
 * GitHub to deliver to -- so the mechanism that always works is a conditional
 * poll, and a webhook is an optimisation for the installations that happen to
 * be reachable.
 *
 * Conditional is what makes it cheap. An `If-None-Match` carrying the stored
 * ETag gets a 304 with no body, and GitHub does not charge a 304 against the
 * rate limit at all. A quiet repository therefore costs a watcher effectively
 * nothing, however often it is checked.
 *
 * ## Nothing is announced twice
 *
 * The unique index on `(source, kind, remote_id)` is the guarantee, not the
 * cursor. Cursors make a poll cheap; the index is what makes overlapping polls
 * safe -- and polls overlap as a matter of course, so an agent that relied on
 * the cursor alone would announce the same release on a restart.
 */

const API = 'https://api.github.com';

/** What one poll of one kind may bring back. Bounded: this is a catch-up, not a history. */
const PER_KIND = 20;

/**
 * How long one repository's poll may take in total.
 *
 * Four endpoints on a slow connection, and no longer. A watcher that can hang
 * is a worker loop that can stop, and the next tick would have caught up
 * anyway.
 */
const POLL_TIMEOUT_MS = 20_000;

interface Fetched {
  status: number;
  etag: string | null;
  body: unknown;
}

/**
 * One conditional GET.
 *
 * The token, when there is one, is read at the call site and used here. It is
 * never logged, never returned, and never put on an error -- an error message
 * carrying a credential is how a secret ends up in a trace somebody pastes into
 * an issue.
 */
async function ask(path: string, etag: string | null, token: string | null): Promise<Fetched> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    // GitHub asks for one and answers 403 without it.
    'user-agent': 'AI17Z',
  };
  if (etag) headers['if-none-match'] = etag;
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
  // 304 is the good case and carries no body. Anything else is read, including
  // the failures: GitHub's own message is far more useful than a status code.
  if (response.status === 304) return { status: 304, etag, body: null };
  const body = await response.json().catch(() => null);
  return { status: response.status, etag: response.headers.get('etag'), body };
}

/** The four things worth following, and where each lives. */
const ENDPOINTS: Record<RepoEventKind, (repo: string) => string> = {
  RELEASE: (repo) => `/repos/${repo}/releases?per_page=${PER_KIND}`,
  COMMIT: (repo) => `/repos/${repo}/commits?per_page=${PER_KIND}`,
  PULL_REQUEST: (repo) => `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_KIND}`,
  ISSUE: (repo) => `/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=${PER_KIND}`,
  WORKFLOW: (repo) => `/repos/${repo}/actions/runs?per_page=${PER_KIND}`,
};

interface Normalised {
  remoteId: string;
  title: string;
  body: string;
  url: string;
  actor: string | null;
  state: string | null;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

const text = (value: unknown, max = 4_000): string => (typeof value === 'string' ? value.slice(0, max) : '');
const at = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * A forge's answer as the shape the rest of AI17Z reads.
 *
 * Deliberately a few named fields rather than the payload verbatim. Keeping
 * somebody else's API response whole is keeping a schema this project does not
 * control and did not agree to, and every consumer would then be coupled to it.
 */
function normalise(kind: RepoEventKind, raw: unknown): Normalised | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const user = (item.user ?? item.author ?? item.actor ?? {}) as Record<string, unknown>;
  const actor = typeof user.login === 'string' ? user.login : null;

  switch (kind) {
    case 'RELEASE': {
      const tag = text(item.tag_name, 100);
      if (!tag) return null;
      // A draft is not a release. Announcing one tells people about something
      // they cannot get.
      if (item.draft === true) return null;
      return {
        remoteId: tag,
        title: text(item.name, 300) || tag,
        body: text(item.body, 8_000),
        url: text(item.html_url, 500),
        actor,
        state: item.prerelease === true ? 'prerelease' : 'released',
        occurredAt: at(item.published_at) ?? at(item.created_at),
        payload: { tag, prerelease: item.prerelease === true },
      };
    }
    case 'COMMIT': {
      const sha = text(item.sha, 60);
      if (!sha) return null;
      const commit = (item.commit ?? {}) as Record<string, unknown>;
      const author = (commit.author ?? {}) as Record<string, unknown>;
      const message = text(commit.message, 4_000);
      return {
        remoteId: sha,
        // The subject line. A commit body is often the whole argument and
        // belongs in `body`, but a list of commits wants one line each.
        title: message.split('\n')[0] ?? '',
        body: message,
        url: text(item.html_url, 500),
        actor: actor ?? text(author.name, 200) ?? null,
        state: null,
        occurredAt: at(author.date),
        payload: { sha },
      };
    }
    case 'PULL_REQUEST': {
      const number = typeof item.number === 'number' ? item.number : null;
      if (number === null) return null;
      return {
        remoteId: String(number),
        title: text(item.title, 300),
        body: text(item.body, 6_000),
        url: text(item.html_url, 500),
        actor,
        state: item.merged_at ? 'merged' : text(item.state, 40),
        occurredAt: at(item.merged_at) ?? at(item.updated_at) ?? at(item.created_at),
        payload: { number, merged: Boolean(item.merged_at) },
      };
    }
    case 'ISSUE': {
      const number = typeof item.number === 'number' ? item.number : null;
      if (number === null) return null;
      // GitHub returns pull requests from the issues endpoint. Recording them
      // twice would double every PR in an agent's evidence.
      if (item.pull_request) return null;
      return {
        remoteId: String(number),
        title: text(item.title, 300),
        body: text(item.body, 6_000),
        url: text(item.html_url, 500),
        actor,
        state: text(item.state, 40),
        occurredAt: at(item.updated_at) ?? at(item.created_at),
        payload: { number, comments: typeof item.comments === 'number' ? item.comments : 0 },
      };
    }
    case 'WORKFLOW': {
      const id = typeof item.id === 'number' ? String(item.id) : text(item.id, 60);
      if (!id) return null;
      return {
        remoteId: id,
        title: text(item.name, 300),
        body: '',
        url: text(item.html_url, 500),
        actor,
        state: text(item.conclusion, 40) || text(item.status, 40),
        occurredAt: at(item.updated_at) ?? at(item.created_at),
        payload: { branch: text(item.head_branch, 200), sha: text(item.head_sha, 60) },
      };
    }
    default:
      return null;
  }
}

/** What GitHub's status meant, in words rather than a number. */
function refusal(status: number, body: unknown): string {
  const message = typeof (body as { message?: unknown })?.message === 'string' ? (body as { message: string }).message : '';
  if (status === 404) {
    return 'That repository could not be found. If it is private, this watch needs a read-only token.';
  }
  if (status === 401 || status === 403) {
    // The two most common and most different causes, separated because the fix
    // is different: waiting works for one and never works for the other.
    return message.toLowerCase().includes('rate limit')
      ? 'GitHub asked AI17Z to slow down. The next poll will wait longer.'
      : `GitHub refused the request${message ? `: ${message}` : '.'}`;
  }
  return `GitHub answered ${status}${message ? `: ${message}` : ''}.`;
}

export interface RepoPollOutcome {
  repo: string;
  /** Things recorded for the first time. */
  fresh: number;
  /** Endpoints that answered 304, which cost nothing. */
  unchanged: number;
  error: string | null;
}

/**
 * Look at one repository.
 *
 * Every kind is asked separately and independently: one endpoint refusing is
 * not a reason to lose the other three, and a repository with actions disabled
 * should still report its releases.
 */
export async function pollRepo(source: RepoSourceRow): Promise<RepoPollOutcome> {
  const token = source.hasToken ? await repoSources.getDecryptedToken(source.id) : null;
  /*
    The first poll is a backfill, not news.

    A forge hands over its recent history in one go -- twenty releases, twenty
    commits, whatever is open -- and all of it is recorded in the same second,
    so all of it falls inside the next wake's window together. The live agent's
    first wake attended to twenty near-identical release tags and crowded out
    everything that was actually happening.

    Recorded either way, and the owner sees the whole history on the screen.
    What this decides is whether deliberation is told about it as something
    that just happened. `lastSuccessAt` rather than `lastPollAt`, because the
    claim stamps `lastPollAt` before the request is even made.
  */
  const backfill = source.lastSuccessAt === null;
  const etags = { ...source.etags };
  const cursors = { ...source.cursors };
  let fresh = 0;
  let unchanged = 0;
  const refusals: string[] = [];

  for (const kind of source.kinds) {
    const endpoint = ENDPOINTS[kind];
    if (!endpoint) continue;

    try {
      const answer = await ask(endpoint(source.repo), etags[kind] ?? null, token);
      if (answer.status === 304) {
        unchanged += 1;
        continue;
      }
      if (answer.status >= 400) {
        refusals.push(refusal(answer.status, answer.body));
        continue;
      }
      if (answer.etag) etags[kind] = answer.etag;

      const items = Array.isArray(answer.body) ? answer.body : [];
      let newest: string | null = null;
      for (const raw of items) {
        const item = normalise(kind, raw);
        if (!item) continue;
        newest ??= item.remoteId;
        const recorded = await repoSources.recordRepoEvent({ sourceId: source.id, kind, ...item, backfill });
        // Null means it was already known. The index is the guarantee here, not
        // the cursor: polls overlap as a matter of course.
        if (recorded) fresh += 1;
      }
      if (newest) cursors[kind] = newest;
    } catch (error) {
      refusals.push(errorMessage(error));
    }
  }

  const error = refusals.length === source.kinds.length && refusals.length > 0 ? refusals.join(' ') : null;
  await repoSources.noteRepoPoll(source.id, { etags, cursors, ...(error ? { error } : {}) });

  if (fresh > 0) {
    log.info(backfill ? 'read a watched repository for the first time' : 'a watched repository did something', {
      repo: source.repo,
      fresh,
      ...(backfill ? { backfill: true } : {}),
    });
  }
  return { repo: source.repo, fresh, unchanged, error };
}

/**
 * Look at whichever repositories are due.
 *
 * The claim moves each due time forward in the statement that selects it, so
 * two workers cannot poll one repository and a restart cannot stampede every
 * watch at once. The tick is not the interval.
 */
export async function pollDueRepos(limit = 4): Promise<RepoPollOutcome[]> {
  const due = await repoSources.claimDueRepos(limit, 300);
  const outcomes: RepoPollOutcome[] = [];
  for (const source of due) {
    try {
      outcomes.push(await pollRepo(source));
    } catch (error) {
      const why = errorMessage(error);
      log.warn('a repository watch failed', { repo: source.repo, message: why });
      await repoSources.noteRepoPoll(source.id, { error: why }).catch(() => undefined);
      outcomes.push({ repo: source.repo, fresh: 0, unchanged: 0, error: why });
    }
  }
  return outcomes;
}

/**
 * Whether a repository event is worth an agent's attention at all.
 *
 * Deterministic and deliberately strict, because the failure it prevents is the
 * one everybody predicts: an agent that tweets every commit. Most of what a
 * repository does is mechanical and interests nobody outside it -- a typo fix,
 * a lockfile bump, a test fixture -- and the difference between a project-aware
 * agent and a changelog bot is entirely in what it declines.
 *
 * A release is always worth knowing about. Everything else has to earn it.
 */
export function worthNoticing(event: {
  kind: RepoEventKind;
  title: string;
  body: string;
  state: string | null;
}): { worth: boolean; why: string } {
  const title = event.title.trim();
  const lower = title.toLowerCase();

  if (event.kind === 'RELEASE') return { worth: true, why: 'A release is a thing that happened to the project.' };

  // A build that went red is a fact about the project that somebody may ask
  // about. A build that went green is the expected case and is not news.
  if (event.kind === 'WORKFLOW') {
    return event.state === 'failure'
      ? { worth: true, why: 'A build failed.' }
      : { worth: false, why: 'A build doing what builds do.' };
  }

  if (title.length < 12) return { worth: false, why: 'Too short to say what it was.' };

  /*
    The mechanical majority.

    Matched on the conventional prefixes and the handful of words that reliably
    mean "no user could care". Deliberately a short list: a long one starts
    deciding what the project is allowed to find significant, and the length
    and reinforcement rules already do most of the work.
  */
  const mechanical =
    /^(chore|ci|build|style|test|refactor|docs?)(\(|:)/i.test(title) ||
    /\b(typo|lockfile|bump|whitespace|formatting|rename|lint|dependabot)\b/i.test(lower);
  if (mechanical) return { worth: false, why: 'Mechanical: no user-visible change.' };

  if (event.kind === 'PULL_REQUEST') {
    // An open pull request is a proposal. A merged one is a thing that
    // happened, and only the second is safe to describe as what the project
    // now does.
    return event.state === 'merged'
      ? { worth: true, why: 'Merged, so it is part of the project now.' }
      : { worth: false, why: 'Proposed rather than merged.' };
  }

  if (event.kind === 'ISSUE') {
    return { worth: true, why: 'Somebody raised something about the project.' };
  }

  // A commit that survived the mechanical filter and says enough to be about
  // something.
  return { worth: title.length >= 24, why: title.length >= 24 ? 'A substantive change.' : 'Too terse to be about anything.' };
}
