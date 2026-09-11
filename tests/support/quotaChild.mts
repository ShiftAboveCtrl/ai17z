/**
 * One process competing for a shared upstream budget.
 *
 * Spawned twice by `upstreamQuotaProcesses.test.ts`, because the claim being
 * tested is about processes and two callers inside one module share every
 * variable in it -- including the in-memory coordinator that this whole exercise
 * exists to stop production using. A test that proved coordination by
 * constructing two objects would prove nothing at all.
 *
 * Prints one line of JSON: how many of its attempts were granted.
 *
 *   quotaChild.mts db <key> <capacity> <intervalMs> <attempts>
 *   quotaChild.mts machine <root> <key> <capacity> <intervalMs> <attempts>
 */
import { upstreamQuota as quotaRepo } from '@xbam/database';
import { MachineQuotaCoordinator, perSecond } from '@xbam/upstream';
import { waitAtBarrier } from './barrier';

const [mode, ...rest] = process.argv.slice(2);

/**
 * Waits at the line, using the same barrier the parent does.
 *
 * Shared rather than reimplemented here: it is the only evidence that these
 * two processes ever met, so it has tests of its own in
 * `tests/unit/testBarrier.test.ts`.
 */
async function waitForRelease(): Promise<boolean> {
  const directory = process.env.QUOTA_CHILD_BARRIER;
  const id = process.env.QUOTA_CHILD_ID;
  if (!directory || !id) return false;
  return waitAtBarrier(directory, id);
}

async function throughDatabase(): Promise<number> {
  const [key, capacity, intervalMs, attempts] = rest;
  // All at once, deliberately. Sequential reservations are a round trip apart,
  // which is long enough that two processes rarely have a transaction open
  // together -- so a sequential test passes whether or not anything is
  // serialising them, which is exactly the green that proves nothing. Fired
  // together, the reads genuinely overlap and only the lock keeps the sum right.
  const outcomes = await Promise.all(
    Array.from({ length: Number(attempts) }, () =>
      quotaRepo.reserve({
        quotaKey: key!,
        windows: [{ capacity: Number(capacity), intervalMs: Number(intervalMs), label: 'test window' }],
        weight: 1,
      }),
    ),
  );
  return outcomes.filter((outcome) => outcome.granted).length;
}

async function throughFiles(): Promise<number> {
  const [root, key, capacity, intervalMs, attempts, gapMs] = rest;
  const coordinator = new MachineQuotaCoordinator(root!);
  const window = { ...perSecond(Number(capacity), { scope: 'MACHINE' }), intervalMs: Number(intervalMs) };
  let granted = 0;
  for (let i = 0; i < Number(attempts); i += 1) {
    const outcome = await coordinator.reserve({ key: key!, windows: [window], weight: 1, now: Date.now() });
    if (outcome.granted) granted += 1;
    // A gap, so two children genuinely interleave. One reservation is a few
    // file operations and takes well under a millisecond, so without it a whole
    // run finishes inside the other child's lock poll and the counters add up
    // without anything ever having contended.
    const gap = Number(gapMs);
    if (Number.isFinite(gap) && gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
  }
  return granted;
}

try {
  const released = await waitForRelease();
  const granted = mode === 'db' ? await throughDatabase() : await throughFiles();
  // `released` travels with the count, so the parent can tell a real result
  // from one where the children never actually met at the line.
  process.stdout.write(`${JSON.stringify({ granted, released })}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
