import type { Page } from '@xbam/browser';

/**
 * Reading the open web through the browser that is already running.
 *
 * There is no search API key here and there does not need to be one: a real
 * signed-in Chrome is already open for the account, so the cheapest way to find
 * out what happened this morning is to look, the way a person would.
 *
 * It runs on the RESEARCH tab, so a lookup never disturbs a monitor or a reply
 * halfway through. Results are read as text and attributed to the engine; they
 * are evidence with a name on them, not something the agent knows.
 */

/**
 * DuckDuckGo's HTML endpoint, which returns a plain results page.
 *
 * Chosen over the main site because it renders without JavaScript, has no
 * consent interstitial, and does not ask a signed-in browser to solve anything.
 * A page that needs a CAPTCHA is a page AI17Z stops at, so the one that never
 * asks is the one to use.
 */
const SEARCH_URL = (query: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

const SEL = {
  result: '.result:not(.result--ad)',
  title: '.result__a',
  snippet: '.result__snippet',
} as const;

export interface WebResult {
  title: string;
  snippet: string;
  url: string | null;
}

/** Pulls the real destination out of DuckDuckGo's redirect wrapper. */
function unwrap(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return null;
  }
}

/**
 * Searches, and returns the first few results as text.
 *
 * Three is deliberate. The value here is orientation — what is this, when did
 * it happen, who is saying so — and ten snippets crowd out the conversation the
 * agent is actually having.
 */
export async function webSearch(page: Page, query: string, limit = 3): Promise<WebResult[]> {
  await page.goto(SEARCH_URL(query), { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const anyResult = await page
    .locator(SEL.result)
    .first()
    .waitFor({ state: 'attached', timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  if (!anyResult) return [];

  const results = page.locator(SEL.result);
  const count = Math.min(await results.count().catch(() => 0), limit * 2);
  const found: WebResult[] = [];

  for (let index = 0; index < count && found.length < limit; index += 1) {
    const result = results.nth(index);
    const title = (await result.locator(SEL.title).first().innerText().catch(() => '')).trim();
    const snippet = (await result.locator(SEL.snippet).first().innerText().catch(() => '')).trim();
    const href = await result.locator(SEL.title).first().getAttribute('href').catch(() => null);
    if (!title && !snippet) continue;
    found.push({ title, snippet: snippet.slice(0, 400), url: unwrap(href) });
  }

  return found;
}

/**
 * Reads one page, for when somebody asks about a specific link.
 *
 * Text only, capped, and with no interaction: this opens a stranger's URL in a
 * signed-in browser, so it looks and does not touch. Nothing on the page is
 * treated as an instruction — it is quoted to the model as page content, which
 * is the only safe way to hand it over.
 */
export async function readPage(page: Page, url: string, maxChars = 4_000): Promise<WebResult | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  } catch {
    return null;
  }

  const title = (await page.title().catch(() => '')).trim();
  const body = await page
    .locator('article, main, body')
    .first()
    .innerText({ timeout: 10_000 })
    .catch(() => '');

  const text = body.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
  if (!title && !text) return null;
  return { title: title || url, snippet: text, url };
}
