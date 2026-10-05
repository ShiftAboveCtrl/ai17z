/**
 * What one tenant's AI17Z runtime was measured to need, and what follows.
 *
 * A plan sized from a developer's machine is sized from the wrong machine: the
 * Windows installation this was written on runs Docker, three Node processes
 * and a browser, and none of that is what a hosted tenant is. So the figures
 * here come from inside a guest, printed by the runtime itself at the end of
 * its own boot, and each one carries how it was obtained.
 *
 * Nothing in here is a price. It is the input a price needs: a size that holds
 * a tenant is the smallest fact a plan cannot be invented without.
 *
 * The measurement is deliberately a record rather than a constant. A footprint
 * taken once and then trusted for ever is a guess with a date on it, so
 * `staleAfterDays` says when it stops counting, and `judgeFootprint` says so
 * rather than quietly carrying on.
 */

/** How a figure was obtained, so a reader can disbelieve it on the right grounds. */
export type FootprintMethod =
  /** Read from inside the running guest, by the runtime, at the end of its boot. */
  | 'IN_GUEST'
  /** Read from the host about the guest, which sees the VM and not the workload. */
  | 'FROM_HOST'
  /** Taken from a provider's or a project's own documentation. */
  | 'DOCUMENTED';

export interface TenantFootprint {
  /** What was running when this was taken. A footprint of a different version is a different footprint. */
  version: string;
  /** When it was taken, so `judgeFootprint` can say it has expired. */
  measuredAt: string;
  method: FootprintMethod;
  /** Resident memory the whole tenant runtime used, in MiB: Postgres, the api, the worker, the migrations having run. */
  memoryMb: number;
  /** vCPUs the measurement was taken with. It is not a requirement; it is the condition. */
  vcpus: number;
  /** The tenant's database after its schema exists and before it holds anything, in MiB. */
  databaseMb: number;
  /** The runtime's own files, in MiB: the application, its dependencies, the Node it runs on. */
  imageMb: number;
  /** Whether a browser was running. A tenant that drives Chrome is a different size, and this says which was measured. */
  withBrowser: boolean;
  /** One sentence on what produced it. */
  how: string;
}

/**
 * The measurement, from the lab.
 *
 * Taken by `packaging/hosted-lab/bin/two-tenant-proof.sh`: two guests booted at
 * once under Firecracker, each running the canonical AI17Z against its own
 * Postgres, each reporting its own memory at the end of its own boot. The
 * higher of the two readings is the one kept, because a plan sized on the
 * luckier guest is sized on luck.
 *
 * `withBrowser` is false and that is the significant limitation: a tenant whose
 * agent drives real Chrome needs what `packages/shared/src/resources.ts` already
 * says Chrome needs, and this figure is the floor underneath that rather than
 * the whole of it.
 */
export const MEASURED_TENANT_FOOTPRINT: TenantFootprint = {
  version: 'v1.0.0-beta.63',
  measuredAt: '2026-10-05T07:23:00.000Z',
  method: 'IN_GUEST',
  memoryMb: 575,
  vcpus: 2,
  databaseMb: 14,
  imageMb: 621,
  withBrowser: false,
  how: 'Two Firecracker guests at once, each with Postgres 16, 106 migrations applied, the api answering its own health endpoint and the worker reporting ready. The higher of the two memory readings.',
};

/** How long a footprint counts for. Past this it is a figure with a date, not a measurement. */
export const STALE_AFTER_DAYS = 90;

/**
 * Headroom over the measured figure, and why it is this much.
 *
 * A runtime sized at exactly what it was seen to use has nowhere to go when a
 * tenant does the thing it exists to do. Half again is not a margin somebody
 * liked the look of: `resources.ts` already gives Chrome up to half the
 * machine at any size, so a tenant that opens a browser needs room for a
 * second thing roughly its own size before any of that applies.
 */
export const HEADROOM = 1.5;

export type FootprintVerdict =
  | { usable: true; memoryMb: number; why: string }
  | { usable: false; why: string };

/**
 * What to size a tenant at, or why the measurement cannot answer.
 *
 * Returns the memory a runtime should be given, not the memory it used. The
 * difference is the whole point: `HEADROOM` is applied here, once, rather than
 * by each caller deciding for itself how generous to be.
 */
export function judgeFootprint(footprint: TenantFootprint, now: Date): FootprintVerdict {
  const takenAt = Date.parse(footprint.measuredAt);
  if (Number.isNaN(takenAt)) {
    return { usable: false, why: 'The measurement has no usable date, so nothing can say whether it still holds.' };
  }
  const days = (now.getTime() - takenAt) / 86_400_000;
  if (days < 0) {
    return { usable: false, why: 'The measurement is dated in the future, which means a clock somewhere is wrong.' };
  }
  if (days > STALE_AFTER_DAYS) {
    return {
      usable: false,
      why: `The measurement is ${Math.floor(days)} days old, past ${STALE_AFTER_DAYS}. Measure it again rather than pricing from it.`,
    };
  }
  if (footprint.memoryMb <= 0) {
    return { usable: false, why: 'A footprint of no memory is not a measurement.' };
  }
  const needed = Math.ceil(footprint.memoryMb * HEADROOM);
  const browser = footprint.withBrowser
    ? 'measured with a browser running'
    : 'measured with no browser running, so a tenant that drives Chrome needs more than this';
  return {
    usable: true,
    memoryMb: needed,
    why: `${footprint.memoryMb} MB observed ${footprint.method === 'IN_GUEST' ? 'inside the guest' : 'from outside it'}, ${browser}. Sized at ${needed} MB.`,
  };
}

/** What a size has to offer to hold one tenant. */
export interface Capacity {
  vcpus: number;
  memoryMb: number;
}

export type SizingVerdict =
  | { fits: true; why: string }
  | { fits: false; why: string };

/**
 * Whether a confidential size holds one tenant, judged against the measurement
 * rather than against an opinion.
 *
 * A size is refused for being too small and never adjusted to fit: a plan that
 * trims the headroom to make a cheaper size work has priced the wrong thing.
 */
export function sizeHoldsTenant(capacity: Capacity, footprint: TenantFootprint, now: Date): SizingVerdict {
  const verdict = judgeFootprint(footprint, now);
  if (!verdict.usable) return { fits: false, why: verdict.why };
  if (capacity.vcpus < footprint.vcpus) {
    return {
      fits: false,
      why: `Measured on ${footprint.vcpus} vCPU and this size has ${capacity.vcpus}. A measurement does not carry down to a smaller machine.`,
    };
  }
  if (capacity.memoryMb < verdict.memoryMb) {
    return { fits: false, why: `${capacity.memoryMb} MB against ${verdict.memoryMb} MB needed. ${verdict.why}` };
  }
  return {
    fits: true,
    why: `${capacity.memoryMb} MB and ${capacity.vcpus} vCPU against ${verdict.memoryMb} MB needed. ${verdict.why}`,
  };
}

/**
 * How many tenants one size could hold, which is a question worth refusing.
 *
 * It returns a count only for a runtime that is explicitly shared, and the
 * hosted design does not have one: different customers get different databases,
 * master keys, filesystems and browser profiles, so two of them in one VM is
 * not a smaller version of this product. The function exists so that the answer
 * is written down once, where somebody looking for it will find it.
 */
export function tenantsPerRuntime(): { count: 1; why: string } {
  return {
    count: 1,
    why: 'One tenant per confidential runtime. Several of one customer\'s agents may share it; two customers may not, because they would share a master key and a database.',
  };
}

export const FOOTPRINT_CAVEATS: readonly string[] = [
  'Measured with no browser running. A tenant whose agent drives Chrome needs what resources.ts says Chrome needs on top of this.',
  'Measured idle, immediately after boot. A tenant under load is the next measurement and is not this one.',
  'Measured on Firecracker, not on a confidential VM. A confidential guest carries encryption overhead that has not been measured, and nothing here accounts for it.',
  'The database figure is a schema with nothing in it. It grows with memory, events, jobs and analytics, and the storage line in the cost ledger is where that belongs.',
];
