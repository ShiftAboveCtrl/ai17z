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
 * does not depend on this at all; nothing here can break an agent that is
 * already running.
 */
const COMMAND = () => envString('AI17Z_TWSCRAPE_COMMAND', 'twscrape');

async function invoke(args: string[], timeoutMs = 120_000): Promise<string> {
  const command = COMMAND();
  const { stdout } = await run(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

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

export const xPublicSource: PersonaSourceAdapter = {
  kind: 'x_public',
  displayName: 'Public X posts (twscrape)',

  async availability(): Promise<SourceAvailability> {
    try {
      const version = (await invoke(['version'], 15_000)).trim();
      return {
        available: true,
        detail: `twscrape ${version || 'available'}`,
        requirement: null,
      };
    } catch (error) {
      const message = (error as Error).message ?? '';
      const missing = /ENOENT|not recognized|not found/i.test(message);
      return {
        available: false,
        detail: missing
          ? `"${COMMAND()}" is not on PATH where the worker runs.`
          : `twscrape did not respond: ${message.split('\n')[0]}`,
        requirement:
          'Install Python and twscrape (pip install twscrape), add at least one X account to it ' +
          '(twscrape add_accounts), then set AI17Z_TWSCRAPE_COMMAND if it is not on PATH. ' +
          'twscrape signs in with an X account of its own; AI17Z never sees those credentials.',
      };
    }
  },

  async fetch(options: CorpusFetchOptions): Promise<RawCorpusItem[]> {
    const handle = options.handle.replace(/^@+/, '');
    // Replies carry a great deal of voice, so they are included by default.
    const command = options.includeReplies === false ? 'user_tweets' : 'user_tweets_and_replies';

    let stdout: string;
    try {
      stdout = await invoke([command, handle, '--limit', String(options.limit)]);
    } catch (error) {
      log.warn('twscrape fetch failed', { handle, message: (error as Error).message });
      throw new Error(
        `twscrape could not read @${handle}: ${(error as Error).message.split('\n')[0]}. ` +
          'Check that twscrape has a working account pool.',
      );
    }

    const items: RawCorpusItem[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = parseItem(line);
      if (!item) continue;
      // Incremental sync: stop once we reach something already ingested.
      if (options.since && item.remoteId === options.since) break;
      if (item.itemKind === 'quote' && options.includeQuotes === false) continue;
      items.push(item);
    }
    log.info('fetched public corpus', { handle, items: items.length });
    return items;
  },
};
