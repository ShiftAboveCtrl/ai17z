import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { workers as workersRepo, query } from '@xbam/database';
import { installHarness } from '../support/harness';

installHarness();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

interface Component {
  name: string;
  status: string;
  detail: string;
  optional: boolean;
}

async function health(): Promise<{ status: string; components: Component[] }> {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  return (response.json() as { data: { status: string; components: Component[] } }).data;
}

const component = (report: { components: Component[] }, name: string) =>
  report.components.find((c) => c.name === name);

/**
 * A stack whose worker has died is not healthy.
 *
 * Health mentioned workers nowhere, so an installation with no worker reported
 * healthy on every component it had: the API was serving, the database was up,
 * the queue was empty because nothing was claiming from it, and the account
 * still said CONNECTED because the process that would have noticed otherwise
 * was the one that had gone. A real installation ran that way for four and a
 * half hours, and the screen said everything was fine the whole time.
 */
describe('what health says about the thing that does the work', () => {
  it('reports offline when nothing has checked in', async () => {
    const report = await health();
    const worker = component(report, 'Worker');

    expect(worker, 'health has no Worker component at all').toBeTruthy();
    expect(worker!.status).toBe('offline');
    // A worker is not optional: without one an agent does nothing whatsoever.
    expect(worker!.optional).toBe(false);
    expect(report.status).toBe('offline');
  });

  it('says what the consequence is, not just that a thing is missing', async () => {
    const worker = component(await health(), 'Worker');
    expect(worker!.detail).toMatch(/queue|nothing will run/i);
  });

  it('reports healthy once one checks in, and whether it can drive a browser', async () => {
    await workersRepo.heartbeat({ id: 'test-worker-1', role: 'worker', browserCapable: true, jobsCapable: true });
    const worker = component(await health(), 'Worker');

    expect(worker!.status).toBe('healthy');
    expect(worker!.detail).toContain('1 running');
    expect(worker!.detail).toMatch(/1 of them able to drive a browser/);
  });

  it('stops counting a worker that went quiet', async () => {
    await workersRepo.heartbeat({ id: 'test-worker-2', role: 'worker', browserCapable: false, jobsCapable: true });
    expect(component(await health(), 'Worker')!.status).toBe('healthy');

    // Backdated past the presence window, which is what a crash looks like:
    // the row stays, the heartbeat stops.
    await query("UPDATE workers SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", ['test-worker-2']);
    expect(component(await health(), 'Worker')!.status).toBe('offline');
  });
});

/**
 * The API owns no browsers, so it cannot count its own sessions.
 *
 * `activeSessionCount()` in the API process is structurally always zero, and
 * the old component reported that as "healthy, 0 live session(s)" -- a green
 * light derived from a number that could never be anything else.
 */
describe('what health says about the browser', () => {
  it('does not claim a browser is healthy on no evidence', async () => {
    const browser = component(await health(), 'Browser');
    expect(browser).toBeTruthy();
    expect(browser!.status).not.toBe('healthy');
    expect(browser!.detail).not.toMatch(/0 live session/);
  });

  it('never makes the platform look broken, because it is optional', async () => {
    // A browser is optional: a mock-channel agent needs none.
    expect(component(await health(), 'Browser')!.optional).toBe(true);
  });
});
