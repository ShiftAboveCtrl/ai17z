import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenshotPublicPage, screenshotUrlAllowed } from '../../packages/channels/src/postScreenshot';
import { leaseSession } from '@xbam/browser';
import type { Page } from '@xbam/browser';

afterEach(() => vi.unstubAllEnvs());

describe('screenshots of public pages', () => {
  it.each(['https://x.com/a/status/123', 'https://mobile.twitter.com/a', 'https://t.co/a',
    'http://example.test', 'file:///tmp/a', 'https://localhost/a', 'https://user:pass@example.test'])(
    'refuses %s before touching a browser', async url => {
    expect(screenshotUrlAllowed(url)).toBe(false);
    expect(await screenshotPublicPage({} as Page, url)).toBeNull();
  });

  it('captures the live page and clears the background tab even after a screenshot failure', async () => {
    const bytes = Buffer.from('screenshot bytes');
    const page = {
      route: vi.fn(), unroute: vi.fn(),
      goto: vi.fn(async (_url: string, _options: unknown) => ({ ok: () => true })),
      url: () => 'https://example.test/releases/one',
      screenshot: vi.fn(async () => bytes),
    };
    expect(await screenshotPublicPage(page as unknown as Page, page.url())).toEqual(bytes);
    expect(page.goto.mock.calls.at(-1)?.[0]).toBe('about:blank');
    page.screenshot.mockRejectedValueOnce(new Error('renderer gone'));
    await expect(screenshotPublicPage(page as unknown as Page, page.url())).rejects.toThrow('renderer gone');
    expect(page.unroute).toHaveBeenCalledTimes(2);
  });

  it('cannot start a browser for optional media work', async () => {
    vi.stubEnv('AI17Z_BROWSER_ENABLED', 'true');
    await expect(leaseSession({ accountId: 'media-no-browser', existingOnly: true } as never))
      .rejects.toMatchObject({ reason: 'browser_not_running' });
  });

  it.each(['https://x.com/redirected', 'https://127.0.0.1/private'])(
    'blocks a redirect or subresource to %s before dispatch', async target => {
      let guard!: (route: unknown) => Promise<unknown>;
      const blocked = { request: () => ({ url: () => target }), abort: vi.fn(), continue: vi.fn() };
      const page = {
        route: async (_pattern: string, handler: typeof guard) => { guard = handler; },
        unroute: vi.fn(), url: () => 'https://example.test/release',
        screenshot: async () => Buffer.from('pixels'),
        goto: async (url: string) => {
          if (url !== 'about:blank') await guard(blocked);
          return { ok: () => true };
        },
      };
      await screenshotPublicPage(page as unknown as Page, page.url());
      expect(blocked.abort).toHaveBeenCalledTimes(1);
      expect(blocked.continue).not.toHaveBeenCalled();
    },
  );
});
