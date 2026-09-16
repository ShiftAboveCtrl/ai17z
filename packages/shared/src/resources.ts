import { existsSync } from 'node:fs';
import { freemem, totalmem, platform } from 'node:os';

/**
 * What this machine can afford AI17Z to use.
 *
 * ## Why this exists at all
 *
 * AI17Z drives a real Chrome, and a real Chrome will use every byte a machine
 * will give it. On 2026-09-15 a live installation's mentions renderer reached
 * 3,754 MB against V8's 4,192 MB ceiling and Chrome killed it: "Aw, Snap!
 * Out of Memory". Three monitors then failed for fifty-six minutes. The
 * measurements are in `docs/architecture/BROWSER_RESOURCES.md`.
 *
 * The wrong fix is to ask for more RAM. AI17Z runs on somebody's own laptop,
 * beside their editor and their browser and whatever else they were doing, and
 * a local-first product that needs the machine to itself is not local-first.
 * So there is a budget, it is derived from what the machine actually has, and
 * **it always leaves headroom it will not touch.**
 *
 * ## One budget, not thresholds scattered about
 *
 * Every limit that depends on how much memory there is comes from here. A
 * number that lives next to the code that uses it is a number nobody can tune
 * and nobody can test, and four of them disagree within a month.
 *
 * ## Honest where a platform cannot answer
 *
 * `totalmem` is available everywhere Node runs. Everything finer is not, so
 * anything this cannot measure is reported as unknown rather than guessed, and
 * an unknown machine gets the NORMAL budget -- the one that behaves like the
 * product always did.
 */

/** How much memory a machine has, in the only three sizes worth deciding on. */
export const MEMORY_CLASSES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

/** How much of what it has is currently spoken for. */
export const PRESSURE_STATES = ['NORMAL', 'PRESSURED', 'CRITICAL'] as const;
export type PressureState = (typeof PRESSURE_STATES)[number];

export interface HostMemory {
  /** Bytes of physical memory. Available on every platform Node supports. */
  totalBytes: number;
  /**
   * Whether this process is inside a container, and so cannot see the machine.
   *
   * It matters for what is *said*, not for what is decided. `totalmem` inside a
   * container reports the container's share -- on Windows the API container
   * read 30.9 GB of a 63 GB machine -- and a health row that calls that "the
   * machine" is telling the owner something untrue. The process that decides
   * Chrome's budget is the browser worker, which runs on the host and sees the
   * real figure, so the decision was never wrong. The sentence was.
   */
  inContainer: boolean;
  /**
   * Bytes not currently in use, where the platform will say.
   *
   * Null rather than zero when unknown: zero is a measurement, and acting on a
   * measurement nobody took is how a guard fires on a machine that was fine.
   */
  availableBytes: number | null;
}

export interface ResourceBudget {
  memoryClass: MemoryClass;
  totalBytes: number;
  /**
   * What AI17Z's Chrome should stay under, and what it must not exceed.
   *
   * Soft is where recycling starts; hard is where new browser work waits. Both
   * are a share of the machine rather than a constant, because 1.5 GB is
   * generous on an 8 GB laptop and nothing at all on a 64 GB desktop.
   */
  chromeSoftBytes: number;
  chromeHardBytes: number;
  /** What the worker's own heap is sized to, passed to Node as --max-old-space-size. */
  workerHeapMb: number;
  /**
   * How many X tabs may hold a live SPA at once.
   *
   * Never fewer than two: ACTION has to stay live while something reads, or a
   * reply waits behind a monitor. The role map is unchanged whatever this is --
   * this bounds how many are *rendered*, not how many exist.
   */
  maxLiveTabs: number;
  /** How many browser operations may run at once. */
  browserConcurrency: number;
  /**
   * The share of V8's own heap ceiling at which a tab is recycled.
   *
   * Well below the ceiling, because the crash happens on the allocation that
   * crosses it and the tab is gone before anything can act. Measured growth on
   * a mentions tab was roughly 100 MB per search cycle, so a tab at 60% has
   * several minutes of warning and one at 95% has none.
   */
  tabRecycleHeapFraction: number;
}

/** Below this a machine is small enough that Chrome and Docker will collide. */
const LOW_MEMORY_BYTES = 10 * 1024 ** 3;
/** Above this there is room to be generous, though never unbounded. */
const HIGH_MEMORY_BYTES = 24 * 1024 ** 3;

const GB = 1024 ** 3;

/**
 * What class of machine this is.
 *
 * Exported and pure so the mapping can be tested at sizes no test machine has.
 */
export function memoryClassFor(totalBytes: number): MemoryClass {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 'NORMAL';
  if (totalBytes < LOW_MEMORY_BYTES) return 'LOW';
  if (totalBytes >= HIGH_MEMORY_BYTES) return 'HIGH';
  return 'NORMAL';
}

/**
 * The budget for a machine of a given size.
 *
 * Pure, so the shape of the curve is a test rather than an opinion. Three
 * properties hold at every size and each one is pinned:
 *
 *   - Chrome's hard budget is never more than **half** the machine. The other
 *     half is the operating system, Docker, and whatever the owner is actually
 *     doing. A browser automation tool that takes the whole machine is one
 *     people uninstall.
 *   - The soft budget is always below the hard one, so there is somewhere to
 *     recycle *before* anything has to wait.
 *   - Nothing is ever zero or negative, whatever nonsense comes in.
 */
export function budgetFor(totalBytes: number): ResourceBudget {
  const memoryClass = memoryClassFor(totalBytes);
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 8 * GB;

  // A share of the machine, then capped. The cap is what stops a 128 GB
  // workstation deciding it may hold 64 GB of Chrome: past a point more
  // headroom buys nothing, because a single renderer still dies at V8's own
  // ceiling however much is free.
  const softShare = memoryClass === 'LOW' ? 0.22 : memoryClass === 'HIGH' ? 0.28 : 0.25;
  const chromeSoftBytes = Math.min(Math.round(total * softShare), 6 * GB);
  const chromeHardBytes = Math.min(Math.round(total * (softShare + 0.12)), 9 * GB);

  return {
    memoryClass,
    totalBytes: total,
    chromeSoftBytes,
    chromeHardBytes,
    // Deliberately modest. The worker holds normalised records and job rows,
    // not pages; when it has needed more than this it has been a leak rather
    // than a workload.
    workerHeapMb: memoryClass === 'LOW' ? 512 : memoryClass === 'HIGH' ? 1536 : 1024,
    maxLiveTabs: memoryClass === 'LOW' ? 2 : memoryClass === 'HIGH' ? 4 : 3,
    browserConcurrency: memoryClass === 'LOW' ? 1 : memoryClass === 'HIGH' ? 3 : 2,
    // Tighter on a small machine, because there the operating system will kill
    // the renderer before V8's own ceiling is anywhere in sight.
    tabRecycleHeapFraction: memoryClass === 'LOW' ? 0.45 : memoryClass === 'HIGH' ? 0.65 : 0.6,
  };
}

/**
 * How much of the machine is spoken for right now.
 *
 * `UNKNOWN` is not a state: a platform that will not say how much is free gets
 * NORMAL, because throttling a machine nobody has measured is a product that
 * mysteriously does less on hardware that was fine.
 */
export function pressureFor(memory: HostMemory): PressureState {
  if (memory.availableBytes === null || !Number.isFinite(memory.availableBytes)) return 'NORMAL';
  if (memory.totalBytes <= 0) return 'NORMAL';
  const free = memory.availableBytes / memory.totalBytes;
  if (free <= 0.06) return 'CRITICAL';
  if (free <= 0.15) return 'PRESSURED';
  return 'NORMAL';
}

/**
 * What to do less of, given the pressure.
 *
 * Returned as a multiplier rather than a second set of limits, so there is one
 * place that says how big the budget is and one that says how much of it to use.
 * Durable work is never dropped -- `pauseBackground` delays it.
 */
export function throttleFor(state: PressureState): {
  concurrencyFactor: number;
  pauseBackground: boolean;
  recycleIdleTabs: boolean;
} {
  switch (state) {
    case 'CRITICAL':
      return { concurrencyFactor: 0.34, pauseBackground: true, recycleIdleTabs: true };
    case 'PRESSURED':
      return { concurrencyFactor: 0.5, pauseBackground: true, recycleIdleTabs: true };
    default:
      return { concurrencyFactor: 1, pauseBackground: false, recycleIdleTabs: false };
  }
}

/**
 * What the operating system says, through the one interface Node has everywhere.
 *
 * `freemem` means different things on different platforms -- on Linux it
 * excludes reclaimable page cache and so reads far lower than what an
 * application could actually get -- and this does not pretend otherwise. It is
 * used for a three-state verdict with wide bands, which is about as much as
 * that number can honestly carry.
 */
export function readHostMemory(): HostMemory {
  const totalBytes = totalmem();
  let availableBytes: number | null = null;
  try {
    const free = freemem();
    availableBytes = Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    // A platform that will not answer is reported as not having answered.
    availableBytes = null;
  }
  let inContainer = false;
  try {
    inContainer = existsSync('/.dockerenv');
  } catch {
    // Not being able to tell is the same as not being in one, for the purpose
    // of choosing a word.
    inContainer = false;
  }
  return { totalBytes, availableBytes, inContainer };
}

/** This machine's budget, measured now. */
export function currentBudget(): ResourceBudget {
  return budgetFor(readHostMemory().totalBytes);
}

/** This machine's pressure, measured now. */
export function currentPressure(): PressureState {
  return pressureFor(readHostMemory());
}

/** For the health screen, which shows the owner what AI17Z decided and why. */
export function describeBudget(budget: ResourceBudget, state: PressureState, inContainer = false): string {
  const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
  // Inside a container this is the container's share, not the machine's, and
  // saying "machine" there is simply false.
  const machine = inContainer
    ? `${gb(budget.totalBytes)} available to AI17Z (${budget.memoryClass.toLowerCase()})`
    : `${gb(budget.totalBytes)} machine (${budget.memoryClass.toLowerCase()})`;
  const chrome = `browser budget ${gb(budget.chromeSoftBytes)}, ceiling ${gb(budget.chromeHardBytes)}`;
  const doing =
    state === 'NORMAL'
      ? 'running normally'
      : state === 'PRESSURED'
        ? 'memory is tight, so background work is waiting'
        : 'memory is very tight, so only essential browser work is running';
  return `${machine}; ${chrome}; ${doing}. Platform: ${platform()}.`;
}
