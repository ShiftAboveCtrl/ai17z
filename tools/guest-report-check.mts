/**
 * Compares what a host says it booted against what AI17Z asked it to boot.
 *
 *   npm run guest:check -- --plan tenant-alpha.plan.json --report tenant-alpha.report.json
 *
 * `guestMatchesPlan` has existed since `microVm.ts` was written and had never
 * been given a real report, because nothing had booted a guest. Now something
 * has, and this is the half that makes the second signal count: the plan is
 * what the control plane chose, and the report is what the machine did. A claim
 * resting on one of them is a claim taken on trust, which is the same rule the
 * browser engines are held to.
 *
 * A report is evidence from outside this program and is not trusted to be
 * well-formed: a missing field reads as a disagreement rather than as a pass.
 */
import { readFileSync } from 'node:fs';

import { guestMatchesPlan, type GuestReport, type MicroVmPlan } from '@xbam/runtime';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const planPath = flag('plan');
const reportPath = flag('report');
if (!planPath || !reportPath) {
  process.stderr.write('usage: guest-report-check.mts --plan <plan.json> --report <report.json>\n');
  process.exit(2);
}

interface RenderedPlan {
  runtimeId: string;
  uid: number;
  netns: string;
  measurement: { kernelSha256: string; rootfsSha256: string; version: string };
}
const rendered = JSON.parse(readFileSync(planPath, 'utf8')) as RenderedPlan;
const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;

/*
  Rebuilt from what the rendering printed rather than re-derived, because a
  plan built a second time here could differ from the one that booted and the
  comparison would be against something that never ran. Only the fields
  guestMatchesPlan reads are needed, and the rest are left as the plan's own
  defaults: a partial plan here would be a plan in the product, and this is a
  reader rather than a planner.
*/
const plan = {
  runtimeId: rendered.runtimeId,
  image: {
    kernelPath: '/unused-by-this-comparison',
    kernelSha256: rendered.measurement.kernelSha256,
    rootfsPath: '/unused-by-this-comparison',
    rootfsSha256: rendered.measurement.rootfsSha256,
    version: rendered.measurement.version,
  },
  resources: { vcpus: 0, memoryMb: 0, dataDiskPath: '/unused-by-this-comparison', dataDiskGb: 0 },
  isolation: {
    chrootBaseDir: '/unused-by-this-comparison',
    uid: rendered.uid,
    gid: rendered.uid,
    netns: rendered.netns,
    tapDevice: 'unused',
    seccomp: true,
  },
  apiSocketPath: '/unused-by-this-comparison',
  jailerPath: '/unused-by-this-comparison',
  firecrackerPath: '/unused-by-this-comparison',
} satisfies MicroVmPlan;

/** A field a host did not report is a disagreement, never a default that passes. */
function required<T>(value: unknown, name: string, kind: 'string' | 'number' | 'boolean'): T {
  if (typeof value !== kind) {
    process.stdout.write(`The host report does not say ${name}, so it cannot be compared with the plan.\n`);
    process.exit(1);
  }
  return value as T;
}

const report: GuestReport = {
  runtimeId: required<string>(raw.runtimeId, 'which runtime it ran', 'string'),
  kernelSha256: required<string>(raw.kernelSha256, 'which kernel it booted', 'string'),
  rootfsSha256: required<string>(raw.rootfsSha256, 'which root filesystem it booted', 'string'),
  jailed: required<boolean>(raw.jailed, 'whether the guest is under the jailer', 'boolean'),
  seccomp: required<boolean>(raw.seccomp, 'whether seccomp filtering is in place', 'boolean'),
  uid: required<number>(raw.uid, 'which user the guest runs as', 'number'),
  netns: required<string>(raw.netns, 'which network namespace it is in', 'string'),
};

const verdict = guestMatchesPlan(report, plan);
if (!verdict.matches) {
  process.stdout.write(`The host did not run what it was asked to run:\n${verdict.why.map((w) => `  - ${w}\n`).join('')}`);
  process.exit(1);
}

process.stdout.write(
  `The host ran what ${report.runtimeId}'s plan named: kernel ${report.kernelSha256.slice(0, 12)}, image ${report.rootfsSha256.slice(0, 12)}, under the jailer as uid ${report.uid}, seccomp in place, in ${report.netns}.\n`,
);
