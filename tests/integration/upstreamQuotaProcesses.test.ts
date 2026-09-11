import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { installHarness } from '../support/harness';
import { createBarrier } from '../support/barrier';
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

/** Quota root directories to remove when the file is done. */
const roots: string[] = [];
/** Barriers to clean up, kept apart because they clean themselves. */
const barriers: { cleanup(): void }[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const barrier of barriers) barrier.cleanup();
});

interface ChildResult {
  granted: number;
  /** Reservations this process began. */
  started: number;
  /** Reservations that came back with an answer. */
  completed: number;
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
  return {
    granted: parsed.granted ?? 0,
    started: parsed.started ?? 0,
    completed: parsed.completed ?? 0,
    released: parsed.released ?? false,
  };
}

/** Runs children that must genuinely contend, and insists that they did. */
async function contending(args: string[][], attemptsEach: number): Promise<number[]> {
  const line = createBarrier();
  barriers.push(line);
  // Named rather than counted, so a timeout can say which child never arrived.
  const ids = args.map((_, index) => `child-${index}`);
  const running = args.map((argv, index) =>
    child(argv, { QUOTA_CHILD_BARRIER: line.directory, QUOTA_CHILD_ID: ids[index]! }),
  );

  // Both halves are asserted, and the parent's half first: if the children
  // never met, whatever counts they produced say nothing about contention, and
  // the old version let that surface later as a confusing number.
  const arrival = await line.releaseWhenReady(ids);
  const results = await Promise.all(running);

  expect(
    arrival.released,
    `these children never reached the line: ${arrival.missing.join(', ') || 'none'} -- the barrier did not hold`,
  ).toBe(true);

  // Participation, proved per child. This is what makes a grant count of zero
  // meaningful: that process competed for every one of its attempts and lost
  // them all, which is participation rather than absence.
  for (const [index, result] of results.entries()) {
    expect(result.released, `${ids[index]} ran without being released`).toBe(true);
    expect(result.started, `${ids[index]} did not begin all its attempts`).toBe(attemptsEach);
    expect(result.completed, `${ids[index]} did not complete all its attempts`).toBe(attemptsEach);
  }
  return results.map((result) => result.granted);
}

describe("an installation's own budget, spent by two of its processes", () => {
  it('adds up to the capacity, not to twice it', async () => {
    // Ten attempts each against a budget of six. Uncoordinated, both would grant
    // six and the endpoint would see twelve.
    const key = `upstream:test-${uniqueSuffix()}`;
    const [first, second] = await contending(
      [
        ['db', key, '6', '60000', '10'],
        ['db', key, '6', '60000', '10'],
      ],
      10,
    );

    // The claim: twenty attempts from two processes against a budget of six
    // grant six. Uncoordinated, each would grant six and the endpoint would see
    // twelve.
    expect(first! + second!).toBe(6);

    // Deliberately NOT asserting that each child won at least one.
    //
    // That assertion was here, and it failed on Linux while the sum was still
    // correct -- so the budget was never overspent and the test failed anyway.
    // Every reservation takes an advisory lock, so whichever child's
    // connections queue first can win all six while the other's ten are all
    // correctly refused. The distribution is scheduling, not evidence.
    //
    // What proves contention is structural and above: both processes reached
    // the barrier, were released together, and each completed all ten
    // attempts. A child that won nothing still competed for everything.
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

    const [installationA, installationB] = await contending(
      [
        ['machine', root, key, '6', '60000', '10', '25'],
        ['machine', root, key, '6', '60000', '10', '25'],
      ],
      10,
    );

    // Same reasoning as the database case: the sum is the claim, and both
    // installations completing all ten attempts is what makes it contention.
    expect(installationA! + installationB!).toBe(6);
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
