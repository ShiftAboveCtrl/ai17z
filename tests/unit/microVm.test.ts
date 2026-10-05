import { describe, expect, it } from 'vitest';
import {
  MICROVM_CAVEATS,
  CONFIG_IN_JAIL,
  bootConfiguration,
  guestMatchesPlan,
  imageFingerprint,
  jailResources,
  launchArgv,
  microVmPlanProblems,
  plansShareAnything,
  type GuestReport,
  type MicroVmPlan,
} from '@xbam/runtime';

/**
 * The guest boundary, checked without booting one.
 *
 * Nothing here launches anything, so what is worth pinning is every property
 * whose absence on boot is permanent: no jailer, seccomp turned off, root,
 * a writable shared root image, a chroot one tenant shares with another, and
 * a host running an image nobody measured.
 */

const planFor = (id: string): MicroVmPlan => ({
  runtimeId: id,
  image: {
    kernelPath: '/var/lib/ai17z/images/vmlinux-6.1',
    kernelSha256: 'a'.repeat(64),
    rootfsPath: '/var/lib/ai17z/images/rootfs.ext4',
    rootfsSha256: 'b'.repeat(64),
    version: '1.0.0-beta.63',
  },
  resources: {
    vcpus: 2,
    memoryMb: 4096,
    dataDiskPath: `/var/lib/ai17z/tenants/${id}/data.ext4`,
    dataDiskGb: 20,
  },
  isolation: {
    chrootBaseDir: `/srv/jailer/${id}`,
    // Derived from the id, because two tenants sharing a uid is something
    // plansShareAnything is supposed to catch and a fixture that shares one
    // cannot show anything else.
    uid: 10_000 + [...id].reduce((n, c) => n + c.charCodeAt(0), 0),
    gid: 10_000 + [...id].reduce((n, c) => n + c.charCodeAt(0), 0),
    netns: `ai17z-${id}`,
    tapDevice: `tap-${id}`,
    seccomp: true,
  },
  apiSocketPath: `/run/firecracker-${id}.sock`,
  jailerPath: '/usr/bin/jailer',
  firecrackerPath: '/usr/bin/firecracker',
});

describe('a plan sound enough to boot', () => {
  it('has no problems as built', () => {
    expect(microVmPlanProblems(planFor('rt-alpha'))).toEqual([]);
  });

  it('renders the jailer first and Firecracker after the separator', () => {
    const out = launchArgv(planFor('rt-alpha'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.argv[0]).toBe('/usr/bin/jailer');
    const sep = out.argv.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(out.argv.slice(sep)).toContain('--config-file');
    expect(out.argv.slice(0, sep)).toContain('--chroot-base-dir');
  });

  it('opens no control socket, so a running tenant has nothing left to negotiate', () => {
    // An API socket lets anything on the host that can reach it attach a drive
    // or an interface to a running guest. The configuration is settled before
    // the guest starts instead.
    const out = launchArgv(planFor('rt-alpha'));
    if (!out.ok) throw new Error('expected a sound plan');
    expect(out.argv).toContain('--no-api');
    expect(out.argv).not.toContain('--api-sock');
  });

  it('names the configuration file inside the jail rather than on the host', () => {
    const out = launchArgv(planFor('rt-alpha'));
    if (!out.ok) throw new Error('expected a sound plan');
    const named = out.argv[out.argv.indexOf('--config-file') + 1]!;
    expect(named).toBe(CONFIG_IN_JAIL);
    expect(named.startsWith('/')).toBe(false);
  });

  it('passes the runtime as the jailer instance id', () => {
    const out = launchArgv(planFor('rt-alpha'));
    if (!out.ok) throw new Error('expected a sound plan');
    expect(out.argv[out.argv.indexOf('--id') + 1]).toBe('rt-alpha');
  });
});

describe('a plan that must not boot', () => {
  const broken = (over: (p: MicroVmPlan) => void): MicroVmPlan => {
    const p = planFor('rt-alpha');
    over(p);
    return p;
  };

  it('refuses a guest running as root', () => {
    // Running as root defeats the jailer it is running under.
    const problems = microVmPlanProblems(broken((p) => void (p.isolation.uid = 0)));
    expect(problems.join(' ')).toContain('root');
  });

  it('refuses seccomp being turned off', () => {
    // On by default, and turning it off is a documented option, which is
    // exactly why it is a field rather than an absence nobody notices.
    const p = broken((x) => void ((x.isolation as { seccomp: boolean }).seccomp = false));
    expect(microVmPlanProblems(p).join(' ')).toContain('Seccomp');
  });

  it('refuses a plan with no jailer', () => {
    const problems = microVmPlanProblems(broken((p) => void (p.jailerPath = '')));
    expect(problems.join(' ')).toContain('never launched without it');
  });

  it('refuses a guest with no network namespace of its own', () => {
    const problems = microVmPlanProblems(broken((p) => void (p.isolation.netns = '   ')));
    expect(problems.join(' ')).toContain('egress rules');
  });

  it('refuses an image carrying no measurement', () => {
    const problems = microVmPlanProblems(broken((p) => void (p.image.rootfsSha256 = '')));
    expect(problems.join(' ')).toContain('measurement');
  });

  it('refuses a path that is not an absolute plain path', () => {
    for (const bad of ['relative/path', '/tmp/x; rm -rf /', '/tmp/$(whoami)', '']) {
      const problems = microVmPlanProblems(broken((p) => void (p.resources.dataDiskPath = bad)));
      expect(problems.join(' '), bad).toContain('plain path');
    }
  });

  it('refuses a plan nothing in which is specific to the runtime', () => {
    const problems = microVmPlanProblems(
      broken((p) => {
        p.isolation.chrootBaseDir = '/srv/jailer';
        p.apiSocketPath = '/run/firecracker.sock';
      }),
    );
    expect(problems.join(' ')).toContain('share a chroot');
  });

  it('refuses rather than returning a best effort', () => {
    // A partially sound plan is a guest that boots with one boundary missing,
    // and a boundary missing on boot is missing for the guest's whole life.
    const out = launchArgv(broken((p) => void (p.isolation.uid = 0)));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.length).toBeGreaterThan(0);
  });

  it('reports every problem rather than the first', () => {
    const out = microVmPlanProblems(
      broken((p) => {
        p.isolation.uid = 0;
        p.isolation.gid = 0;
        p.image.kernelSha256 = '';
        p.resources.vcpus = 0;
        p.resources.memoryMb = 64;
      }),
    );
    expect(out.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the boot configuration', () => {
  const config = bootConfiguration(planFor('rt-alpha'));

  it('names nothing by its path on the host, because Firecracker reads this inside the chroot', () => {
    // The first boot from this module failed here: the kernel was named
    // /opt/.../vmlinux, which does not exist inside a jail, and Firecracker
    // reported a missing file without mentioning chroots.
    const named = [config.bootSource.kernel_image_path, ...config.drives.map((d) => d.path_on_host)];
    for (const name of named) expect(name.startsWith('/')).toBe(false);
  });

  it('says which host file belongs at each of those names', () => {
    const plan = planFor('rt-alpha');
    const placed = jailResources(plan);
    const named = [bootConfiguration(plan).bootSource.kernel_image_path, ...bootConfiguration(plan).drives.map((d) => d.path_on_host)];
    for (const name of named) {
      expect(placed.some((r) => r.nameInJail === name)).toBe(true);
    }
    for (const resource of placed) expect(resource.from.startsWith('/')).toBe(true);
  });

  it('places exactly one writable file in the jail, which is the tenant\'s own disk', () => {
    const plan = planFor('rt-alpha');
    const writable = jailResources(plan).filter((r) => r.writable);
    expect(writable).toHaveLength(1);
    expect(writable[0]!.from).toBe(plan.resources.dataDiskPath);
  });

  it('mounts the shared root image read only', () => {
    // A tenant that can write to the shared root can change what the next one
    // boots.
    const root = config.drives.find((d) => d.is_root_device);
    expect(root?.is_read_only).toBe(true);
  });

  it('gives the tenant exactly one writable disk', () => {
    const writable = config.drives.filter((d) => !d.is_read_only);
    expect(writable).toHaveLength(1);
    expect(writable[0]!.drive_id).toBe('data');
  });

  it('turns hyperthreading off', () => {
    // Two tenants on two siblings of one core is the arrangement every
    // cross-thread side channel has been demonstrated against.
    expect(config.machineConfig.smt).toBe(false);
  });

  it('gives the guest one interface, which is the tap in its namespace', () => {
    expect(config.network).toHaveLength(1);
    expect(config.network[0]!.host_dev_name).toBe('tap-rt-alpha');
  });
});

describe('two tenants on one host', () => {
  it('share nothing when placed separately', () => {
    expect(plansShareAnything(planFor('rt-alpha'), planFor('rt-beta'))).toEqual({ shared: false });
  });

  it('do share the read-only image, which is the point of it', () => {
    const a = planFor('rt-alpha');
    const b = planFor('rt-beta');
    expect(a.image.rootfsPath).toBe(b.image.rootfsPath);
    expect(plansShareAnything(a, b).shared).toBe(false);
  });

  it('names a shared writable disk', () => {
    const a = planFor('rt-alpha');
    const b = planFor('rt-beta');
    b.resources.dataDiskPath = a.resources.dataDiskPath;
    const out = plansShareAnything(a, b);
    expect(out.shared).toBe(true);
    if (!out.shared) return;
    expect(out.what.join(' ')).toContain('writable data disk');
  });

  it('names a shared uid, netns, tap or control socket', () => {
    for (const mutate of [
      (a: MicroVmPlan, b: MicroVmPlan) => void (b.isolation.uid = a.isolation.uid),
      (a: MicroVmPlan, b: MicroVmPlan) => void (b.isolation.netns = a.isolation.netns),
      (a: MicroVmPlan, b: MicroVmPlan) => void (b.isolation.tapDevice = a.isolation.tapDevice),
      (a: MicroVmPlan, b: MicroVmPlan) => void (b.apiSocketPath = a.apiSocketPath),
    ]) {
      const a = planFor('rt-alpha');
      const b = planFor('rt-beta');
      mutate(a, b);
      expect(plansShareAnything(a, b).shared).toBe(true);
    }
  });

  it('treats a chroot that contains the other as sharing one', () => {
    const a = planFor('rt-alpha');
    const b = planFor('rt-beta');
    b.isolation.chrootBaseDir = '/srv/jailer/rt-alpha/firecracker/rt-alpha/nested';
    a.isolation.chrootBaseDir = '/srv/jailer/rt-alpha';
    const out = plansShareAnything(a, b);
    expect(out.shared).toBe(true);
    if (!out.shared) return;
    expect(out.what.join(' ')).toContain('contains the other');
  });
});

describe('what the host says it actually ran', () => {
  const plan = planFor('rt-alpha');
  const report = (over: Partial<GuestReport> = {}): GuestReport => ({
    runtimeId: plan.runtimeId,
    kernelSha256: plan.image.kernelSha256,
    rootfsSha256: plan.image.rootfsSha256,
    jailed: true,
    seccomp: true,
    uid: plan.isolation.uid,
    netns: plan.isolation.netns,
    ...over,
  });

  it('accepts a host running what it was asked to', () => {
    expect(guestMatchesPlan(report(), plan)).toEqual({ matches: true });
  });

  it('refuses a different kernel or rootfs', () => {
    // An image measurement the control plane chose is not evidence about the
    // image that booted.
    expect(guestMatchesPlan(report({ kernelSha256: 'c'.repeat(64) }), plan).matches).toBe(false);
    expect(guestMatchesPlan(report({ rootfsSha256: 'c'.repeat(64) }), plan).matches).toBe(false);
  });

  it('refuses a guest that is not jailed or not filtered', () => {
    expect(guestMatchesPlan(report({ jailed: false }), plan).matches).toBe(false);
    expect(guestMatchesPlan(report({ seccomp: false }), plan).matches).toBe(false);
  });

  it('refuses a guest in a different namespace', () => {
    const out = guestMatchesPlan(report({ netns: 'somewhere-else' }), plan);
    expect(out.matches).toBe(false);
    if (out.matches) return;
    expect(out.why.join(' ')).toContain('egress rules may not be its own');
  });

  it('gives every disagreement rather than the first', () => {
    const out = guestMatchesPlan(report({ jailed: false, seccomp: false, uid: 0 }), plan);
    expect(out.matches).toBe(false);
    if (out.matches) return;
    expect(out.why.length).toBe(3);
  });
});

describe('image fingerprints', () => {
  const image = { kernelSha256: 'a'.repeat(64), rootfsSha256: 'b'.repeat(64), version: '1.0.0-beta.63' };

  it('is stable for the same image', () => {
    expect(imageFingerprint(image)).toBe(imageFingerprint({ ...image }));
  });

  it('moves when any part of the image does', () => {
    expect(imageFingerprint({ ...image, version: '1.0.0-beta.64' })).not.toBe(imageFingerprint(image));
    expect(imageFingerprint({ ...image, rootfsSha256: 'c'.repeat(64) })).not.toBe(imageFingerprint(image));
  });
});

describe('what has not been proved', () => {
  it('says where guests have booted, and that it is not a capacity number', () => {
    // This caveat used to say nothing had ever been launched. It had, by the
    // time this changed, and a caveat that is false is worse than one that is
    // missing. What it must still refuse is the inference: one developer's
    // machine is not capacity, and Firecracker is not confidential compute.
    const all = MICROVM_CAVEATS.join(' ').toLowerCase();
    expect(all).toContain('one developer machine');
    expect(all).toContain('not a capacity number');
    expect(all).toContain('not a confidential vm');
  });

  it('refuses a container as a fallback for missing KVM', () => {
    const all = MICROVM_CAVEATS.join(' ').toLowerCase();
    expect(all).toContain('does not fall back to a container');
  });

  it('says side channels are reduced rather than eliminated', () => {
    const all = MICROVM_CAVEATS.join(' ').toLowerCase();
    expect(all).toContain('reduced, not eliminated');
  });

  it('says a host operator can read a host-sealed key', () => {
    const all = MICROVM_CAVEATS.join(' ').toLowerCase();
    expect(all).toContain('host-sealed runtime key');
  });
});
