import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { installHarness } from '../support/harness';
import { uniqueSuffix } from '../support/db';

const run = promisify(execFile);
installHarness();

/**
 * Two processes cannot spend one budget twice.
 *
 * This is the claim the first limiter could not make and said so: it kept its
 * counters in memory, so an installation running a containerised worker and a
 * native one had two processes each believing it held the whole allowance, and
 * an endpoint could be shown twice what AI17Z thought it was sending.
 *
 * **Real processes, deliberately.** Two callers inside one test file share every
 * variable in it, including the in-memory coordinator this exercise exists to
 * stop production using -- so a test built that way would pass whether or not
 * anything was coordinated, which is the worst kind of green. `quotaChild.mts`
 * is spawned twice and its answers are added up.
 */

const CHILD = resolve(__dirname, '..', 'support', 'quotaChild.mts');

/** Temporary directories to remove: barrier directories and quota roots alike. */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Holds every child at a line and lets them go together.
 *
 * Node plus `tsx` plus this module takes a noticeable fraction of a second to
 * start, which is far longer than the work -- so without a barrier the first
 * child finishes the whole budget before the second is awake, and the test
 * proves the counters add up without proving anything ever contended.
 *
 * This was a timestamp 1.5 seconds out, which is a guess about startup time,
 * and on a slower machine it is the wrong guess: the moment passes before a
 * child reaches it, the child proceeds at once, and one of them takes
 * everything. It failed precisely that way on Linux and reported "expected 0 to
 * be greater than 0" -- a sentence about the symptom that says nothing about
 * the cause. A handshake has no such guess in it.
 */
function barrier(): { directory: string; releaseWhenReady(children: number): Promise<void> } {
  const directory = mkdtempSync(join(tmpdir(), 'ai17z-barrier-'));
  roots.push(directory);
  return {
    directory,
    async releaseWhenReady(children: number) {
      const giveUpAt = Date.now() + 60_000;
      while (Date.now() < giveUpAt) {
        const ready = readdirSync(directory).filter((name) => name.startsWith('ready-')).length;
        if (ready >= children) break;
        await new Promise((resolve_) => setTimeout(resolve_, 5));
      }
      writeFileSync(join(directory, 'go'), '1');
    },
  };
}

interface ChildResult {
  granted: number;
  /** False when the child ran without ever being let go, which proves nothing. */
  released: boolean;
}

/** Runs the child, and reads the one line of JSON it prints. */
async function child(args: string[], env: NodeJS.ProcessEnv = {}): Promise<ChildResult> {
  const { stdout } = await run(process.execPath, [require.resolve('tsx/cli'), CHILD, ...args], {
    env: { ...process.env, ...env },
    cwd: resolve(__dirname, '..', '..'),
    timeout: 90_000,
  });
  const line = stdout.trim().split('\n').at(-1) ?? '{}';
  const parsed = JSON.parse(line) as Partial<ChildResult>;
  return { granted: parsed.granted ?? 0, released: parsed.released ?? false };
}

/** Runs children that must genuinely contend, and insists that they did. */
async function contending(args: string[][]): Promise<number[]> {
  const line = barrier();
  const running = args.map((argv, index) =>
    child(argv, { QUOTA_CHILD_BARRIER: line.directory, QUOTA_CHILD_ID: String(index) }),
  );
  await line.releaseWhenReady(args.length);
  const results = await Promise.all(running);

  // Said plainly rather than left to show up as a confusing count. A run where
  // the barrier did not hold has not tested contention, and should say so.
  for (const [index, result] of results.entries()) {
    expect(result.released, `child ${index} ran without being released: the barrier did not hold`).toBe(true);
  }
  return results.map((result) => result.granted);
}

describe("an installation's own budget, spent by two of its processes", () => {
  it('adds up to the capacity, not to twice it', async () => {
    // Ten attempts each against a budget of six. Uncoordinated, both would grant
    // six and the endpoint would see twelve.
    const key = `upstream:test-${uniqueSuffix()}`;
    const [first, second] = await contending([
      ['db', key, '6', '60000', '10'],
      ['db', key, '6', '60000', '10'],
    ]);

    expect(first! + second!).toBe(6);
    // And both of them did some of the work, so this is two processes competing
    // rather than one finishing before the other started.
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
  }, 180_000);

  it('keeps two different budgets apart', async () => {
    const [a, b] = await Promise.all([
      child(['db', `upstream:a-${uniqueSuffix()}`, '3', '60000', '5']),
      child(['db', `upstream:b-${uniqueSuffix()}`, '3', '60000', '5']),
    ]);
    expect(a.granted).toBe(3);
    expect(b.granted).toBe(3);
  }, 120_000);
});

describe('a budget an endpoint counts by address, shared by two installations', () => {
  it('adds up to the capacity across installations that share nothing else', async () => {
    // ai17z-test and ai17z-main have separate databases and no table in common,
    // so this budget cannot live in either. What they do share is an address,
    // which is what the endpoint is counting -- so they share a directory of
    // counters and nothing else. No agent, no account, no credential.
    const root = mkdtempSync(join(tmpdir(), 'ai17z-quota-'));
    roots.push(root);
    const key = `origin:example-${uniqueSuffix()}`;

    const [installationA, installationB] = await contending([
      ['machine', root, key, '6', '60000', '10', '25'],
      ['machine', root, key, '6', '60000', '10', '25'],
    ]);

    expect(installationA! + installationB!).toBe(6);
    expect(installationA).toBeGreaterThan(0);
    expect(installationB).toBeGreaterThan(0);
  }, 180_000);

  it('lets one installation stop without stranding the other', async () => {
    // Stopping or uninstalling one AI17Z must not take the other's ability to
    // make a request with it. The counters are files with timestamps in them:
    // there is no lease to reclaim and no service to restart.
    const root = mkdtempSync(join(tmpdir(), 'ai17z-quota-'));
    roots.push(root);
    const key = `origin:example-${uniqueSuffix()}`;

    expect((await child(['machine', root, key, '4', '60000', '4'])).granted).toBe(4);
    // That "installation" has now exited entirely. The next one reads the same
    // counters and is correctly told the budget is spent -- rather than finding
    // a held lock, or an empty ledger.
    expect((await child(['machine', root, key, '4', '60000', '2'])).granted).toBe(0);
  }, 120_000);

  it('separates two machines that are not sharing a directory', async () => {
    // The negative case, which is what makes the positive one mean anything.
    const one = mkdtempSync(join(tmpdir(), 'ai17z-quota-'));
    const two = mkdtempSync(join(tmpdir(), 'ai17z-quota-'));
    roots.push(one, two);
    const key = `origin:example-${uniqueSuffix()}`;

    const [a, b] = await Promise.all([
      child(['machine', one, key, '3', '60000', '5']),
      child(['machine', two, key, '3', '60000', '5']),
    ]);
    expect(a.granted).toBe(3);
    expect(b.granted).toBe(3);
  }, 120_000);
});
