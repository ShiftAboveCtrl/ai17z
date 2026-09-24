import { describe, expect, it } from 'vitest';
import { readAllArticles } from '../../packages/channels/src/x/monitors';
import type { Page } from '@xbam/browser';

/**
 * A read of a timeline has to come back.
 *
 * `evaluateAll` sends work to the renderer and waits for the renderer to
 * answer. One that has stopped answering -- out of memory, wedged on X's own
 * bundles, mid-navigation -- never answers, and the call has no deadline of
 * its own. The `.catch(() => [])` sitting on it looks like it covers that and
 * does not: a promise that never settles is never rejected, so nothing in that
 * chain ever runs.
 *
 * That is what actually killed the radar on two live installations. The loop's
 * own `running` flag is what turned one stuck read into no discovery at all
 * for ninety-five minutes, and `radarSurvivesAHang.test.ts` covers that floor.
 * This covers the thing that hung.
 */

/** A page whose evaluation behaves however the test needs it to. */
function pageWhoseReadDoes(behaviour: 'never settles' | 'answers' | 'throws'): Page {
  return {
    locator: () => ({
      evaluateAll: () => {
        if (behaviour === 'never settles') return new Promise(() => {});
        if (behaviour === 'throws') return Promise.reject(new Error('Execution context was destroyed'));
        return Promise.resolve([
          {
            href: '/someone/status/2102844317307973872',
            nameBlock: 'Someone @someone',
            text: 'a question for the agent',
            createdAt: '2026-09-23T19:35:00.000Z',
            isReply: false,
            isQuote: false,
          },
        ]);
      },
    }),
  } as unknown as Page;
}

describe('reading a timeline that has stopped answering', () => {
  it('gives up rather than waiting for ever', async () => {
    const started = Date.now();
    const seen = await readAllArticles(pageWhoseReadDoes('never settles'), 20);
    const took = Date.now() - started;

    // Without the deadline this await never resolves and the test times out,
    // which is exactly what the radar did.
    expect(seen).toEqual([]);
    expect(took, 'bounded, and not by the test runner').toBeLessThan(20_000);
    expect(took, 'and it genuinely waited rather than returning instantly').toBeGreaterThan(10_000);
  }, 30_000);

  it('still reads a page that answers, without waiting on the deadline', async () => {
    const started = Date.now();
    const seen = await readAllArticles(pageWhoseReadDoes('answers'), 20);

    expect(Date.now() - started, 'the deadline is invisible in the ordinary case').toBeLessThan(1_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.statusId).toBe('2102844317307973872');
    expect(seen[0]!.authorHandle).toBe('someone');
  });

  it('treats a destroyed context as an empty read rather than a crash', async () => {
    // A navigation mid-read is ordinary. It must not escape as a throw into a
    // monitor, and it must not be confused with a page that had nothing on it:
    // `refuseIfXBroke` is what tells those apart, from the page text.
    expect(await readAllArticles(pageWhoseReadDoes('throws'), 20)).toEqual([]);
  });
});
