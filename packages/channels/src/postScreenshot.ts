import { lookup } from 'node:dns/promises';
import type { Page } from '@xbam/browser';
import { addressVerdict } from '@xbam/upstream';

/** X belongs to the reading layer, including redirects and embedded requests. */
export function screenshotUrlAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(url.hostname) &&
      url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost');
  } catch { return false; }
}

/** No clicks, no new browser, no X requests. The leased RESEARCH tab is background-created. */
export async function screenshotPublicPage(page: Page, url: string): Promise<Uint8Array | null> {
  if (!screenshotUrlAllowed(url)) return null;
  const guard: Parameters<Page['route']>[1] = async (route) => {
    const raw = route.request().url();
    if (!screenshotUrlAllowed(raw)) return route.abort();
    const addresses = await lookup(new URL(raw).hostname, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some(a => !addressVerdict(a.address).allowed)) return route.abort();
    return route.continue();
  };
  await page.route('**/*', guard);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response?.ok() || !screenshotUrlAllowed(page.url())) return null;
    return await page.screenshot({ type: 'png', fullPage: false, timeout: 15_000 });
  } finally {
    await page.goto('about:blank', { timeout: 5_000 }).catch(() => undefined);
    await page.unroute('**/*', guard);
  }
}
