import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthReport } from '@xbam/shared/contracts';
import { buildServer } from '../../apps/api/src/server';
import { workers as workersRepo } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * What the health screen says while AI17Z is still starting.
 *
 * The owner updated an installation, opened it before it had finished starting,
 * read "No worker has reported a live browser recently", and concluded the
 * Chrome launcher had broken in the update. It had not: the containers were
 * being rebuilt, the worker did not exist yet, and that sentence was the only
 * one the screen could produce.
 *
 * Three situations shared it, and only the last is a fault:
 *
 *   the worker has not started      ordinary for a few minutes after an update
 *   the worker is up, Chrome is not ordinary while a cold profile opens
 *   the worker has gone             actually wrong
 *
 * `workers.present()` already told the first from the others. The API was not
 * asking it. Nothing about how browsers are launched changed here -- this is
 * the status telling the truth about what was always happening.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

async function browserRow() {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  const { data } = response.json() as { data: HealthReport };
  const row = data.components.find((c) => c.kind === 'browser');
  expect(row, 'there is no browser row at all').toBeTruthy();
  return row!;
}

describe('the browser row while things are still coming up', () => {
  it('says it is starting when no worker has reported yet', async () => {
    await createFixture();
    const row = await browserRow();

    // Not "offline", and not a sentence that reads as a fault: nothing is
    // broken, something has not happened yet.
    expect(row.status).toBe('degraded');
    expect(row.detail).toMatch(/starting/i);
    expect(row.detail, 'it still reads as though the browser is missing').not.toMatch(
      /^No worker has reported a live browser/i,
    );
    // And it says why the wait is long, because silence after an update looks
    // exactly like a hang.
    expect(row.detail).toMatch(/rebuild/i);
  });

  it('distinguishes a running worker with no browser from no worker at all', async () => {
    await createFixture();
    await workersRepo.heartbeat({
      id: `test-worker-${Date.now()}`,
      role: 'browser',
      browserCapable: true,
      jobsCapable: false,
    });

    const row = await browserRow();
    expect(row.status).toBe('degraded');
    // A different sentence, because it is a different situation and there is
    // something the owner can do about exactly one of them.
    expect(row.detail).toMatch(/waiting for chrome/i);
    expect(row.detail).not.toMatch(/starting/i);
  });

  it('never says ready while the browser is still coming up', async () => {
    // The rule the owner asked for, in one line: Ready means ready.
    await createFixture();
    await workersRepo.heartbeat({
      id: `test-worker-${Date.now()}`,
      role: 'browser',
      browserCapable: true,
      jobsCapable: false,
    });
    const row = await browserRow();
    expect(row.status).not.toBe('healthy');
    expect(row.detail).not.toMatch(/\bReady\b/);
  });
});
