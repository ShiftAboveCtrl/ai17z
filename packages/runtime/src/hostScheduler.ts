import {
  HOST_SCHEDULABLE_STATES,
  TIER_REQUIREMENTS,
  tierMayHoldTenants,
  type HostCapacity,
  type HostState,
  type ProviderTier,
  type RuntimeClass,
} from '@xbam/shared/contracts';

/**
 * Where a tenant runtime is allowed to go, and when the answer is nowhere.
 *
 * The scheduler's job is to refuse. Saying yes is easy and is what a machine
 * that falls over has been told all day; the value here is that a host cannot
 * be promised more than it has, and that a tenant cannot land on hardware that
 * has not earned the right to hold one.
 *
 * Nothing in this file invents a capacity number. Every figure it reasons
 * about arrives from a host that measured itself, and the reservation comes
 * from a runtime class somebody wrote down. There is no "supports N agents"
 * anywhere: a safe slot count is whatever measurement on the real hardware
 * says, which is why the headroom below is a fraction of what was reported
 * rather than a constant somebody liked.
 */

/**
 * How much of a host is deliberately left unused.
 *
 * A machine run to its measured limit has nothing left for the spike, the
 * upgrade, the recycled Chrome renderer or the backup that all arrive at once.
 * AI17Z already refuses to give Chrome more than half a machine locally and
 * delays background work under pressure rather than dropping it; this is the
 * same instinct one level up.
 */
export const HOST_HEADROOM = {
  /** Fraction of reported memory that may be reserved. */
  memory: 0.8,
  /** Fraction of reported cores that may be reserved. */
  cpu: 0.8,
  /** Fraction of reported disk that may be reserved. */
  disk: 0.9,
} as const;

export interface HostForScheduling {
  id: string;
  state: HostState;
  tier: ProviderTier;
  capacity: HostCapacity;
  /** What is already reserved on it, summed from live deployments. */
  reserved: { cpuCores: number; memoryMb: number; diskGb: number; runtimes: number; browserRuntimes: number };
  /** Seconds since the last heartbeat, or null if it has never sent one. */
  heartbeatAgeSec: number | null;
}

export interface PlacementRequest {
  runtimeClass: RuntimeClass;
  /** Keep a tenant where it was, so a browser session is not moved casually. */
  preferHostId?: string | null;
  /** Where the tenant should be, when that has been chosen. */
  region?: string | null;
  runtimeVersion: string;
}

export interface Refusal {
  hostId: string;
  code: string;
  detail: string;
}

export type Placement =
  | { placed: true; hostId: string; detail: string; refusals: Refusal[] }
  | { placed: false; refusals: Refusal[] };

/**
 * A host is only considered live if it has said so recently.
 *
 * The same reasoning as the browser heartbeat: anything older than this is
 * treated as no host at all, whatever its recorded state claims, because a
 * row saying ACTIVE is a memory and a heartbeat is evidence.
 */
export const HEARTBEAT_STALE_AFTER_SEC = 90;

/** What this class would take from a host. */
function reservationFor(klass: RuntimeClass) {
  return {
    cpuCores: klass.cpuCores,
    memoryMb: klass.memoryMb,
    diskGb: klass.diskGb,
    runtimes: 1,
    browserRuntimes: klass.browser ? 1 : 0,
  };
}

/**
 * Every reason this host cannot take this runtime.
 *
 * All of them, not the first: an operator looking at why nothing can be
 * placed wants the shape of the problem, and "no capacity" when the real
 * answer is "wrong region and the version is not installed" wastes a day.
 */
export function refusalsFor(host: HostForScheduling, request: PlacementRequest): Refusal[] {
  const out: Refusal[] = [];
  const no = (code: string, detail: string) => out.push({ hostId: host.id, code, detail });

  if (!tierMayHoldTenants(host.tier)) {
    const needs = TIER_REQUIREMENTS[host.tier];
    no(
      'TIER_NOT_ENABLED',
      `${host.tier} may not hold tenants yet. Outstanding: ${needs.length > 0 ? needs.join(' ') : 'none recorded.'}`,
    );
  }
  if (!HOST_SCHEDULABLE_STATES.includes(host.state)) {
    no('HOST_NOT_SCHEDULABLE', `The host is ${host.state}.`);
  }
  if (host.heartbeatAgeSec === null) {
    no('NO_HEARTBEAT', 'The host has never reported in, so it is not known to be alive.');
  } else if (host.heartbeatAgeSec > HEARTBEAT_STALE_AFTER_SEC) {
    no('HEARTBEAT_STALE', `The last heartbeat was ${host.heartbeatAgeSec}s ago, past ${HEARTBEAT_STALE_AFTER_SEC}s.`);
  }
  if (request.region && host.capacity.region !== request.region) {
    no('WRONG_REGION', `The host is in ${host.capacity.region} and ${request.region} was asked for.`);
  }
  if (!host.capacity.runtimeVersions.includes(request.runtimeVersion)) {
    no('VERSION_NOT_AVAILABLE', `The host cannot run ${request.runtimeVersion}.`);
  }

  const want = reservationFor(request.runtimeClass);
  if (want.browserRuntimes > 0 && host.capacity.browserSlots === 0) {
    no('NO_BROWSER_CAPACITY', 'The host holds no browser runtimes.');
  }

  // Headroom is applied to what the host reported, so a machine is never run
  // to its measured limit.
  const allowedCpu = host.capacity.cpuCores * HOST_HEADROOM.cpu;
  const allowedMemory = host.capacity.memoryMb * HOST_HEADROOM.memory;
  const allowedDisk = host.capacity.diskGb * HOST_HEADROOM.disk;

  if (host.reserved.cpuCores + want.cpuCores > allowedCpu) {
    no('NO_CPU', `${host.reserved.cpuCores + want.cpuCores} cores would be reserved of ${allowedCpu} usable.`);
  }
  if (host.reserved.memoryMb + want.memoryMb > allowedMemory) {
    no('NO_MEMORY', `${host.reserved.memoryMb + want.memoryMb}MB would be reserved of ${allowedMemory}MB usable.`);
  }
  if (host.reserved.diskGb + want.diskGb > allowedDisk) {
    no('NO_DISK', `${host.reserved.diskGb + want.diskGb}GB would be reserved of ${allowedDisk}GB usable.`);
  }
  if (host.reserved.runtimes + 1 > host.capacity.runtimeSlots) {
    no('NO_SLOTS', `${host.capacity.runtimeSlots} runtime slots are all taken.`);
  }
  if (want.browserRuntimes > 0 && host.reserved.browserRuntimes + 1 > host.capacity.browserSlots) {
    no('NO_BROWSER_SLOTS', `${host.capacity.browserSlots} browser slots are all taken.`);
  }
  return out;
}

/**
 * Choose a host, or explain why none will do.
 *
 * Sticky placement first: a tenant driving a browser should stay where its
 * Chrome profile and its egress address already are, because moving a
 * signed-in session to a new address is how an account picks up a security
 * challenge nobody asked for. Stability is not a disguise, and it is not to
 * be sold as one: it is the same machine continuing to be the same machine.
 *
 * Otherwise the emptiest acceptable host wins, measured by memory, which is
 * the resource a hosted AI17Z actually runs out of first.
 */
export function placeRuntime(hosts: readonly HostForScheduling[], request: PlacementRequest): Placement {
  const refusals: Refusal[] = [];
  const usable: HostForScheduling[] = [];

  for (const host of hosts) {
    const no = refusalsFor(host, request);
    if (no.length > 0) refusals.push(...no);
    else usable.push(host);
  }
  if (usable.length === 0) return { placed: false, refusals };

  const sticky = request.preferHostId ? usable.find((h) => h.id === request.preferHostId) : undefined;
  if (sticky) {
    return { placed: true, hostId: sticky.id, detail: 'Kept on the host it was already on.', refusals };
  }

  const freest = [...usable].sort((a, b) => {
    const freeA = a.capacity.memoryMb * HOST_HEADROOM.memory - a.reserved.memoryMb;
    const freeB = b.capacity.memoryMb * HOST_HEADROOM.memory - b.reserved.memoryMb;
    // Ties broken by id so placement is deterministic and a test can assert it.
    return freeB - freeA || a.id.localeCompare(b.id);
  })[0]!;

  /*
    A first placement and a move read identically unless the answer says
    which. The move is the one an operator has to see: a tenant driving a
    browser that changes machine changes egress address, and that is how an
    account picks up a security challenge nobody asked for. The refusals were
    in the result already; nothing said they were the reason this runtime left.
  */
  const movedFrom = request.preferHostId
    ? refusals.filter((r) => r.hostId === request.preferHostId).map((r) => r.detail)
    : [];
  const detail =
    movedFrom.length > 0
      ? `Moved off ${request.preferHostId} to the emptiest acceptable host in ${freest.capacity.region}. It was refused: ${movedFrom.join(' ')}`
      : `Chosen as the emptiest acceptable host in ${freest.capacity.region}.`;

  return { placed: true, hostId: freest.id, detail, refusals };
}
