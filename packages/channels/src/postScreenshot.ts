import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext, Page } from '@xbam/browser';
import { addressVerdict } from '@xbam/upstream';

/** X belongs to the reading layer, including redirects and embedded requests. */
export function screenshotUrlAllowed(raw: string, hosts?: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    return (!hosts || hosts.some(host => host.toLowerCase() === url.hostname)) && url.protocol === 'https:' && !url.username && !url.password &&
      !/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(url.hostname) &&
      url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost');
  } catch { return false; }
}

/** Cookie-less CDP context only. No fallback to the owner's signed-in context. */
export async function screenshotPublicPage(owner: BrowserContext, url: string, hosts: readonly string[] = []): Promise<Uint8Array | null> {
  if (!screenshotUrlAllowed(url, hosts)) return null;
  const browser = owner.browser();
  if (!browser) return null;
  const cdp = await browser.newBrowserCDPSession();
  let browserContextId: string | undefined;
  try {
    ({ browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true }));
    if (!browserContextId) throw new Error('Isolated browser context was not created');
    const startUrl = `about:blank#media-${randomUUID()}`;
    const { targetId } = await cdp.send('Target.createTarget', { url: startUrl, browserContextId, background: true });
    const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId });
    if (targetInfo.browserContextId !== browserContextId) throw new Error('Capture target is not isolated');
    let page: Page | undefined;
    for (let attempt = 0; attempt < 200 && !page; attempt++) {
      // Playwright files externally-created CDP targets under its default wrapper.
      // The actual target is isolated by browserContextId above; claim only our nonce.
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === startUrl);
      if (!page) await delay(25);
    }
    if (!page) throw new Error('Isolated media tab did not appear');
    return await capture(page, url, hosts);
  } finally {
    try {
      if (browserContextId) await cdp.send('Target.disposeBrowserContext', { browserContextId });
    } finally {
      await cdp.detach();
    }
  }
}

async function capture(page: Page, url: string, hosts: readonly string[]): Promise<Uint8Array | null> {
  const guard: Parameters<Page['route']>[1] = async (route) => {
    const raw = route.request().url();
    if (!screenshotUrlAllowed(raw, hosts)) return route.abort();
    const addresses = await lookup(new URL(raw).hostname, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some(a => !addressVerdict(a.address).allowed)) return route.abort();
    return route.continue();
  };
  await page.route('**/*', guard);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response?.ok() || !screenshotUrlAllowed(page.url(), hosts)) return null;
    const connected = await response.serverAddr();
    if (!connected || !addressVerdict(connected.ipAddress).allowed) return null;
    return await page.screenshot({ type: 'png', fullPage: false, timeout: 15_000 });
  } finally {
    await page.goto('about:blank', { timeout: 5_000 }).catch(() => undefined);
    await page.unroute('**/*', guard);
  }
}
