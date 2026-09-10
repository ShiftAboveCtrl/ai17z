import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

/**
 * Starts both children and holds them until one agreed moment.
 *
 * Node takes a noticeable fraction of a second to start, which is longer than
 * the work -- so without an agreed start the first child finishes the whole
 * budget before the second is awake, and the test proves the counters add up
 * without proving anything ever contended for them.
 */
function theOff(inMs = 1_500): string {
  return String(Date.now() + inMs);
}

/** Runs the child, and reads the one line of JSON it prints. */
async function child(args: string[], env: NodeJS.ProcessEnv = {}): Promise<number> {
  const { stdout } = await run(process.execPath, [require.resolve('tsx/cli'), CHILD, ...args], {
    env: { ...process.env, ...env },
    cwd: resolve(__dirname, '..', '..'),
    timeout: 60_000,
  });
  const line = stdout.trim().split('\n').at(-1) ?? '{}';
  return (JSON.parse(line) as { granted: number }).granted;
}

describe("an installation's own budget, spent by two of its processes", () => {
  it('adds up to the capacity, not to twice it', async () => {
    // Ten attempts each against a budget of six. Uncoordinated, both would grant
    // six and the endpoint would see twelve.
    const key = `upstream:test-${uniqueSuffix()}`;
    const startAt = theOff();
    const [first, second] = await Promise.all([
      child(['db', key, '6', '60000', '10'], { QUOTA_CHILD_START_AT: startAt }),
      child(['db', key, '6', '60000', '10'], { QUOTA_CHILD_START_AT: startAt }),
    ]);

    expect(first + second).toBe(6);
    // And both of them did some of the work, so this is two processes competing
    // rather than one finishing before the other started.
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
  }, 120_000);

  it('keeps two different budgets apart', async () => {
    const [a, b] = await Promise.all([
      child(['db', `upstream:a-${uniqueSuffix()}`, '3', '60000', '5']),
      child(['db', `upstream:b-${uniqueSuffix()}`, '3', '60000', '5']),
    ]);
    expect(a).toBe(3);
    expect(b).toBe(3);
  }, 120_000);
});

describe('a budget an endpoint counts by address, shared by two installations', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('adds up to the capacity across installations that share nothing else', async () => {
    // ai17z-test and ai17z-main have separate databases and no table in common,
    // so this budget cannot live in either. What they do share is an address,
    // which is what the endpoint is counting -- so they share a directory of
    // counters and nothing else. No agent, no account, no credential.
    const root = mkdtempSync(join(tmpdir(), 'ai17z-quota-'));
    roots.push(root);
    const key = `origin:example-${uniqueSuffix()}`;

    const startAt = theOff();
    const [installationA, installationB] = await Promise.all([
      child(['machine', root, key, '6', '60000', '10', '25'], { QUOTA_CHILD_START_AT: startAt }),
      child(['machine', root, key, '6', '60000', '10', '25'], { QUOTA_CHILD_START_AT: startAt }),
    ]);

    expect(installationA + installationB).toBe(6);
    expect(installationA).toBeGreaterThan(0);
    expect(installationB).toBeGreaterThan(0);
  }, 120_000);

  it('lets one installation stop without stranding the other', async () => {
    // Stopping or uninstalling one AI17Z must not take the other's ability to
    // make a request with it. The counters are files with timestamps in them:
    // there is no lease to reclaim and no service to restart.
    const root = mkdtempSync(join(tmpdir(), 'ai17z-quota-'));
    roots.push(root);
    const key = `origin:example-${uniqueSuffix()}`;

    expect(await child(['machine', root, key, '4', '60000', '4'])).toBe(4);
    // That "installation" has now exited entirely. The next one reads the same
    // counters and is correctly told the budget is spent -- rather than finding
    // a held lock, or an empty ledger.
    expect(await child(['machine', root, key, '4', '60000', '2'])).toBe(0);
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
    expect(a).toBe(3);
    expect(b).toBe(3);
  }, 120_000);
});
