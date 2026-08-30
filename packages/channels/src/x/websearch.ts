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
 * Where to search, in order of preference.
 *
 * More than one because search engines challenge automation, and a challenge is
 * a full stop here: AI17Z never answers one, on any surface, for the same
 * reason it never answers one on a sign-in page. So the answer to being
 * challenged is to try somewhere else and then to admit the gap, never to
 * attempt the puzzle.
 *
 * DuckDuckGo's HTML endpoint is first because it renders without JavaScript and
 * has no consent interstitial. Bing follows because it challenges a real
 * signed-in browser far less often than it challenges a fresh headless one, and
 * the research tab is a real signed-in browser.
 */
const ENGINES: { name: string; url: (q: string) => string; result: string; title: string; snippet: string }[] = [
  {
    name: 'DuckDuckGo',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    result: '.result:not(.result--ad)',
    title: '.result__a',
    snippet: '.result__snippet',
  },
  {
    name: 'Bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`.replace('&format=rss', ''),
    result: '#b_results > li.b_algo',
    title: 'h2 a',
    snippet: '.b_caption p, .b_algoSlug',
  },
];

/**
 * Text that means a search engine is asking us to prove we are human.
 *
 * Recognised so the search stops, exactly as a sign-in challenge stops a login.
 * There is no branch here that clicks, solves, or retries into it.
 */
const CHALLENGE = /unfortunately, bots use|complete the following challenge|are you a robot|verify you are (?:a )?human|unusual traffic|captcha/i;

export interface WebResult {
  title: string;
  snippet: string;
  url: string | null;
  /** Which engine answered, so a finding can be attributed to it. */
  engine?: string;
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
 *
 * Returns nothing rather than throwing when every engine declines. An empty
 * result becomes a recorded gap that the prompt turns into "say you do not
 * know", which is the correct outcome and a much better one than a guess.
 */
export async function webSearch(page: Page, query: string, limit = 3): Promise<WebResult[]> {
  for (const engine of ENGINES) {
    try {
      await page.goto(engine.url(query), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      continue;
    }

    // Checked before anything is read. A challenge page still has a body, and
    // scraping one produces confident nonsense.
    const body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
    if (CHALLENGE.test(body)) continue;

    const anyResult = await page
      .locator(engine.result)
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!anyResult) continue;

    const results = page.locator(engine.result);
    const count = Math.min(await results.count().catch(() => 0), limit * 2);
    const found: WebResult[] = [];

    for (let index = 0; index < count && found.length < limit; index += 1) {
      const result = results.nth(index);
      const title = (await result.locator(engine.title).first().innerText().catch(() => '')).trim();
      const snippet = (await result.locator(engine.snippet).first().innerText().catch(() => '')).trim();
      const href = await result.locator(engine.title).first().getAttribute('href').catch(() => null);
      if (!title && !snippet) continue;
      found.push({ title, snippet: snippet.slice(0, 400), url: unwrap(href), engine: engine.name });
    }

    if (found.length > 0) return found;
  }

  return [];
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
