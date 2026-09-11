import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Holding several processes at a line and letting them go together.
 *
 * ### Why this exists rather than a sleep
 *
 * A test that proves two processes cannot overspend a shared budget has to get
 * them competing, and starting a process is far slower than the work they then
 * do. The first version picked a moment 1.5 seconds out and had each child
 * sleep until it -- which is a guess about how long `node` plus `tsx` plus a
 * module graph takes to load, and on a slower machine it is the wrong guess.
 * The moment passes before a child reaches it, that child proceeds at once, and
 * whoever arrived first takes the whole budget while the other gets nothing.
 *
 * It failed exactly that way on Linux CI and reported "expected 0 to be greater
 * than 0" -- a sentence about a count, which says nothing about the cause.
 *
 * So: no guess. Each child writes a ready file and waits for a go file; the
 * parent writes go once every child is ready. Correct at any speed.
 *
 * ### And its own failure modes, because a filesystem flake is no better
 *
 * Replacing a timing flake with a filesystem flake would be no improvement, so:
 *
 *   the directory is created fresh per barrier, so a ready or go file left by
 *     an earlier run cannot release this one;
 *   the parent waits for **every** expected child, not the first;
 *   a timeout is reported rather than swallowed -- the old code wrote go anyway
 *     and let the confusion surface later as a wrong count;
 *   a child that never arrives cannot hang the parent, because the wait is
 *     bounded and the caller is told;
 *   cleanup is idempotent and works on both platforms.
 */

export interface Barrier {
  /** Passed to each child, which writes its ready file here. */
  readonly directory: string;
  /**
   * Waits for every named child, then releases them all.
   *
   * Takes the ids rather than a count so a timeout can say **which** children
   * never arrived. "1 of 2 arrived" sends somebody looking at both; "child b
   * never arrived" sends them at one.
   *
   * Returns what actually happened rather than assuming it worked: anything
   * missing means the barrier did not do its job, and whatever the children
   * then produced proves nothing about contention.
   */
  releaseWhenReady(ids: readonly string[]): Promise<{ released: boolean; arrived: string[]; missing: string[] }>;
  cleanup(): void;
}

/** Deliberately long: a cold `tsx` start on a loaded CI runner is seconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

export function createBarrier(options: { timeoutMs?: number } = {}): Barrier {
  const directory = mkdtempSync(join(tmpdir(), 'ai17z-barrier-'));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    directory,

    async releaseWhenReady(ids: readonly string[]) {
      const giveUpAt = Date.now() + timeoutMs;
      let arrived: string[] = [];
      for (;;) {
        const present = new Set(
          readdirSync(directory)
            .filter((name) => name.startsWith('ready-'))
            .map((name) => name.slice('ready-'.length)),
        );
        arrived = ids.filter((id) => present.has(id));
        if (arrived.length >= ids.length) break;
        if (Date.now() >= giveUpAt) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // Written even on a timeout, so children still waiting are let go and
      // exit rather than sitting until their own deadline. That keeps a clear
      // failure from also being a slow one -- but the caller is told it timed
      // out, which is the part the old version left out. A timeout must never
      // read as a normal release.
      writeFileSync(join(directory, 'go'), '1');
      const missing = ids.filter((id) => !arrived.includes(id));
      return { released: missing.length === 0, arrived, missing };
    },

    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** What a child does: announce itself, then wait to be let go. */
export async function waitAtBarrier(
  directory: string,
  id: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  writeFileSync(join(directory, `ready-${id}`), '1');
  const giveUpAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const go = join(directory, 'go');
  while (Date.now() < giveUpAt) {
    if (existsSync(go)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}
