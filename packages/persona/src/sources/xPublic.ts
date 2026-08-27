import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, envString } from '@xbam/shared';
import type { CorpusFetchOptions, PersonaSourceAdapter, RawCorpusItem, SourceAvailability } from './contract';

const run = promisify(execFile);
const log = createLogger('persona-x-public');

/**
 * Public X corpus, via twscrape.
 *
 * twscrape is a Python library, so this shells out to its CLI rather than
 * embedding it. That keeps the dependency at arm's length: if twscrape stops
 * working, only this file is replaced, because everything downstream consumes
 * RawCorpusItem.
 *
 * It is optional on purpose. The live reply pipeline is Playwright-driven and
 * does not depend on this at all; nothing here can break a running agent.
 *
 * twscrape signs in with X accounts of its own, held in its own database. AI17Z
 * never sees, stores, or transmits those credentials — adding them is something
 * the owner does directly with the twscrape CLI.
 */

/**
 * How to invoke twscrape.
 *
 * Accepts a full command line, not just an executable, because the CLI is often
 * reached through something else: a virtualenv wrapper, `python -m`, `poetry
 * run`, or a launcher script. Quoted segments survive, so a Windows path with
 * spaces works.
 */
function commandLine(): { command: string; prefixArgs: string[] } {
  const raw = envString('AI17Z_TWSCRAPE_COMMAND', 'twscrape').trim();
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? [raw];
  const parts = tokens.map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t));
  return { command: parts[0] ?? 'twscrape', prefixArgs: parts.slice(1) };
}

const COMMAND = () => commandLine().command;

interface Invocation {
  stdout: string;
  stderr: string;
}

async function invoke(args: string[], timeoutMs = 180_000): Promise<Invocation> {
  const { command, prefixArgs } = commandLine();
  try {
    const { stdout, stderr } = await run(command, [...prefixArgs, ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    // twscrape exits non-zero for ordinary conditions such as an empty account
    // pool, and writes the useful part to stderr. Its output is worth more than
    // the exit code, so it is carried through rather than discarded.
    const e = error as { stdout?: string; stderr?: string; message?: string; code?: string };
    if (e.code === 'ENOENT') throw error;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

/**
 * twscrape reports an empty account pool as "Not Found", which reads as "no such
 * user" and sends people off checking a handle that was correct all along.
 */
function noAccountsInPool(output: string): boolean {
  return /No active accounts|no accounts? (available|found)/i.test(output);
}

const NEEDS_ACCOUNTS =
  'twscrape is installed but has no X account to read with. Add one yourself with: twscrape add_accounts ' +
  '(then twscrape login_accounts). Those credentials go into twscrape\'s own database — AI17Z never sees them. ' +
  'Use a spare account: X may rate-limit or lock an account used for bulk reading.';

function parseItem(line: string): RawCorpusItem | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = parsed.id_str ?? parsed.id;
  const text = parsed.rawContent ?? parsed.text ?? parsed.full_text;
  if (id === undefined || typeof text !== 'string' || text.trim().length === 0) return null;

  const inReplyTo = parsed.inReplyToTweetId ?? parsed.in_reply_to_status_id_str ?? null;
  const quoted = parsed.quotedTweet ?? null;

  return {
    remoteId: String(id),
    text,
    url: typeof parsed.url === 'string' ? parsed.url : null,
    itemKind: inReplyTo ? 'reply' : quoted ? 'quote' : 'post',
    createdAt: typeof parsed.date === 'string' ? parsed.date : null,
    // Kept verbatim: provenance is the point of a raw archive.
    raw: parsed,
  };
}

/**
 * twscrape prints one JSON document per result, but its logging goes to the same
 * stream in some versions, so lines are filtered rather than assumed.
 */
function parseLines(stdout: string): RawCorpusItem[] {
  const items: RawCorpusItem[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    if (trimmed.startsWith('[')) {
      // Some subcommands emit a single array rather than one object per line.
      try {
        for (const entry of JSON.parse(trimmed) as unknown[]) {
          const item = parseItem(JSON.stringify(entry));
          if (item) items.push(item);
        }
        continue;
      } catch {
        continue;
      }
    }
    const item = parseItem(trimmed);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Resolves a handle to the numeric id the timeline commands actually take.
 *
 * `user_tweets_and_replies` takes a user id, not a handle. Passing a handle
 * returns nothing at all rather than an error, which looks exactly like an
 * account with no posts.
 */
async function resolveUserId(handle: string): Promise<string> {
  const { stdout, stderr } = await invoke(['user_by_login', handle], 90_000);
  const combined = `${stdout}\n${stderr}`;
  if (noAccountsInPool(combined)) throw new Error(NEEDS_ACCOUNTS);

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const id = parsed.id_str ?? parsed.id;
      if (id !== undefined) return String(id);
    } catch {
      continue;
    }
  }
  throw new Error(
    `twscrape could not find @${handle}. Check the handle, and that the account is public and not suspended.`,
  );
}

export const xPublicSource: PersonaSourceAdapter = {
  kind: 'x_public',
  displayName: 'Public X posts (twscrape)',

  async availability(): Promise<SourceAvailability> {
    let version: string;
    try {
      const { stdout, stderr } = await invoke(['version'], 20_000);
      version = (stdout || stderr).trim().split(/\r?\n/).pop() ?? '';
    } catch (error) {
      const message = (error as Error).message ?? '';
      return {
        available: false,
        detail: `"${COMMAND()}" is not on PATH where the worker runs.`,
        requirement:
          'Install it with: pip install twscrape. Then add an X account to it with twscrape add_accounts. ' +
          'Set AI17Z_TWSCRAPE_COMMAND if the CLI is not on PATH. ' +
          `(${message.split('\n')[0]})`,
      };
    }

    // Installed is not the same as usable. An empty account pool fails every
    // query with a message about the handle, which is the wrong thing to check.
    const { stdout, stderr } = await invoke(['accounts'], 30_000);
    const rows = `${stdout}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^\d{4}-\d{2}-\d{2}/.test(l) && !/username/i.test(l));

    if (rows.length === 0 || noAccountsInPool(`${stdout}\n${stderr}`)) {
      return { available: false, detail: 'twscrape is installed but has no X account to read with.', requirement: NEEDS_ACCOUNTS };
    }

    return {
      available: true,
      detail: `twscrape ${version || 'installed'}, ${rows.length} account${rows.length === 1 ? '' : 's'} in its pool`,
      requirement: null,
    };
  },

  async fetch(options: CorpusFetchOptions): Promise<RawCorpusItem[]> {
    const handle = options.handle.replace(/^@+/, '');
    const userId = await resolveUserId(handle);

    // Replies carry a great deal of voice, so they are included by default.
    const command = options.includeReplies === false ? 'user_tweets' : 'user_tweets_and_replies';
    const { stdout, stderr } = await invoke([command, userId, '--limit', String(options.limit)]);
    const combined = `${stdout}\n${stderr}`;
    if (noAccountsInPool(combined)) throw new Error(NEEDS_ACCOUNTS);

    const parsed = parseLines(stdout);
    if (parsed.length === 0 && stderr.trim()) {
      log.warn('twscrape returned nothing', { handle, stderr: stderr.split('\n').slice(-2).join(' ') });
    }

    const items: RawCorpusItem[] = [];
    for (const item of parsed) {
      // Incremental sync: stop once we reach something already ingested.
      if (options.since && item.remoteId === options.since) break;
      if (item.itemKind === 'quote' && options.includeQuotes === false) continue;
      items.push(item);
    }
    log.info('fetched public corpus', { handle, userId, items: items.length });
    return items;
  },
};
