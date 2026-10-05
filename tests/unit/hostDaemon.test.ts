import { describe, expect, it } from 'vitest';
import { PROVIDER_TIERS_ENABLED } from '@xbam/shared/contracts';
import {
  ASSIGNMENT_FORBIDDEN_FIELDS,
  BROWSER_SLOT_MEMORY_MB,
  GUEST_HOST_OVERHEAD_MB,
  MEASURED_TENANT_FOOTPRINT,
  STALE_AFTER_DAYS,
  judgeFootprint,
  runtimeSlotMemoryMb,
  HEARTBEAT_EVERY_SEC,
  HEARTBEAT_STALE_AFTER_SEC,
  HOST_OVERHEAD,
  assignmentIsAcceptable,
  capacityFrom,
  daemonTick,
  hostMayAcceptTenants,
  thumbprintOf,
  type MachineReport,
} from '@xbam/runtime';

/**
 * What a machine offering capacity decides, without a socket in sight.
 *
 * The daemon process is thin on purpose; everything worth testing about it is
 * a judgement. These are those judgements, including the two that protect a
 * customer: a host never invents what it has, and a host refuses to hold
 * anything that identifies whose agent it is running.
 */

const machine = (over: Partial<MachineReport> = {}): MachineReport => ({
  totalMemoryMb: 32_768,
  cpuCores: 16,
  freeDiskGb: 500,
  browserPresent: true,
  region: 'lab',
  runtimeVersions: ['1.0.0-test'],
  ...over,
});

describe('a host offers what it measured, never what somebody typed', () => {
  it('subtracts its own overhead before offering anything', () => {
    const out = capacityFrom(machine());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.capacity.memoryMb).toBe(32_768 - HOST_OVERHEAD.memoryMb);
    expect(out.capacity.cpuCores).toBe(16 - HOST_OVERHEAD.cpuCores);
    expect(out.capacity.diskGb).toBe(500 - HOST_OVERHEAD.diskGb);
  });

  it('refuses to advertise anything on a machine too small to hold a runtime', () => {
    // And says what is actually left, because "zero slots" is harder to act
    // on than "1GB usable after overhead".
    const out = capacityFrom(machine({ totalMemoryMb: 2_560, cpuCores: 1, freeDiskGb: 22 }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toMatch(/usable/);
    expect(out.why).toMatch(/\d+MB/);
  });

  it('offers no browser slots on a machine with no browser', () => {
    const out = capacityFrom(machine({ browserPresent: false }));
    expect(out.ok && out.capacity.browserSlots).toBe(0);
    // It can still hold text-only runtimes.
    expect(out.ok && out.capacity.runtimeSlots).toBeGreaterThan(0);
  });

  it('bounds browser slots by memory rather than by optimism', () => {
    // AI17Z already measures an X renderer growing past three gigabytes
    // before recycling. A host advertising browser slots it cannot feed
    // produces renderers killed for memory, which read as failed polls.
    const out = capacityFrom(machine({ totalMemoryMb: 10_240 }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const usable = 10_240 - HOST_OVERHEAD.memoryMb;
    expect(out.capacity.browserSlots).toBeLessThanOrEqual(Math.floor(usable / BROWSER_SLOT_MEMORY_MB));
    expect(out.capacity.browserSlots).toBeLessThanOrEqual(out.capacity.runtimeSlots);
  });

  it('never offers more browser slots than runtime slots', () => {
    for (const mem of [4_096, 8_192, 16_384, 65_536]) {
      const out = capacityFrom(machine({ totalMemoryMb: mem }));
      if (!out.ok) continue;
      expect(out.capacity.browserSlots, `${mem}MB`).toBeLessThanOrEqual(out.capacity.runtimeSlots);
    }
  });

  it('is bounded by cores as well as memory', () => {
    // A machine with plenty of memory and two cores is not a machine that can
    // hold eight runtimes.
    const out = capacityFrom(machine({ totalMemoryMb: 65_536, cpuCores: 3 }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.capacity.runtimeSlots).toBeLessThanOrEqual((3 - HOST_OVERHEAD.cpuCores) * 2);
  });
});

describe('what the daemon does on a tick', () => {
  it('says hello before enrolment but takes no work', () => {
    const out = daemonTick('OFFERING');
    expect(out.heartbeat).toBe(true);
    expect(out.acceptWork).toBe(false);
    expect(out.keepRunning).toBe(true);
  });

  it('takes work only once enrolled', () => {
    expect(daemonTick('ENROLLED').acceptWork).toBe(true);
  });

  it('keeps reporting while draining but accepts nothing new', () => {
    const out = daemonTick('DRAINING');
    expect(out.heartbeat).toBe(true);
    expect(out.acceptWork).toBe(false);
  });

  it('stops entirely once revoked, rather than retrying', () => {
    // A machine taken out of service that keeps calling home is
    // indistinguishable from one that was not taken out of service.
    const out = daemonTick('REVOKED');
    expect(out.heartbeat).toBe(false);
    expect(out.acceptWork).toBe(false);
    expect(out.keepRunning).toBe(false);
  });

  it('speaks often enough to survive a lost heartbeat or two', () => {
    // Otherwise one hiccup strands a tenant.
    expect(HEARTBEAT_EVERY_SEC * 2).toBeLessThan(HEARTBEAT_STALE_AFTER_SEC);
  });
});

describe('a host refuses to hold a customer identity', () => {
  it('rejects an assignment carrying a forbidden field', () => {
    // The receiving end of the rule. A control plane bug must not quietly
    // start leaking customer data onto hosts.
    for (const field of ['ownerEmail', 'walletAddress', 'xHandle', 'accountRef']) {
      const out = assignmentIsAcceptable({ runtimeId: 'r', [field]: 'something' }, ASSIGNMENT_FORBIDDEN_FIELDS);
      expect(out.ok, field).toBe(false);
    }
  });

  it('rejects an email wherever it was put, not only in a named field', () => {
    // Field names can be renamed; an email is recognisable regardless.
    const out = assignmentIsAcceptable({ runtimeId: 'r', note: 'contact person@example.com' }, ASSIGNMENT_FORBIDDEN_FIELDS);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('email');
  });

  it('accepts an assignment with only what a host needs to run the thing', () => {
    const out = assignmentIsAcceptable(
      { runtimeId: 'r-1', generation: 1, runtimeClass: 'general-1', version: '1.0.0', tenantRef: 'opaque-uuid', keyCustody: 'HOST_SEALED' },
      ASSIGNMENT_FORBIDDEN_FIELDS,
    );
    expect(out.ok, !out.ok ? out.why : '').toBe(true);
  });
});

describe('identity is a key, not a name in a payload', () => {
  it('gives one thumbprint for one key regardless of field order', () => {
    const a = thumbprintOf({ kty: 'EC', crv: 'P-256', x: 'xxx', y: 'yyy' });
    const b = thumbprintOf({ y: 'yyy', x: 'xxx', crv: 'P-256', kty: 'EC' } as never);
    expect(a).toBe(b);
  });

  it('gives different thumbprints for different keys', () => {
    const a = thumbprintOf({ kty: 'EC', crv: 'P-256', x: 'xxx', y: 'yyy' });
    const b = thumbprintOf({ kty: 'EC', crv: 'P-256', x: 'xxx', y: 'zzz' });
    expect(a).not.toBe(b);
  });

  it('carries no key material in the thumbprint', () => {
    const t = thumbprintOf({ kty: 'EC', crv: 'P-256', x: 'secret-looking-x', y: 'secret-looking-y' });
    expect(t).not.toContain('secret-looking-x');
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('a host declines work it is not qualified for', () => {
  it('accepts only an enabled tier, asked on the machine as well as upstream', () => {
    // Two places on purpose: the scheduler refusing is the control plane's
    // decision, and this is the machine declining even if something upstream
    // offered it anyway.
    expect(hostMayAcceptTenants('FIRST_PARTY_TRUSTED', PROVIDER_TIERS_ENABLED)).toBe(true);
    expect(hostMayAcceptTenants('VERIFIED_PROVIDER', PROVIDER_TIERS_ENABLED)).toBe(false);
    expect(hostMayAcceptTenants('CONFIDENTIAL_COMPUTE', PROVIDER_TIERS_ENABLED)).toBe(false);
  });
});

describe('a host is told nothing about whose agent it holds, at any depth', () => {
  it('refuses an owner identity hidden one level down', () => {
    /*
      This passed. The forbidden name was inside `meta`, and the top-level
      value was an object rather than a string, so neither the name check nor
      the email check saw it.
    */
    const out = assignmentIsAcceptable(
      { runtimeId: 'rt-1', meta: { ownerEmail: 'someone@example.com' } },
      ASSIGNMENT_FORBIDDEN_FIELDS,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('meta.ownerEmail');
  });

  it('refuses an email hidden one level down', () => {
    const out = assignmentIsAcceptable({ runtimeId: 'rt-1', notes: { detail: 'ask someone@example.com' } }, ASSIGNMENT_FORBIDDEN_FIELDS);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('notes.detail');
  });

  it('refuses one inside a list', () => {
    const out = assignmentIsAcceptable({ runtimeId: 'rt-1', contacts: ['someone@example.com'] }, ASSIGNMENT_FORBIDDEN_FIELDS);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toContain('contacts[0]');
  });

  it('still passes an assignment carrying only what a host needs', () => {
    const out = assignmentIsAcceptable(
      {
        runtimeId: '11111111-1111-4111-8111-111111111111',
        generation: 1,
        runtimeClass: 'general-1',
        version: '1.0.0',
        keyCustody: 'HOST_SEALED',
        limits: { memoryMb: 4096, cpuCores: 2 },
      },
      ASSIGNMENT_FORBIDDEN_FIELDS,
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });
});

describe('what a runtime slot is', () => {
  const measuredAt = new Date(MEASURED_TENANT_FOOTPRINT.measuredAt);
  const soonAfter = new Date(measuredAt.getTime() + 86_400_000);

  it('comes from the measurement rather than from a round number', () => {
    // This was 1,024 MB, in a file whose header says a capacity figure
    // somebody typed is a promise the machine never made.
    const sized = judgeFootprint(MEASURED_TENANT_FOOTPRINT, soonAfter);
    expect(sized.usable).toBe(true);
    if (!sized.usable) return;
    expect(runtimeSlotMemoryMb(soonAfter)).toBe(sized.memoryMb + GUEST_HOST_OVERHEAD_MB);
  });

  it('allows for what the host carries beyond what the guest reports', () => {
    // Measured: 575 MB inside the guest against 704 MB resident on the host.
    // A plan sized on the in-guest figure is short by about a fifth a tenant.
    expect(GUEST_HOST_OVERHEAD_MB).toBeGreaterThan(0);
    expect(runtimeSlotMemoryMb(soonAfter)).toBeGreaterThan(MEASURED_TENANT_FOOTPRINT.memoryMb);
  });

  it('falls back rather than advertising nothing when the measurement goes stale', () => {
    // A host that advertises nothing looks exactly like a host that is full.
    const late = new Date(measuredAt.getTime() + (STALE_AFTER_DAYS + 2) * 86_400_000);
    expect(judgeFootprint(MEASURED_TENANT_FOOTPRINT, late).usable).toBe(false);
    expect(runtimeSlotMemoryMb(late)).toBe(1_024);
  });

  it('sizes a host from it, so a bigger slot means fewer tenants', () => {
    const machine = {
      totalMemoryMb: 32_768,
      cpuCores: 32,
      freeDiskGb: 500,
      browserPresent: false,
      region: 'lab',
      runtimeVersions: ['v1.0.0'],
    };
    const out = capacityFrom(machine);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const usable = 32_768 - HOST_OVERHEAD.memoryMb;
    expect(out.capacity.runtimeSlots).toBe(Math.min(Math.floor(usable / runtimeSlotMemoryMb()), (32 - HOST_OVERHEAD.cpuCores) * 2));
  });
});
