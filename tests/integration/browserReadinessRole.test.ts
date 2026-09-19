import { afterEach, describe, expect, it } from 'vitest';
import { browserReadiness } from '@xbam/runtime';
import { workers as workersRepo } from '@xbam/database';
import { installHarness } from '../support/harness';

installHarness();

/**
 * Whether a browser exists and whether *this* program is the one with it are
 * two different questions, and only the first was being asked.
 *
 * `browserWorkerPresent` is about the installation. A jobs-only worker passes
 * it happily, because a browser worker is indeed running somewhere, and then
 * fails inside the implementation with "Google Chrome could not be found".
 *
 * Measured on a live installation, through the whole chain: `x.read_profile`
 * shortlisted, offered to the model as one of eight, chosen by it, executed
 * inside the container, and refused by Chrome that is not there and never will
 * be. The capability was ready by the only test that had been applied to it.
 *
 * Unset means `all`, which is what a checkout, these tests and a
 * single-process installation are, so nothing that can drive a browser loses
 * the ability to say so.
 */
const ROLE = 'AI17Z_WORKER_ROLE';
const original = process.env[ROLE];

afterEach(() => {
  if (original === undefined) delete process.env[ROLE];
  else process.env[ROLE] = original;
});

/** A browser worker exists somewhere, which is the condition being separated. */
async function aBrowserWorkerExists(): Promise<void> {
  await workersRepo.heartbeat({
    id: `browser-${Date.now()}`,
    role: 'browser',
    browserCapable: true,
    jobsCapable: false,
    hostname: 'test',
    version: 'test',
    tools: {},
  });
  expect(await workersRepo.browserWorkerPresent()).toBe(true);
}

describe('whether this process can drive a browser', () => {
  it('refuses in a jobs-only worker even though one is running elsewhere', async () => {
    await aBrowserWorkerExists();
    process.env[ROLE] = 'jobs';

    const verdict = await browserReadiness('any-account-id');
    expect(verdict.status).toBe('UNAVAILABLE');
    expect(verdict.why).toMatch(/does not drive a browser/i);
  });

  it('allows it in the worker that does have one', async () => {
    await aBrowserWorkerExists();
    process.env[ROLE] = 'browser';
    expect((await browserReadiness('any-account-id')).status).toBe('AVAILABLE');
  });

  /*
    A checkout, a single-process installation and this suite are all `all`, and
    none of them should lose a capability to a variable nobody set.
  */
  it('treats an unset role as able, so nothing that could work stops working', async () => {
    await aBrowserWorkerExists();
    delete process.env[ROLE];
    expect((await browserReadiness('any-account-id')).status).toBe('AVAILABLE');
  });

  it('still refuses when nothing anywhere can open a browser', async () => {
    process.env[ROLE] = 'all';
    // No browser worker heartbeat in this case, so the installation-wide
    // question is the one that answers first.
    const verdict = await browserReadiness('any-account-id');
    expect(verdict.status).toBe('UNAVAILABLE');
  });
});
