import { createHash } from 'node:crypto';

/**
 * The guest one tenant runs in, described before anything boots it.
 *
 * A container is not the boundary between two customers. Firecracker's design
 * document says the first layer of isolation is KVM and that a single host can
 * run workloads belonging to different customers; a shared kernel with
 * namespaces is a resource arrangement, not that boundary. So a tenant gets a
 * guest with its own kernel.
 *
 * Nothing here boots anything. Launching needs KVM, root, a kernel image and a
 * rootfs, which is the one part no test on a developer's machine can prove, and
 * the honest split is the same one `hostEgress.ts` makes: a plan, the
 * properties the plan must have, and a check of what a host reports back. The
 * plan is exercised against a real binary only by `tools/hosted-lab.mts`,
 * which is also the only thing allowed to produce a capacity number.
 *
 * The flag names below are Firecracker's own documented jailer and API socket
 * interface. They are rendered rather than executed here, and a version of
 * Firecracker that disagrees with them is a failure in the lab run rather than
 * a silent substitution: there is no fallback to launching without the jailer,
 * for the same reason there is no fallback between browser engines.
 */

// ---------------------------------------------------------------------------
// What a guest is made of
// ---------------------------------------------------------------------------

export interface GuestImage {
  /** An uncompressed kernel image. Published by AI17Z and reproducible. */
  kernelPath: string;
  /** Its measurement, so a host cannot quietly run a different kernel. */
  kernelSha256: string;
  /** The read-only root filesystem every tenant shares a copy of. */
  rootfsPath: string;
  rootfsSha256: string;
  /** The AI17Z version this image carries, for placement. */
  version: string;
}

export interface GuestResources {
  vcpus: number;
  memoryMb: number;
  /** Writable per-tenant disk, which is the only writable image. */
  dataDiskPath: string;
  dataDiskGb: number;
}

export interface GuestIsolation {
  /** The tenant's own chroot. Never shared, never a parent of another's. */
  chrootBaseDir: string;
  /** Unprivileged. Running a guest as root defeats the point of the jailer. */
  uid: number;
  gid: number;
  /** Its own network namespace, which is where the egress rules attach. */
  netns: string;
  /** The tap device inside that namespace. */
  tapDevice: string;
  /**
   * Whether Firecracker's seccomp filters are left in place.
   *
   * Always true. The filters are on by default and turning them off is a
   * documented option, which is exactly why this is a field that can be
   * checked rather than an absence nobody notices.
   */
  seccomp: true;
}

export interface MicroVmPlan {
  /** Opaque to the tenant, and the jailer's own instance id. */
  runtimeId: string;
  image: GuestImage;
  resources: GuestResources;
  isolation: GuestIsolation;
  /** Where Firecracker's API socket lives, inside the chroot. */
  apiSocketPath: string;
  jailerPath: string;
  firecrackerPath: string;
}

// ---------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------

/** Characters a path may have before it reaches an argument vector. */
const SAFE_PATH = /^\/[A-Za-z0-9._\-/]*$/;
/** A runtime id reaches a directory name and a jailer instance id. */
const SAFE_ID = /^[A-Za-z0-9_-]{4,64}$/;

export type PlanProblem = string;

/**
 * The properties a plan must have before anything is allowed to boot it.
 *
 * Every problem rather than the first, because an operator fixing a host wants
 * the list, and because the checks are cheap while the alternative is finding
 * the second fault after the first guest is already running.
 */
export function microVmPlanProblems(plan: MicroVmPlan): readonly PlanProblem[] {
  const problems: PlanProblem[] = [];

  if (!SAFE_ID.test(plan.runtimeId)) {
    problems.push(`${plan.runtimeId} is not a usable runtime id, and it becomes a directory name.`);
  }

  for (const [label, value] of [
    ['jailer', plan.jailerPath],
    ['firecracker', plan.firecrackerPath],
    ['kernel', plan.image.kernelPath],
    ['rootfs', plan.image.rootfsPath],
    ['data disk', plan.resources.dataDiskPath],
    ['chroot base', plan.isolation.chrootBaseDir],
    ['api socket', plan.apiSocketPath],
  ] as const) {
    if (!SAFE_PATH.test(value)) problems.push(`The ${label} path is not an absolute, plain path: ${value}`);
  }

  // The jailer is part of the production configuration rather than hardening
  // somebody may add later, so a plan without it is not a plan to be fixed.
  if (!plan.jailerPath) problems.push('There is no jailer. A guest is never launched without it.');

  if (plan.isolation.seccomp !== true) {
    problems.push('Seccomp filtering is not in place. It is on by default and is never turned off.');
  }

  if (plan.isolation.uid === 0 || plan.isolation.gid === 0) {
    problems.push('The guest would run as root, which defeats the jailer it is running under.');
  }

  if (!plan.isolation.netns.trim()) {
    problems.push('The guest has no network namespace of its own, so the egress rules have nothing to attach to.');
  }

  // A chroot shared between two tenants is one filesystem namespace with two
  // customers in it, which is the thing the guest boundary exists to avoid.
  if (!plan.isolation.chrootBaseDir.includes(plan.runtimeId) && !plan.apiSocketPath.includes(plan.runtimeId)) {
    problems.push('Nothing in this plan is specific to the runtime, so two tenants could share a chroot.');
  }

  if (!plan.image.kernelSha256 || !plan.image.rootfsSha256) {
    problems.push('The image carries no measurement, so a host could run a different one and nobody would know.');
  }

  if (plan.resources.vcpus < 1) problems.push('A guest needs at least one vCPU.');
  if (plan.resources.memoryMb < 512) {
    problems.push('A guest with under 512 MB cannot hold a Node process, let alone a browser.');
  }

  return problems;
}

export type LaunchVerdict = { ok: true; argv: readonly string[] } | { ok: false; problems: readonly PlanProblem[] };

/**
 * Renders the argument vector a host would launch, or refuses with reasons.
 *
 * Refusing rather than returning a best effort is deliberate: a partially
 * sound launch plan is a guest that boots with one of its boundaries missing,
 * and a boundary that is missing on boot is missing for the guest's whole life.
 */
export function launchArgv(plan: MicroVmPlan): LaunchVerdict {
  const problems = microVmPlanProblems(plan);
  if (problems.length > 0) return { ok: false, problems };

  // The jailer's own arguments, then `--`, then Firecracker's. Everything
  // after the separator runs inside the chroot, so every path there is a name
  // inside the jail rather than a path on the host.
  const argv = [
    plan.jailerPath,
    '--id',
    plan.runtimeId,
    '--exec-file',
    plan.firecrackerPath,
    '--uid',
    String(plan.isolation.uid),
    '--gid',
    String(plan.isolation.gid),
    '--chroot-base-dir',
    plan.isolation.chrootBaseDir,
    '--netns',
    plan.isolation.netns,
    '--',
    /*
      No API socket, and a configuration settled before the guest starts.

      `--api-sock` leaves a control socket open for the guest's whole life, and
      anything on the host that can reach it can attach a drive or a network
      interface to a running tenant. A tenant's guest is configured once, by
      the control plane, and then has nothing left to negotiate, so the
      configuration arrives as a file and the socket is never created.

      `plan.apiSocketPath` stays part of the plan: it is still what makes a
      plan specific to its runtime, and it is the path that would be used if
      something ever genuinely needed to drive a running guest.
    */
    '--no-api',
    '--config-file',
    CONFIG_IN_JAIL,
  ];

  return { ok: true, argv };
}

/**
 * The configuration file's name inside the jail.
 *
 * A name rather than a path: the jailer chroots into the runtime's own
 * directory, so this is next to the kernel and the disks it names.
 */
export const CONFIG_IN_JAIL = 'ai17z-guest.json';

/** What each of a guest's files is called inside the jail. */
export const IN_JAIL = {
  kernel: 'vmlinux',
  rootfs: 'rootfs.ext4',
  data: 'data.ext4',
} as const;

/**
 * Which host file belongs at which name inside the jail.
 *
 * The jailer does not fetch anything. Whatever launches a guest has to put
 * these there first, and this is the one list of what they are, so a boot
 * configuration naming a file nobody placed is a mistake with a single place
 * to correct it.
 *
 * The root filesystem is placed read-only and shared between tenants on
 * purpose: it is the one thing they are meant to have in common, and
 * `plansShareAnything` deliberately leaves it off the list of things they must
 * not. The data disk is the opposite, one per tenant, and is the only image a
 * guest can write to.
 */
export function jailResources(plan: MicroVmPlan): readonly { readonly from: string; readonly nameInJail: string; readonly writable: boolean }[] {
  return [
    { from: plan.image.kernelPath, nameInJail: IN_JAIL.kernel, writable: false },
    { from: plan.image.rootfsPath, nameInJail: IN_JAIL.rootfs, writable: false },
    { from: plan.resources.dataDiskPath, nameInJail: IN_JAIL.data, writable: true },
  ];
}

/**
 * What the boot configuration would be, as the API would receive it.
 *
 * The rootfs is `is_read_only`, which is the property worth having rather than
 * a detail: a tenant that can write to the shared root image is a tenant that
 * can change what the next one boots. Everything a tenant writes goes on its
 * own data disk.
 */
export function bootConfiguration(plan: MicroVmPlan): {
  readonly bootSource: { kernel_image_path: string };
  readonly machineConfig: { vcpu_count: number; mem_size_mib: number; smt: false };
  readonly drives: readonly { drive_id: string; path_on_host: string; is_root_device: boolean; is_read_only: boolean }[];
  readonly network: readonly { iface_id: string; host_dev_name: string }[];
} {
  return {
    // Named inside the jail, not on the host. Firecracker reads this after the
    // jailer has chrooted, so a host path here is a path that does not exist:
    // the guest fails to boot reporting a missing file, and the message says
    // nothing about chroots. `jailResources` says which host file goes where.
    bootSource: { kernel_image_path: IN_JAIL.kernel },
    machineConfig: {
      vcpu_count: plan.resources.vcpus,
      mem_size_mib: plan.resources.memoryMb,
      // Hyperthread siblings share microarchitectural state, and two tenants
      // on two siblings of one core is the arrangement every cross-thread
      // side channel has been demonstrated against.
      smt: false,
    },
    drives: [
      { drive_id: 'rootfs', path_on_host: IN_JAIL.rootfs, is_root_device: true, is_read_only: true },
      { drive_id: 'data', path_on_host: IN_JAIL.data, is_root_device: false, is_read_only: false },
    ],
    network: [{ iface_id: 'eth0', host_dev_name: plan.isolation.tapDevice }],
  };
}

// ---------------------------------------------------------------------------
// Two tenants, one host
// ---------------------------------------------------------------------------

export type SharingVerdict = { shared: false } | { shared: true; what: readonly string[] };

/**
 * Whether two plans on one host would share anything they must not.
 *
 * The list in the hosted document is the same list checked here, because a
 * boundary written in prose and not checked anywhere is a boundary that holds
 * until somebody refactors a path helper.
 */
export function plansShareAnything(a: MicroVmPlan, b: MicroVmPlan): SharingVerdict {
  const shared: string[] = [];

  if (a.runtimeId === b.runtimeId) shared.push('the runtime id, so these are the same runtime');
  if (a.resources.dataDiskPath === b.resources.dataDiskPath) shared.push('a writable data disk');
  if (a.apiSocketPath === b.apiSocketPath) shared.push('the Firecracker control socket');
  if (a.isolation.netns === b.isolation.netns) shared.push('a network namespace');
  if (a.isolation.tapDevice === b.isolation.tapDevice) shared.push('a tap device');
  if (a.isolation.uid === b.isolation.uid) shared.push('a uid, so one guest could reach the other on the host');

  // A chroot that contains the other is as bad as the same chroot.
  const aRoot = chrootOf(a);
  const bRoot = chrootOf(b);
  if (aRoot === bRoot) shared.push('a chroot');
  else if (aRoot.startsWith(`${bRoot}/`) || bRoot.startsWith(`${aRoot}/`)) shared.push('a chroot that contains the other');

  // A read-only image on a measurement both agree on is the one thing two
  // tenants are meant to share, so it is deliberately absent from this list.

  return shared.length === 0 ? { shared: false } : { shared: true, what: shared };
}

function chrootOf(plan: MicroVmPlan): string {
  return `${plan.isolation.chrootBaseDir.replace(/\/+$/, '')}/firecracker/${plan.runtimeId}`;
}

// ---------------------------------------------------------------------------
// What the host says it ran
// ---------------------------------------------------------------------------

export interface GuestReport {
  /** The jailer instance the host says is running. */
  runtimeId: string;
  /** Hashes of the images the host says it booted. */
  kernelSha256: string;
  rootfsSha256: string;
  /** Whether the host reports the jailer in the process tree. */
  jailed: boolean;
  seccomp: boolean;
  uid: number;
  netns: string;
}

export type GuestVerdict = { matches: true } | { matches: false; why: readonly string[] };

/**
 * Compares what a host reports against what it was asked to run.
 *
 * The same reasoning as the browser identity rule: a claim resting on one
 * signal is a claim taken on trust, and an image measurement the control
 * plane chose is not evidence about the image that booted. This is the second
 * signal, and a disagreement is a failure rather than something to log.
 */
export function guestMatchesPlan(report: GuestReport, plan: MicroVmPlan): GuestVerdict {
  const why: string[] = [];

  if (report.runtimeId !== plan.runtimeId) why.push('The host is running a different runtime id.');
  if (report.kernelSha256 !== plan.image.kernelSha256) why.push('The booted kernel is not the one this plan names.');
  if (report.rootfsSha256 !== plan.image.rootfsSha256) why.push('The booted root filesystem is not the one this plan names.');
  if (!report.jailed) why.push('The guest is not running under the jailer.');
  if (!report.seccomp) why.push('Seccomp filtering is not in place on the running guest.');
  if (report.uid !== plan.isolation.uid) why.push('The guest is running as a different user than it was placed as.');
  if (report.netns !== plan.isolation.netns) why.push('The guest is in a different network namespace, so the egress rules may not be its own.');

  return why.length === 0 ? { matches: true } : { matches: false, why };
}

/**
 * A short, stable fingerprint of an image pair.
 *
 * For saying "these two hosts are running the same thing" without carrying
 * two hashes everywhere. Not a security boundary on its own: the hashes are.
 */
export function imageFingerprint(image: Pick<GuestImage, 'kernelSha256' | 'rootfsSha256' | 'version'>): string {
  return createHash('sha256')
    .update(`${image.version}\n${image.kernelSha256}\n${image.rootfsSha256}`)
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// What has not been proved
// ---------------------------------------------------------------------------

export const MICROVM_CAVEATS: readonly string[] = [
  'Guests have booted from these plans in the Firecracker lab on one developer machine, two tenants at once, each running the canonical AI17Z. That is not a capacity number and not a confidential VM.',
  'A plan is not a running guest. guestMatchesPlan is what compares a host report with the plan, and a host that reports nothing has proved nothing.',
  'KVM is the isolation boundary. A host where KVM is unavailable does not fall back to a container, it refuses to hold tenants.',
  'Firecracker filters no guest traffic. The egress rules in hostEgress.ts are the filtering, and a guest whose namespace carries no rules is unfiltered.',
  'Side channels are reduced, not eliminated. SMT is off so two tenants are not on sibling threads, and that is a mitigation rather than a guarantee.',
  'A host operator with root can read a host-sealed runtime key. Only the confidential tier would change that, and it is designed and not enabled.',
];
