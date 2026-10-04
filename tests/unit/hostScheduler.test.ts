import { describe, expect, it } from 'vitest';
import {
  EGRESS_DENIED_CIDRS,
  HostCapacity,
  PROVIDER_TIERS,
  PROVIDER_TIERS_ENABLED,
  RUNTIME_STATES,
  RuntimeClass,
  TIER_REQUIREMENTS,
  runtimeMayAct,
  runtimeStateKept,
  tierMayHoldTenants,
  type ProviderTier,
} from '@xbam/shared/contracts';
import { HEARTBEAT_STALE_AFTER_SEC, HOST_HEADROOM, placeRuntime, refusalsFor, type HostForScheduling } from '@xbam/runtime';

/**
 * Where a tenant is allowed to go, and the much longer list of where it is not.
 *
 * The scheduler's job is refusing, so most of this is refusals. Nothing here
 * asserts a capacity figure: every number is one a fixture host claims to have
 * measured, which is the only kind of number this system is allowed to reason
 * about.
 */

const capacity = (over: Partial<HostCapacity> = {}): HostCapacity =>
  HostCapacity.parse({
    cpuCores: 16,
    memoryMb: 32_768,
    diskGb: 500,
    runtimeSlots: 8,
    browserSlots: 4,
    gpus: 0,
    region: 'eu-west',
    runtimeVersions: ['1.0.0-beta.63'],
    ...over,
  });

const host = (over: Partial<HostForScheduling> = {}): HostForScheduling => ({
  id: 'host-a',
  state: 'ACTIVE',
  tier: 'FIRST_PARTY_TRUSTED',
  capacity: capacity(),
  reserved: { cpuCores: 0, memoryMb: 0, diskGb: 0, runtimes: 0, browserRuntimes: 0 },
  heartbeatAgeSec: 5,
  ...over,
});

const small = RuntimeClass.parse({
  id: 'general-1',
  label: 'General',
  cpuCores: 1,
  memoryMb: 2_048,
  diskGb: 20,
  browser: false,
  maxAgents: 3,
});
const browser = RuntimeClass.parse({ ...small, id: 'browser-1', label: 'Browser', memoryMb: 4_096, browser: true });

const ask = (over = {}) => ({ runtimeClass: small, runtimeVersion: '1.0.0-beta.63', ...over });
const codes = (rs: { code: string }[]) => rs.map((r) => r.code);

describe('only hardware that earned it may hold a tenant', () => {
  it('enables exactly one tier, and not by deriving it from the list of tiers', () => {
    // Adding a tier to the vocabulary must not quietly enable scheduling onto
    // it, which is why the enabled list is written out rather than computed.
    expect([...PROVIDER_TIERS_ENABLED]).toEqual(['FIRST_PARTY_TRUSTED']);
    expect(PROVIDER_TIERS.length).toBeGreaterThan(PROVIDER_TIERS_ENABLED.length);
  });

  it('refuses the tiers that are designed but not proved', () => {
    for (const tier of ['VERIFIED_PROVIDER', 'CONFIDENTIAL_COMPUTE'] as ProviderTier[]) {
      expect(tierMayHoldTenants(tier)).toBe(false);
      const no = refusalsFor(host({ tier }), ask());
      expect(codes(no)).toContain('TIER_NOT_ENABLED');
      // And it says what is outstanding rather than only that it refused.
      expect(no.find((r) => r.code === 'TIER_NOT_ENABLED')!.detail.length).toBeGreaterThan(30);
    }
  });

  it('states what confidential compute would actually have to prove', () => {
    const needs = TIER_REQUIREMENTS.CONFIDENTIAL_COMPUTE.join(' ').toLowerCase();
    // The three that make the difference between a claim and a guarantee.
    expect(needs).toContain('root of trust');
    expect(needs).toContain('measurement');
    expect(needs).toContain('debug');
    expect(TIER_REQUIREMENTS.FIRST_PARTY_TRUSTED).toEqual([]);
  });
});

describe('a host is live only if it said so recently', () => {
  it('refuses a host that has never reported in', () => {
    expect(codes(refusalsFor(host({ heartbeatAgeSec: null }), ask()))).toContain('NO_HEARTBEAT');
  });

  it('refuses a stale heartbeat whatever the recorded state claims', () => {
    // A row saying ACTIVE is a memory; a heartbeat is evidence.
    const stale = host({ state: 'ACTIVE', heartbeatAgeSec: HEARTBEAT_STALE_AFTER_SEC + 1 });
    expect(codes(refusalsFor(stale, ask()))).toContain('HEARTBEAT_STALE');
  });

  it.each(['PENDING_ENROLMENT', 'DRAINING', 'UNREACHABLE', 'REVOKED'] as const)('refuses a host that is %s', (state) => {
    expect(codes(refusalsFor(host({ state }), ask()))).toContain('HOST_NOT_SCHEDULABLE');
  });
});

describe('a host cannot be promised more than it has', () => {
  it('leaves headroom rather than running a machine to its measured limit', () => {
    // 32GB reported, 80 per cent usable, so a 4GB class fits six times and
    // not eight, even though eight would fit the raw figure.
    const usable = 32_768 * HOST_HEADROOM.memory;
    const nearlyFull = host({ reserved: { cpuCores: 0, memoryMb: usable - 1_000, diskGb: 0, runtimes: 1, browserRuntimes: 0 } });
    expect(codes(refusalsFor(nearlyFull, ask({ runtimeClass: browser })))).toContain('NO_MEMORY');
  });

  it('refuses on cpu, disk and slots independently', () => {
    expect(codes(refusalsFor(host({ reserved: { cpuCores: 16, memoryMb: 0, diskGb: 0, runtimes: 0, browserRuntimes: 0 } }), ask()))).toContain('NO_CPU');
    expect(codes(refusalsFor(host({ reserved: { cpuCores: 0, memoryMb: 0, diskGb: 500, runtimes: 0, browserRuntimes: 0 } }), ask()))).toContain('NO_DISK');
    expect(codes(refusalsFor(host({ reserved: { cpuCores: 0, memoryMb: 0, diskGb: 0, runtimes: 8, browserRuntimes: 0 } }), ask()))).toContain('NO_SLOTS');
  });

  it('counts a browser runtime against its own scarcer slot', () => {
    // A tenant driving real Chrome is not comparable to a text-only agent.
    const full = host({ reserved: { cpuCores: 0, memoryMb: 0, diskGb: 0, runtimes: 4, browserRuntimes: 4 } });
    expect(codes(refusalsFor(full, ask({ runtimeClass: browser })))).toContain('NO_BROWSER_SLOTS');
    // The same host still has room for something that does not browse.
    expect(codes(refusalsFor(full, ask({ runtimeClass: small })))).not.toContain('NO_BROWSER_SLOTS');
  });

  it('refuses a browser runtime on a host that holds none', () => {
    const textOnly = host({ capacity: capacity({ browserSlots: 0 }) });
    expect(codes(refusalsFor(textOnly, ask({ runtimeClass: browser })))).toContain('NO_BROWSER_CAPACITY');
  });

  it('refuses a host that cannot hold more browser runtimes than runtimes', () => {
    expect(() => capacity({ runtimeSlots: 2, browserSlots: 4 })).toThrow();
  });
});

describe('version and region', () => {
  it('refuses a host that cannot run the version asked for', () => {
    expect(codes(refusalsFor(host(), ask({ runtimeVersion: '9.9.9' })))).toContain('VERSION_NOT_AVAILABLE');
  });

  it('refuses the wrong region only when one was asked for', () => {
    expect(codes(refusalsFor(host(), ask({ region: 'us-east' })))).toContain('WRONG_REGION');
    expect(codes(refusalsFor(host(), ask({ region: null })))).not.toContain('WRONG_REGION');
  });
});

describe('choosing between hosts', () => {
  it('keeps a tenant where it already was', () => {
    // Moving a signed-in browser session to a new address is how an account
    // picks up a security challenge nobody asked for.
    const a = host({ id: 'a', reserved: { cpuCores: 0, memoryMb: 20_000, diskGb: 0, runtimes: 3, browserRuntimes: 1 } });
    const b = host({ id: 'b' });
    const out = placeRuntime([a, b], ask({ preferHostId: 'a', runtimeClass: browser }));
    expect(out.placed).toBe(true);
    expect(out.placed && out.hostId).toBe('a');
    expect(out.placed && out.detail).toContain('already');
  });

  it('otherwise takes the emptiest acceptable host, deterministically', () => {
    const a = host({ id: 'a', reserved: { cpuCores: 0, memoryMb: 16_000, diskGb: 0, runtimes: 2, browserRuntimes: 0 } });
    const b = host({ id: 'b', reserved: { cpuCores: 0, memoryMb: 1_000, diskGb: 0, runtimes: 1, browserRuntimes: 0 } });
    const first = placeRuntime([a, b], ask());
    expect(first.placed && first.hostId).toBe('b');
    // Order of the input must not change the answer.
    const reversed = placeRuntime([b, a], ask());
    expect(reversed.placed && reversed.hostId).toBe('b');
  });

  it('ignores a sticky preference for a host that cannot take it', () => {
    const preferred = host({ id: 'a', state: 'DRAINING' });
    const other = host({ id: 'b' });
    const out = placeRuntime([preferred, other], ask({ preferHostId: 'a' }));
    expect(out.placed && out.hostId).toBe('b');
    expect(codes(out.refusals)).toContain('HOST_NOT_SCHEDULABLE');
  });

  it('places nothing and says why about every host when none will do', () => {
    const drained = host({ id: 'a', state: 'DRAINING' });
    const wrongTier = host({ id: 'b', tier: 'CONFIDENTIAL_COMPUTE' });
    const out = placeRuntime([drained, wrongTier], ask());
    expect(out.placed).toBe(false);
    // Both hosts are accounted for, so an operator sees the shape of the
    // problem rather than the first thing that went wrong.
    expect(out.refusals.map((r) => r.hostId).sort()).toEqual(['a', 'b']);
  });

  it('places nothing when given no hosts at all', () => {
    expect(placeRuntime([], ask()).placed).toBe(false);
  });
});

describe('a lapsed subscription is not a deletion', () => {
  it('lets a runtime act only while active or in grace', () => {
    expect(runtimeMayAct('ACTIVE')).toBe(true);
    expect(runtimeMayAct('GRACE')).toBe(true);
    for (const state of RUNTIME_STATES.filter((s) => s !== 'ACTIVE' && s !== 'GRACE')) {
      expect(runtimeMayAct(state), state).toBe(false);
    }
  });

  it('keeps durable state through suspension and retention', () => {
    // The worst answer to a lapsed subscription is to destroy somebody's
    // agent. It stops acting; it keeps existing.
    for (const state of ['SUSPENDED', 'RETAINED', 'DELETION_SCHEDULED'] as const) {
      expect(runtimeMayAct(state), `${state} must not act`).toBe(false);
      expect(runtimeStateKept(state), `${state} must keep state`).toBe(true);
    }
    expect(runtimeStateKept('DELETED')).toBe(false);
  });
});

describe('what a guest may never reach', () => {
  it('denies cloud metadata, loopback, private ranges and their v6 equivalents', () => {
    const all = EGRESS_DENIED_CIDRS.join(' ');
    // The single most valuable address to a compromised guest.
    expect(all).toContain('169.254.169.254/32');
    expect(all).toContain('127.0.0.0/8');
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']) {
      expect(all, cidr).toContain(cidr);
    }
    // An allowlist that forgets v6 is not one.
    for (const cidr of ['::1/128', 'fe80::/10', 'fc00::/7']) {
      expect(all, cidr).toContain(cidr);
    }
  });
});

describe('a move is not a placement', () => {
  it('says a runtime was moved, and why its own host was refused', () => {
    /*
      This read as a first placement before, which is the one event an operator
      has to be able to see: a browser tenant that changes machine changes
      egress address, and that is how an account picks up a security challenge
      nobody asked for.
    */
    const theirs = host({ id: 'host-theirs', state: 'DRAINING' });
    const other = host({ id: 'host-other' });

    const out = placeRuntime([theirs, other], ask({ preferHostId: 'host-theirs' }));

    expect(out.placed).toBe(true);
    if (!out.placed) return;
    expect(out.hostId).toBe('host-other');
    expect(out.detail).toContain('Moved off host-theirs');
    expect(out.detail).toContain('DRAINING');
  });

  it('does not call a first placement a move', () => {
    // No preferred host at all, which is what a first placement is.
    const out = placeRuntime([host({ id: 'host-only' })], ask());
    expect(out.placed).toBe(true);
    if (!out.placed) return;
    expect(out.detail).not.toContain('Moved off');
  });

  it('still keeps a tenant where it was when that host will do', () => {
    const out = placeRuntime([host({ id: 'host-a' }), host({ id: 'host-b' })], ask({ preferHostId: 'host-b' }));
    expect(out.placed).toBe(true);
    if (!out.placed) return;
    expect(out.hostId).toBe('host-b');
    expect(out.detail).toContain('Kept on the host');
  });
});
