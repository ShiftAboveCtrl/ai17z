import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { QuotaCoordinator, QuotaWindow } from './quota';

/**
 * A budget an endpoint counts by source address, shared by every AI17Z on this
 * machine.
 *
 * ai17z-test and ai17z-main are separate installations with separate databases
 * and no table in common. A public endpoint that limits per IP does not know
 * that: it sees one caller. So a per-IP budget cannot live in either database,
 * and a coordinator that put it there would be claiming a guarantee the
 * architecture cannot make -- two installations would each spend the whole
 * allowance and the endpoint would see twice it.
 *
 * This is the smallest thing that actually coordinates them: a directory of
 * small counter files, one per budget, guarded by a lock file.
 *
 * ### What it does and does not contain
 *
 * Counts and timestamps, keyed by hostname. No agent, no account, no credential,
 * no query, no answer. Nothing here is private to an installation, which is what
 * makes sharing it acceptable at all -- and what makes it safe for one
 * installation to be stopped, upgraded or uninstalled while another runs. A
 * missing directory is recreated; a stale counter expires on its own.
 *
 * ### The scope it actually achieves, stated plainly
 *
 * Whatever directory it can write to without elevation. On Windows that is
 * usually a per-user path, so two installations run by **one user** coordinate
 * and two run by different users do not. On Linux it is a shared temporary
 * directory, so they do.
 *
 * `describeScope()` says which, and the health screen reports it. That is the
 * difference between a bounded design and a lie: an owner running AI17Z as two
 * users on one machine can be told the per-IP budget is not being shared rather
 * than discovering it from an endpoint operator.
 *
 * ### Why not a daemon
 *
 * Because a background service that must be running for AI17Z to make a request
 * is an undocumented core dependency, and the day it fails to start every
 * upstream in the product stops. Files degrade instead: if the directory cannot
 * be used, this says so and the caller falls back to counting alone, which is
 * wrong in the safe direction and visible.
 */

/** How long a lock may be held before it is assumed abandoned. */
const LOCK_STALE_MS = 5_000;

/** How long to keep trying for the lock before giving up on coordination. */
const LOCK_WAIT_MS = 2_000;

interface Ledger {
  /** Spends, as [whenMs, weight], per interval. Trimmed on every read. */
  windows: Record<string, [number, number][]>;
  /** When an operator told everything on this machine to wait. */
  blockedUntil?: number;
  why?: string;
}

function candidateRoots(): string[] {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    // ProgramData first: it is the one path shared by every user on the machine,
    // which is the scope a per-IP budget actually has.
    if (process.env.ProgramData) roots.push(join(process.env.ProgramData, 'AI17Z', 'upstream-quota'));
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'AI17Z', 'upstream-quota'));
  } else {
    roots.push('/var/tmp/ai17z-upstream-quota');
  }
  roots.push(join(tmpdir(), 'ai17z-upstream-quota'));
  return roots;
}

let chosenRoot: string | null = null;
let chosenWhy = '';

/** The directory this machine's installations are coordinating through. */
export function quotaDirectory(): { path: string | null; why: string } {
  if (chosenRoot) return { path: chosenRoot, why: chosenWhy };
  for (const root of candidateRoots()) {
    try {
      mkdirSync(root, { recursive: true });
      // Proved by writing, not by existing: a directory that is there and not
      // writable is the case that matters.
      const probe = join(root, '.probe');
      writeFileSync(probe, '1');
      rmSync(probe, { force: true });
      chosenRoot = root;
      chosenWhy =
        process.platform === 'win32' && root === join(process.env.ProgramData ?? '', 'AI17Z', 'upstream-quota')
          ? 'every installation on this machine, whichever user runs it'
          : 'every installation run by this user on this machine';
      return { path: chosenRoot, why: chosenWhy };
    } catch {
      // Try the next one. A machine where none works is a machine where each
      // installation counts alone, which the caller is told about.
    }
  }
  return { path: null, why: 'nowhere writable was found, so installations are counting separately' };
}

/** A filename for a budget, with nothing in it that a filename cannot hold. */
function fileFor(root: string, key: string): string {
  return join(root, `${key.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120)}.json`);
}

function readLedger(path: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
    return parsed && typeof parsed === 'object' && parsed.windows ? parsed : { windows: {} };
  } catch {
    // A missing file is an empty budget. A corrupt one is treated the same way
    // rather than failing every request on this machine: the worst case is one
    // interval counted from zero, and the alternative is an outage caused by a
    // half-written file.
    return { windows: {} };
  }
}

function writeLedger(path: string, ledger: Ledger): void {
  // Written beside and renamed, so a reader never sees half a file.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ledger));
  renameSync(temporary, path);
}

/** Holds the lock for one budget, or says it could not. */
async function withLock<T>(root: string, key: string, work: () => T): Promise<T | null> {
  const lockPath = `${fileFor(root, key)}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      // Exclusive create is the lock: whoever wins the race made the file.
      closeSync(openSync(lockPath, 'wx'));
      break;
    } catch {
      // A process killed mid-request would otherwise hold this for ever, so a
      // lock older than a few seconds is assumed abandoned and broken.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch {
        // It went away by itself, which is the outcome we wanted.
      }
      if (Date.now() > until) return null;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  try {
    return work();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

export class MachineQuotaCoordinator implements QuotaCoordinator {
  private readonly root: string | null;

  constructor(root?: string) {
    this.root = root ?? quotaDirectory().path;
  }

  /** Whether budgets are genuinely being shared, and with whom. */
  describeScope(): string {
    return this.root ? quotaDirectory().why : 'nowhere writable was found, so installations are counting separately';
  }

  async reserve(input: {
    key: string;
    windows: QuotaWindow[];
    weight: number;
    now: number;
  }): Promise<{ granted: true } | { granted: false; retryAfterMs: number; window: string }> {
    if (!this.root) return { granted: true };
    const path = fileFor(this.root, input.key);

    const outcome = await withLock(this.root, input.key, () => {
      const ledger = readLedger(path);
      if (ledger.blockedUntil && ledger.blockedUntil > input.now) {
        return {
          granted: false as const,
          retryAfterMs: ledger.blockedUntil - input.now,
          window: ledger.why ?? 'it asked us to wait',
        };
      }

      for (const window of input.windows) {
        const bucket = String(window.intervalMs);
        const entries = (ledger.windows[bucket] ?? []).filter(([at]) => at > input.now - window.intervalMs);
        ledger.windows[bucket] = entries;
        const used = entries.reduce((total, [, weight]) => total + weight, 0);
        if (used + input.weight > window.capacity) {
          const oldest = entries[0]?.[0] ?? input.now;
          return {
            granted: false as const,
            retryAfterMs: Math.max(1, oldest + window.intervalMs - input.now),
            window: window.label,
          };
        }
      }

      for (const window of input.windows) {
        const bucket = String(window.intervalMs);
        ledger.windows[bucket] = [...(ledger.windows[bucket] ?? []), [input.now, input.weight]];
      }
      writeLedger(path, ledger);
      return { granted: true as const };
    });

    // Could not take the lock in time. Allowing the request is the wrong
    // direction, so it is refused briefly instead -- a contended budget on a
    // busy machine is exactly when overshooting matters.
    if (outcome === null) return { granted: false, retryAfterMs: 250, window: 'a shared budget that is busy' };
    return outcome;
  }

  async blockUntil(input: { key: string; until: number; why: string }): Promise<void> {
    if (!this.root) return;
    const path = fileFor(this.root, input.key);
    await withLock(this.root, input.key, () => {
      const ledger = readLedger(path);
      if (!ledger.blockedUntil || ledger.blockedUntil < input.until) {
        ledger.blockedUntil = input.until;
        ledger.why = input.why.slice(0, 200);
        writeLedger(path, ledger);
      }
    });
  }

  async blockedFor(input: { key: string; now: number }): Promise<number> {
    if (!this.root) return 0;
    const ledger = readLedger(fileFor(this.root, input.key));
    if (!ledger.blockedUntil || ledger.blockedUntil <= input.now) return 0;
    return ledger.blockedUntil - input.now;
  }
}
