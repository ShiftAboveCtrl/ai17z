import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workers as workersRepo } from '@xbam/database';
import { installHarness } from '../support/harness';

installHarness();

/**
 * Stopping kills the native worker's tree, so it never says goodbye. Its
 * heartbeat then answered "a native worker is present" for up to ninety
 * seconds, and an update that stopped and started inside that window started
 * no worker: measured on a live installation, which reported ready and could
 * not open its Chrome.
 */
describe('a killed browser worker is forgotten', () => {
  it('forgets browser workers and leaves the others', async () => {
    await workersRepo.heartbeat({ id: 'native-1', role: 'browser', browserCapable: true, jobsCapable: true });
    await workersRepo.heartbeat({ id: 'container-1', role: 'jobs', browserCapable: false, jobsCapable: true });
    expect(await workersRepo.browserWorkerPresent()).toBe(true);
    expect(await workersRepo.forgetBrowserWorkers()).toBe(1);
    expect(await workersRepo.browserWorkerPresent()).toBe(false);
    expect((await workersRepo.present()).map((w) => w.id)).toContain('container-1');
  });

  it('is done by the stop script after the kill, and shipped with it', () => {
    const root = join(__dirname, '..', '..');
    const stop = readFileSync(join(root, 'stop-ai17z.ps1'), 'utf8');
    const forget = stop.indexOf("'worker:forget'");
    expect(forget).toBeGreaterThan(stop.indexOf("Write-Done 'Leftovers stopped.'"));
    expect(forget).toBeLessThan(stop.indexOf('# -- The stack'));
    const packager = readFileSync(join(root, 'tools', 'package-windows.mts'), 'utf8');
    expect(packager).toContain("'worker:forget'");
    expect(packager).toContain("'scripts/browser-worker-forget.mts'");
  });
});
