import { createHash } from 'node:crypto';
import { HostCapacity, type ProviderTier } from '@xbam/shared/contracts';

/**
 * What a machine offering capacity actually does, as decisions rather than as
 * a network loop.
 *
 * The daemon itself is a thin process: it connects outward, says what it has,
 * accepts assignments and reports health. Everything interesting about it is a
 * judgement that can be made without a socket, so the judgements live here and
 * are tested directly, and the process around them stays small enough to read.
 *
 * Three shapes are deliberate.
 *
 * **Outbound only.** A host dials the control plane; the control plane never
 * dials a host. So there is no listening port to secure, no inbound firewall
 * rule to get wrong, and a host behind anybody's NAT works the same as one in
 * a rack. Nothing in this file opens a server.
 *
 * **Measured, not declared.** `capacityFrom` takes what the operating system
 * reports and subtracts what the host needs for itself. A capacity figure
 * somebody typed is a promise the machine never made.
 *
 * **It proves a key; it is never trusted on its word.** The daemon signs what
 * it says with a key whose public half an administrator enrolled. Identity is
 * not a name in a payload, and a host that was revoked cannot talk its way
 * back by continuing to report.
 */

/** What the daemon reserves for itself, before anything is offered to a tenant. */
export const HOST_OVERHEAD = {
  /** The daemon, the supervisor and the operating system. */
  memoryMb: 2_048,
  cpuCores: 1,
  /** Images, logs and a backup staging area. */
  diskGb: 20,
} as const;

/**
 * Memory a runtime class needs before it can hold a browser.
 *
 * Not a guess: AI17Z already measures that an X SPA renderer grows past three
 * gigabytes before it is recycled, which is why tabs have bounded lifetimes
 * locally. A host that offers browser slots it cannot feed produces renderers
 * killed for memory, and a renderer killed for memory looks exactly like a run
 * of failed polls.
 */
export const BROWSER_SLOT_MEMORY_MB = 4_096;

export interface MachineReport {
  /** From the operating system, not from configuration. */
  totalMemoryMb: number;
  cpuCores: number;
  freeDiskGb: number;
  /** Whether a real browser is actually present and runnable here. */
  browserPresent: boolean;
  region: string;
  runtimeVersions: readonly string[];
}

/**
 * Turn what a machine reports into what it may offer.
 *
 * Returns a reason rather than a capacity when a machine is too small to hold
 * anything, because "this host advertised zero slots" is harder to act on than
 * "this host has 1GB of usable memory after overhead".
 */
export function capacityFrom(report: MachineReport): { ok: true; capacity: HostCapacity } | { ok: false; why: string } {
  const memoryMb = report.totalMemoryMb - HOST_OVERHEAD.memoryMb;
  const cpuCores = report.cpuCores - HOST_OVERHEAD.cpuCores;
  const diskGb = report.freeDiskGb - HOST_OVERHEAD.diskGb;

  if (memoryMb < 1_024 || cpuCores < 1 || diskGb < 10) {
    return {
      ok: false,
      why: `After overhead this machine has ${memoryMb}MB, ${cpuCores} cores and ${diskGb}GB usable, which is not enough to hold a runtime.`,
    };
  }

  // Slots are whichever bound runs out first. Memory is usually it, which is
  // why the scheduler sorts on memory too.
  const runtimeSlots = Math.max(0, Math.min(Math.floor(memoryMb / 1_024), Math.floor(cpuCores * 2)));
  const browserSlots = report.browserPresent ? Math.min(runtimeSlots, Math.floor(memoryMb / BROWSER_SLOT_MEMORY_MB)) : 0;

  const parsed = HostCapacity.safeParse({
    cpuCores,
    memoryMb,
    diskGb,
    runtimeSlots,
    browserSlots,
    gpus: 0,
    region: report.region,
    runtimeVersions: [...report.runtimeVersions],
  });
  if (!parsed.success) {
    return { ok: false, why: `The measured capacity is not usable: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  return { ok: true, capacity: parsed.data };
}

/**
 * How often a host speaks, and when the control plane should stop believing it.
 *
 * A third of the staleness bound, so two heartbeats can be lost to a hiccup
 * without a host being declared unreachable and its tenants stranded.
 */
export const HEARTBEAT_EVERY_SEC = 30;

export type DaemonState =
  /** Has a key, has not been enrolled. Says nothing but hello. */
  | 'OFFERING'
  | 'ENROLLED'
  /** Told to finish what it holds and take nothing new. */
  | 'DRAINING'
  /** Refused. Terminal from the daemon's side. */
  | 'REVOKED';

export interface DaemonDecision {
  /** Whether to send a heartbeat now. */
  heartbeat: boolean;
  /** Whether to accept assignments offered in the reply. */
  acceptWork: boolean;
  /** Whether to keep trying at all. */
  keepRunning: boolean;
  detail: string;
}

/**
 * What the daemon should do on this tick.
 *
 * A revoked host stops. It does not retry, back off and try again later,
 * because a machine that was taken out of service continuing to call home is
 * indistinguishable from one that was not taken out of service.
 */
export function daemonTick(state: DaemonState): DaemonDecision {
  switch (state) {
    case 'OFFERING':
      return { heartbeat: true, acceptWork: false, keepRunning: true, detail: 'Waiting to be enrolled.' };
    case 'ENROLLED':
      return { heartbeat: true, acceptWork: true, keepRunning: true, detail: 'In service.' };
    case 'DRAINING':
      return { heartbeat: true, acceptWork: false, keepRunning: true, detail: 'Draining: finishing what is held.' };
    case 'REVOKED':
      return { heartbeat: false, acceptWork: false, keepRunning: false, detail: 'Revoked. Stopping.' };
  }
}

/**
 * The stable name of a key, for logs and enrolment.
 *
 * A thumbprint rather than the key, so a host can be identified in a log line
 * without the log carrying the material, and renaming a host does not change
 * which host it is.
 */
export function thumbprintOf(publicKeyJwk: { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string }): string {
  // Canonical ordering, because a thumbprint that depends on key order is not
  // stable across whatever produced the JSON.
  const canonical =
    publicKeyJwk.kty === 'EC'
      ? JSON.stringify({ crv: publicKeyJwk.crv, kty: publicKeyJwk.kty, x: publicKeyJwk.x, y: publicKeyJwk.y })
      : JSON.stringify({ e: publicKeyJwk.e, kty: publicKeyJwk.kty, n: publicKeyJwk.n });
  return createHash('sha256').update(canonical).digest('base64url');
}

/**
 * What a daemon may be told about a tenant, restated here as a guard.
 *
 * `tenantGateway.assignmentFor` builds assignments and
 * `ASSIGNMENT_FORBIDDEN_FIELDS` lists what they must not carry. This is the
 * receiving end: a daemon that is handed something with an owner's identity in
 * it refuses the assignment rather than storing it, so a control plane bug
 * cannot quietly start leaking customer data onto hosts.
 */
export function assignmentIsAcceptable(assignment: Record<string, unknown>, forbidden: readonly string[]): { ok: true } | { ok: false; why: string } {
  const keys = Object.keys(assignment);
  const offending = keys.filter((k) => forbidden.some((f) => k.toLowerCase() === f.toLowerCase()));
  if (offending.length > 0) {
    return { ok: false, why: `The assignment carried ${offending.join(', ')}, which a host has no business holding.` };
  }
  // An email is recognisable wherever it is put, so the values are checked too
  // rather than only the field names.
  for (const [key, value] of Object.entries(assignment)) {
    if (typeof value === 'string' && /@[^\s@]+\.[^\s@]+/.test(value)) {
      return { ok: false, why: `The assignment field ${key} looks like an email address.` };
    }
  }
  return { ok: true };
}

/**
 * Whether this host may hold a tenant at all, given its tier.
 *
 * Asked on the host as well as in the scheduler. Two places on purpose: the
 * scheduler refusing is the control plane's decision, and this is the machine
 * declining to accept work it is not qualified for even if something upstream
 * offered it.
 */
export function hostMayAcceptTenants(tier: ProviderTier, enabled: readonly ProviderTier[]): boolean {
  return enabled.includes(tier);
}
