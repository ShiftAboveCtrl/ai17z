import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenshotPublicPage, screenshotUrlAllowed } from '../../packages/channels/src/postScreenshot';
import { leaseSession } from '@xbam/browser';

afterEach(() => vi.unstubAllEnvs());

function isolated(ip = '93.184.216.34') {
  const page = { route: vi.fn(), unroute: vi.fn(), goto: vi.fn(async () => ({ ok: () => true, serverAddr: async () => ({ ipAddress: ip }) })),
    url: () => 'https://example.test/release', screenshot: vi.fn(async () => Buffer.from('pixels')) };
  const context = { pages: () => [page] };
  const send = vi.fn(async (method: string, params?: { url?: string }) => {
    if (method === 'Target.createBrowserContext') return { browserContextId: 'isolated' };
    if (method === 'Target.createTarget') {
      page.url = () => params!.url!;
      return { targetId: 'capture' };
    }
    if (method === 'Target.getTargetInfo') return { targetInfo: { browserContextId: 'isolated' } };
    return {};
  });
  page.goto = vi.fn(async () => { page.url = () => 'https://example.test/release'; return { ok: () => true, serverAddr: async () => ({ ipAddress: ip }) }; });
  const browser = { newBrowserCDPSession: async () => ({ send, detach: vi.fn() }), contexts: () => [context] };
  const owner = { browser: () => browser, pages: vi.fn(() => []), newPage: vi.fn() };
  return { page, send, owner, context };
}


describe('screenshots of public pages', () => {
  it.each(['https://x.com/a/status/123', 'https://mobile.twitter.com/a', 'https://t.co/a',
    'http://example.test', 'file:///tmp/a', 'https://localhost/a', 'https://user:pass@example.test'])(
    'refuses %s before touching a browser', async url => {
    expect(screenshotUrlAllowed(url)).toBe(false);
    expect(await screenshotPublicPage({} as never, url)).toBeNull();
  });

  it('regression: uses a cookie-less background context and disposes it after capture', async () => {
    const f = isolated();
    expect(await screenshotPublicPage(f.owner as never, 'https://example.test/release', ['example.test'])).toEqual(Buffer.from('pixels'));
    expect(f.send).toHaveBeenCalledWith('Target.createBrowserContext', expect.anything());
    expect(f.send).toHaveBeenCalledWith('Target.createTarget', expect.objectContaining({ browserContextId: 'isolated', background: true }));
    expect(f.send).toHaveBeenCalledWith('Target.disposeBrowserContext', { browserContextId: 'isolated' });
  });

  it('regression: never uses the default context, even when isolation fails', async () => {
    const f = isolated();
    f.send.mockRejectedValueOnce(new Error('isolation unavailable'));
    await expect(screenshotPublicPage(f.owner as never, 'https://example.test/release', ['example.test'])).rejects.toThrow('isolation unavailable');
    expect(f.owner.newPage).not.toHaveBeenCalled();
    expect(f.owner.pages).not.toHaveBeenCalled();
    expect(f.page.screenshot).not.toHaveBeenCalled();
  });

  it('regression: defaults to denying capture and refuses undeclared hosts', async () => {
    expect(await screenshotPublicPage({} as never, 'https://example.test')).toBeNull();
    expect(await screenshotPublicPage({} as never, 'https://other.test', ['example.test'])).toBeNull();
  });

  it('regression: refuses a missing context id before creating a target', async () => {
    const f = isolated();
    f.send.mockResolvedValueOnce({});
    await expect(screenshotPublicPage(f.owner as never, 'https://example.test/release', ['example.test'])).rejects.toThrow('context was not created');
    expect(f.send).not.toHaveBeenCalledWith('Target.createTarget', expect.anything());
  });

  it('regression: refuses a target actually created in the default context', async () => {
    const f = isolated();
    f.send.mockResolvedValueOnce({ browserContextId: 'isolated' });
    f.send.mockResolvedValueOnce({ targetId: 'capture' });
    f.send.mockResolvedValueOnce({ targetInfo: { browserContextId: 'default' } });
    await expect(screenshotPublicPage(f.owner as never, 'https://example.test/release', ['example.test'])).rejects.toThrow('not isolated');
    expect(f.page.goto).not.toHaveBeenCalled();
    expect(f.page.screenshot).not.toHaveBeenCalled();
  });

  it('regression: disposes the isolated context when screenshot capture fails', async () => {
    const f = isolated();
    f.page.screenshot.mockRejectedValueOnce(new Error('renderer gone'));
    await expect(screenshotPublicPage(f.owner as never, 'https://example.test/release', ['example.test'])).rejects.toThrow('renderer gone');
    expect(f.send).toHaveBeenCalledWith('Target.disposeBrowserContext', { browserContextId: 'isolated' });
  });

  it.each(['127.0.0.1', '10.0.0.1', '::1'])('regression: discards a page connected to %s after DNS rebinding', async ip => {
    const f = isolated(ip);
    expect(await screenshotPublicPage(f.owner as never, 'https://example.test/release', ['example.test'])).toBeNull();
    expect(f.page.screenshot).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith('Target.disposeBrowserContext', { browserContextId: 'isolated' });
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
      const f = isolated();
      const page = {
        route: async (_pattern: string, handler: typeof guard) => { guard = handler; },
        unroute: vi.fn(), url: () => 'https://example.test/release',
        screenshot: async () => Buffer.from('pixels'),
        goto: async (url: string) => {
          if (url !== 'about:blank') await guard(blocked);
          return { ok: () => true, serverAddr: async () => ({ ipAddress: '93.184.216.34' }) };
        },
      };
      Object.assign(f.page, page);
      await screenshotPublicPage(f.owner as never, page.url(), ['example.test']);
      expect(blocked.abort).toHaveBeenCalledTimes(1);
      expect(blocked.continue).not.toHaveBeenCalled();
    },
  );
});
