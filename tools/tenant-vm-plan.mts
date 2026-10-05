/**
 * Renders the microVM plan AI17Z would boot for one tenant.
 *
 *   npm run tenant:vm-plan -- --id tenant-alpha --image /opt/ai17z-lab/dl/image.json
 *
 * The lab booted guests from a configuration written in a shell script, which
 * proved that Firecracker works and nothing at all about what this repository
 * would do. `microVm.ts` has described a plan since it was written and had
 * never produced one, so two of its own rules were being broken by the lab
 * standing next to it: the root filesystem was writable, and both tenants ran
 * as the same uid, which `plansShareAnything` names as one guest being able to
 * reach the other on the host.
 *
 * So this is the authority now. It builds the plan, refuses it if
 * `microVmPlanProblems` finds anything, and prints what a host needs: the
 * jailer argument vector, the boot configuration, and the few derived facts a
 * shell script cannot work out for itself.
 *
 * It measures nothing. The image measurement comes from `--image`, a file the
 * image build wrote, because the control plane's copy of a measurement and the
 * measurement a host reports after booting are two different signals and
 * `guestMatchesPlan` exists to compare them. A tool that computed both would
 * be comparing a number with itself.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  CONFIG_IN_JAIL,
  bootConfiguration,
  jailResources,
  launchArgv,
  microVmPlanProblems,
  plansShareAnything,
  type MicroVmPlan,
} from '@xbam/runtime';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const id = flag('id');
const imagePath = flag('image');
if (!id || !imagePath) {
  process.stderr.write('usage: tenant-vm-plan.mts --id <tenant> --image <image.json> [--lab /opt/ai17z-lab] [--vcpus 2] [--memory-mb 4096] [--data-gb 8] [--against <other id>]\n');
  process.exit(2);
}

const lab = flag('lab') ?? '/opt/ai17z-lab';
const vcpus = Number(flag('vcpus') ?? 2);
const memoryMb = Number(flag('memory-mb') ?? 4096);
const dataDiskGb = Number(flag('data-gb') ?? 8);

interface PublishedImage {
  version: string;
  kernelPath: string;
  kernelSha256: string;
  rootfsPath: string;
  rootfsSha256: string;
}
const image = JSON.parse(readFileSync(imagePath, 'utf8')) as PublishedImage;

/** A short, stable suffix, so a tenant's own name never reaches a device name. */
const shortOf = (value: string, chars: number): string => createHash('sha256').update(value).digest('hex').slice(0, chars);

/**
 * A uid of this tenant's own.
 *
 * `plansShareAnything` refuses two plans that share one, and it is right to: a
 * process can signal and inspect another running as the same user, so two
 * guests as one uid is one guest able to kill the other. Derived from the id
 * rather than allocated, because an allocator needs somewhere to keep its
 * allocations and a hash needs nowhere.
 *
 * The range starts at 10000, above anything a distribution creates for itself,
 * and never reaches 0.
 */
const uidOf = (value: string): number => 10_000 + (parseInt(shortOf(value, 4), 16) % 20_000);

const plan: MicroVmPlan = {
  runtimeId: id,
  image: {
    kernelPath: image.kernelPath,
    kernelSha256: image.kernelSha256,
    rootfsPath: image.rootfsPath,
    rootfsSha256: image.rootfsSha256,
    version: image.version,
  },
  resources: {
    vcpus,
    memoryMb,
    dataDiskPath: `${lab}/data/${id}.data.ext4`,
    dataDiskGb,
  },
  isolation: {
    chrootBaseDir: `${lab}/jail/${id}`,
    uid: uidOf(id),
    gid: uidOf(id),
    netns: `/var/run/netns/ai17z-${id}`,
    tapDevice: `tap${shortOf(id, 8)}`,
    seccomp: true,
  },
  apiSocketPath: `/run/firecracker-${id}.socket`,
  jailerPath: flag('jailer') ?? '/usr/local/bin/jailer',
  firecrackerPath: flag('firecracker') ?? '/usr/local/bin/firecracker',
};

const problems = microVmPlanProblems(plan);
if (problems.length > 0) {
  process.stderr.write(`This plan is refused:\n${problems.map((p) => `  - ${p}\n`).join('')}`);
  process.exit(1);
}

const launch = launchArgv(plan);
if (!launch.ok) {
  process.stderr.write(`Refused: ${launch.problems.join('; ')}\n`);
  process.exit(1);
}

/*
  Checked against a named second tenant when one is given, because two plans
  that are each sound can still share something, and the function that knows
  which things those are is in the runtime rather than here.
*/
const against = flag('against');
if (against) {
  const other: MicroVmPlan = {
    ...plan,
    runtimeId: against,
    resources: { ...plan.resources, dataDiskPath: `${lab}/data/${against}.data.ext4` },
    isolation: {
      ...plan.isolation,
      chrootBaseDir: `${lab}/jail/${against}`,
      uid: uidOf(against),
      gid: uidOf(against),
      netns: `/var/run/netns/ai17z-${against}`,
      tapDevice: `tap${shortOf(against, 8)}`,
    },
    apiSocketPath: `/run/firecracker-${against}.socket`,
  };
  const verdict = plansShareAnything(plan, other);
  if (verdict.shared) {
    process.stderr.write(`These two tenants would share:\n${verdict.what.map((w) => `  - ${w}\n`).join('')}`);
    process.exit(1);
  }
}

const boot = bootConfiguration(plan);

process.stdout.write(
  `${JSON.stringify(
    {
      runtimeId: plan.runtimeId,
      // What a shell script cannot derive, named rather than recomputed there.
      uid: plan.isolation.uid,
      gid: plan.isolation.gid,
      netns: plan.isolation.netns,
      netnsName: plan.isolation.netns.split('/').pop(),
      tap: plan.isolation.tapDevice,
      chrootBaseDir: plan.isolation.chrootBaseDir,
      dataDiskPath: plan.resources.dataDiskPath,
      dataDiskGb: plan.resources.dataDiskGb,
      apiSocketPath: plan.apiSocketPath,
      argv: launch.argv,
      // Where the configuration file goes, by the name Firecracker is told to
      // read, and which host file belongs at each name beside it. Nothing that
      // launches a guest decides either of these for itself.
      configName: CONFIG_IN_JAIL,
      resources: jailResources(plan),
      // Firecracker's own configuration file spelling, which is not the shape
      // bootConfiguration returns: that is the API's, and the two differ in
      // their key names. Rendered here so the lab never writes one by hand.
      config: {
        'boot-source': {
          kernel_image_path: boot.bootSource.kernel_image_path,
          boot_args: flag('boot-args') ?? '',
        },
        drives: boot.drives,
        'machine-config': {
          vcpu_count: boot.machineConfig.vcpu_count,
          mem_size_mib: boot.machineConfig.mem_size_mib,
          smt: boot.machineConfig.smt,
        },
        'network-interfaces': boot.network,
      },
      measurement: { kernelSha256: plan.image.kernelSha256, rootfsSha256: plan.image.rootfsSha256, version: plan.image.version },
    },
    null,
    2,
  )}\n`,
);
