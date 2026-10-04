import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_EVERY_SEC, HOST_OVERHEAD, capacityFrom, daemonTick } from '@xbam/runtime';

/**
 * A machine does not become a host by accident.
 *
 * Every AI17Z installation runs the worker, so the property that matters most
 * is that the host agent stays off: an agent that enabled itself would turn
 * every laptop running the product into a machine advertising capacity to a
 * control plane. That, and that it still boots nothing, since nothing in this
 * repository has booted a guest and a file that quietly started would be the
 * first thing to make that claim false.
 *
 * The source is read for the second one, in the same way
 * `noWalletCapabilities` reads the capability layer: the claim is about what a
 * file does not contain, and no amount of calling it proves that.
 */

const SOURCE = readFileSync(join(__dirname, '..', '..', 'apps', 'worker', 'src', 'hostAgent.ts'), 'utf8');

const KEYS = ['AI17Z_HOST_ID', 'AI17Z_HOST_REGION', 'AI17Z_HEARTBEAT_MS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('off unless somebody asked', () => {
  it('reads the host id from the environment and nowhere else', () => {
    // A default, a settings row or a derived id would all mean an installation
    // could become a host without anybody deciding it should.
    expect(SOURCE).toContain('process.env.AI17Z_HOST_ID');
    expect(SOURCE).not.toMatch(/AI17Z_HOST_ID[^)]*\|\|\s*['"][^'"]+['"]/);
  });

  it('is not configured when the id is unset', async () => {
    const { HostAgent } = await import('../../apps/worker/src/hostAgent');
    expect(new HostAgent().configured).toBe(false);
  });

  it('starts no loop when it is not configured', () => {
    // Checked at the source, because the alternative is asserting that a timer
    // this test cannot see was never created.
    expect(SOURCE).toMatch(/if \(!this\.configured\)[\s\S]{0,400}return;/);
  });

  it('says nothing louder than debug about the ordinary case', () => {
    // This is the state of every installation, so a warning about it would be
    // noise on all of them.
    const notConfigured = SOURCE.slice(SOURCE.indexOf('if (!this.configured)'));
    const firstLog = notConfigured.slice(0, notConfigured.indexOf('return;'));
    expect(firstLog).toContain('log.debug');
    expect(firstLog).not.toContain('log.warn');
  });
});

describe('it still boots nothing', () => {
  it('spawns no process and writes no guest', () => {
    // Nothing in this repository has booted a guest. A spawn here would be the
    // first thing to make that claim false.
    for (const forbidden of ['child_process', 'spawn(', 'execFile(', 'jailer', 'firecracker', 'launchArgv']) {
      expect(SOURCE, forbidden).not.toContain(forbidden);
    }
  });

  it('reads whether it may accept work and does not apply it', () => {
    expect(SOURCE).toContain('acceptWork');
    // Logged rather than acted on, and the comment says so where somebody
    // would be about to change it.
    expect(SOURCE).toContain('Logged rather than acted on');
  });

  it('refuses work on a tier that may not hold tenants', () => {
    expect(SOURCE).toContain('hostMayAcceptTenants');
    expect(SOURCE).toContain('PROVIDER_TIERS_ENABLED');
  });
});

describe('what it measures', () => {
  it('takes capacity from total memory, never from free memory', () => {
    // What a host may offer is a property of the machine, not of whatever is
    // running on it this second. A capacity that moved with free memory would
    // make a host's advertised size depend on when the heartbeat landed.
    const measure = SOURCE.slice(SOURCE.indexOf('async function measure'));
    const body = measure.slice(0, measure.indexOf('\n}'));
    expect(body).toContain('totalmem()');
    expect(body).not.toContain('freemem()');
  });

  it('reports no disk rather than guessing when it cannot be read', () => {
    const disk = SOURCE.slice(SOURCE.indexOf('async function freeDiskGb'));
    expect(disk.slice(0, disk.indexOf('\n}'))).toContain('return 0;');
  });

  it('requires the binary to say Google Chrome about itself', () => {
    expect(SOURCE).toContain("found.product === 'Google Chrome'");
  });
});

describe('the numbers it would report', () => {
  const report = {
    totalMemoryMb: 32_768,
    cpuCores: 16,
    freeDiskGb: 500,
    browserPresent: true,
    region: 'lab',
    runtimeVersions: ['1.0.0-test'],
  };

  it("subtracts the host's own overhead before offering anything", () => {
    const out = capacityFrom(report);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.capacity.memoryMb).toBe(report.totalMemoryMb - HOST_OVERHEAD.memoryMb);
  });

  it('refuses a machine too small, with the figures rather than zero slots', () => {
    // A host advertising zero slots looks like a host that is full.
    const out = capacityFrom({ ...report, totalMemoryMb: 2_048, cpuCores: 1, freeDiskGb: 5 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.why).toMatch(/not enough to hold a runtime/);
    expect(out.why).toMatch(/\d+MB/);
  });

  it('offers no browser slot where there is no browser', () => {
    const out = capacityFrom({ ...report, browserPresent: false });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.capacity.browserSlots).toBe(0);
  });

  it('heartbeats often enough that two can be lost', () => {
    // A third of the staleness bound, so a hiccup does not strand tenants.
    expect(HEARTBEAT_EVERY_SEC * 3).toBeLessThanOrEqual(90);
  });

  it('stops for good when the host was revoked', () => {
    // A machine taken out of service that keeps calling home is
    // indistinguishable from one that was not taken out of service.
    expect(daemonTick('REVOKED').keepRunning).toBe(false);
    expect(daemonTick('REVOKED').heartbeat).toBe(false);
  });

  it('keeps reporting while draining and accepts nothing new', () => {
    const draining = daemonTick('DRAINING');
    expect(draining.heartbeat).toBe(true);
    expect(draining.acceptWork).toBe(false);
  });

  it('says hello before it is enrolled and takes no work', () => {
    const offering = daemonTick('OFFERING');
    expect(offering.heartbeat).toBe(true);
    expect(offering.acceptWork).toBe(false);
  });
});
