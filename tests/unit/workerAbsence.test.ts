import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { START_A_WORKER, noBrowserWorker, noWorkerRunning, workerAbsenceSentence } from '@xbam/shared';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/**
 * A worker that is not running is the loudest thing on an agent page.
 *
 * Four places described it and each wrote its own sentence. Only one of the
 * four said how to fix it, and one of the other three told an owner to run
 * `npm run dev:worker` -- a developer command that an installed copy has no
 * way to run, sent to their phone.
 */
describe('what a missing worker says', () => {
  it('says whose problem it is', () => {
    // Somebody reading this on an agent page will otherwise go looking for the
    // setting they got wrong. There is no such setting.
    expect(noWorkerRunning(90).what).toMatch(/AI17Z itself rather than anything about this agent/i);
  });

  it('gives a command an installed copy can actually run', () => {
    expect(noWorkerRunning(90).fix).toBe(START_A_WORKER);
    expect(START_A_WORKER).toMatch(/desktop icon/i);
    expect(START_A_WORKER).toMatch(/start-ai17z\.ps1/);
    // The developer command is offered last and named as such, not first.
    expect(START_A_WORKER.indexOf('npm run dev:worker')).toBeGreaterThan(
      START_A_WORKER.indexOf('start-ai17z.ps1'),
    );
  });

  it('names the window it is talking about', () => {
    expect(workerAbsenceSentence(90)).toContain('90 seconds');
    expect(workerAbsenceSentence(45)).toContain('45 seconds');
  });

  it('answers the containerised worker differently', () => {
    /*
      The two look identical from outside and only one of them is confusing:
      the Docker worker polls, ingests and logs, so somebody watching it work
      is told nothing is running and reasonably concludes the message is wrong.
    */
    expect(noBrowserWorker().what).toMatch(/inside Docker/i);
    expect(noBrowserWorker().fix).toMatch(/second worker that runs on this machine/i);
    expect(noBrowserWorker().what).not.toEqual(noWorkerRunning(90).what);
  });

  it('is written once, not once per screen', () => {
    // Each of these described the same situation in its own words.
    for (const file of [
      'packages/tools/src/diagnostics.ts',
      'apps/api/src/routes/health.ts',
      'packages/runtime/src/notify.ts',
      'apps/api/src/routes/easy.ts',
    ]) {
      const source = read(file);
      expect(source, file).toMatch(/workerAbsenceSentence|noWorkerRunning|noBrowserWorker/);
      // The shape each of the four copies had: its own interpolated sentence.
      expect(source, file).not.toMatch(/Nothing has (checked|reported) in for \$\{/);
      // And the notification's advice specifically. The developer command
      // still appears inside START_A_WORKER, last and named as a checkout.
      expect(source, file).not.toMatch(/Start one with "npm run dev:worker"/);
    }
  });
});
