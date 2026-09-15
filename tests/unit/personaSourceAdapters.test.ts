import { afterEach, describe, expect, it } from 'vitest';
import { getPersonaSourceAdapter, listPersonaSourceAdapters } from '@xbam/persona';

/**
 * What a persona source says it needs, now that the answer is true.
 *
 * This replaces the twscrape adapter's tests, which are gone with the adapter.
 * Those tests were good -- they pinned that an empty account pool must not
 * report itself as a missing handle -- but they tested a thing that could never
 * work in a packaged installation: a Python library needing a separate install,
 * a place on PATH inside the worker, and X credentials in its own database.
 *
 * The requirement it reports is now one the product can actually meet: a
 * browser, which every installation has, signed in by the owner once.
 */

const xSource = getPersonaSourceAdapter('x_public');

afterEach(() => {
  delete process.env.AI17Z_DISABLE_BROWSER;
});

describe('whether X can be read on this machine', () => {
  it('is available wherever there is a browser, which is the honest requirement', async () => {
    const state = await xSource.availability();
    expect(state.available).toBe(true);
    expect(state.detail).toMatch(/browser/i);
    // Nothing to install, so nothing to ask for.
    expect(state.requirement).toBeNull();
  });

  it('is unavailable where browsing is switched off, and says why', async () => {
    // A headless server sets this. It genuinely cannot read X, and that is a
    // true answer rather than a missing-dependency one.
    process.env.AI17Z_DISABLE_BROWSER = '1';
    const state = await xSource.availability();
    expect(state.available).toBe(false);
    expect(state.detail).toMatch(/switched off/i);
    expect(state.requirement).toMatch(/graphical session|desktop/i);
  });

  it('never asks anybody to install a Python package', async () => {
    // The whole failure this replaced. A requirement nobody in a packaged
    // installation can satisfy is a feature that does not exist.
    for (const adapter of listPersonaSourceAdapters()) {
      const state = await adapter.availability();
      const words = `${state.detail} ${state.requirement ?? ''}`.toLowerCase();
      for (const forbidden of ['pip install', 'twscrape', 'python', 'add_accounts', 'account pool']) {
        expect(words, `${adapter.kind} still asks for ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('where an X corpus actually comes from', () => {
  it('refuses to be fetched here, and says where it is read instead', async () => {
    // An X corpus is collected by the worker through the browser and handed to
    // the sync already gathered. Reaching this is a routing mistake upstream,
    // and an error naming the right path is worth more than an empty array that
    // reads as an account with nothing to say.
    await expect(
      xSource.fetch({ handle: 'someone', limit: 10, since: null, includeReplies: true, includeQuotes: true }),
    ).rejects.toThrow(/collected by the worker through the browser/i);
  });

  it('still offers the pasted-corpus source, which needs nothing at all', async () => {
    const manual = getPersonaSourceAdapter('manual');
    const state = await manual.availability();
    expect(state.available).toBe(true);
  });
});
