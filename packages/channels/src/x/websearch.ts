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
 * Why an answer beats three snippets.
 *
 * The old implementation scraped DuckDuckGo's HTML endpoint and returned the
 * first three result blurbs. That is enough to know a subject exists and almost
 * never enough to answer a question about it: blurbs are written to make you
 * click, they repeat each other, and half of them are older than the question.
 *
 * Brave's Ask endpoint gives a synthesised answer with dated citations, which is
 * the shape research actually wants. DuckDuckGo stays behind it, because a
 * synthesised answer that fails to load is worth less than a snippet that does.
 */

/** Text that means a search engine is asking us to prove we are human. */
const CHALLENGE =
  /unfortunately, bots use|complete the following challenge|are you a robot|verify you are (?:a )?human|unusual traffic|captcha/i;

/**
 * Chrome that Brave's Ask page puts around the answer.
 *
 * The page is a conversation view: a sidebar of *previous* questions, a privacy
 * notice, the navigation tabs, the query echoed back, and a streaming status.
 * Everything above the last echo of the question is not the answer -- and the
 * sidebar in particular is a list of things asked earlier, which must never be
 * handed to a model as though it were a finding.
 */
const ANSWER_ENDS = [
  'AI-generated answer',
  'Elaborate',
  'Try again',
  'View all',
];

/**
 * Brave narrates what it is doing while it works, and leaves the narration in
 * place when it finishes: "Searching", then "Summarized the details and its
 * impact", then "Finished". Those lines read as content to anything scraping the
 * page, and they sit directly after the question -- so a model handed the raw
 * text would take "Finished" as the opening of the answer.
 */
const STATUS_WORDS = new RegExp(
  '^(' +
    'searching|thinking|finished' +
    '|(?:reading|analyzing|analysed|analyzed|gathering|gathered)\\b.*' +
    '|(?:summarizing|summarized|summarising|summarised|synthesizing|synthesized)\\b.*' +
    '|\\+\\d+' +
    ')$',
  'i',
);

export interface WebResult {
  title: string;
  snippet: string;
  url: string | null;
  /** Which engine answered, so a finding can be attributed to it. */
  engine?: string;
  /** True for a synthesised answer rather than a search result. */
  isAnswer?: boolean;
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

/** Below this, whatever came back is a status line rather than an answer. */
const MEANINGFUL_ANSWER = 80;

/**
 * Waits for the answer itself, not for the page to stop changing.
 *
 * The obvious approach -- poll until the text stops growing -- does not work
 * here, and failed in a way worth writing down. Brave fetches before it
 * generates, and during the fetch the page sits at a constant length showing
 * "Searching". Three identical measurements later, a length-based wait declares
 * the page settled and reads the word "Searching" as the answer.
 *
 * So the thing being waited for is the extracted answer being long enough to be
 * one, and then holding still. The ceiling is there because a page that never
 * produces an answer must not hold a reply hostage.
 */
async function waitForAnswer(page: Page, query: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1_200);
    const text = await page.locator('main').first().innerText().catch(() => '');
    if (CHALLENGE.test(text)) return '';

    const { answer } = extractBraveAnswer(text, query);
    if (answer.length < MEANINGFUL_ANSWER) {
      stable = 0;
      previous = answer;
      continue;
    }

    // Long enough to be an answer, and no longer growing.
    if (answer === previous) {
      stable += 1;
      if (stable >= 2) return text;
    } else {
      stable = 0;
    }
    previous = answer;
  }

  return page.locator('main').first().innerText().catch(() => '');
}

/**
 * Separates the answer from the page around it.
 *
 * Anchored on the last echo of the question, because everything above it is
 * navigation and previously asked questions, and cut at the first thing that is
 * plainly interface rather than content.
 */
export function extractBraveAnswer(pageText: string, query: string): { answer: string; sources: string[] } {
  let body = pageText;

  const echo = body.lastIndexOf(query);
  if (echo >= 0) body = body.slice(echo + query.length);

  let end = body.length;
  for (const marker of ANSWER_ENDS) {
    const at = body.indexOf(marker);
    if (at >= 0 && at < end) end = at;
  }
  body = body.slice(0, end);

  // Citations arrive as domain / title / date triples after the prose. Keeping
  // the domains means a finding can say where it came from, which is the
  // difference between evidence and an assertion.
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !STATUS_WORDS.test(line));

  const sources: string[] = [];
  const prose: string[] = [];
  for (const line of lines) {
    if (/^[a-z0-9.-]+\.(com|org|io|net|co|news|xyz|dev|ai)$/i.test(line)) sources.push(line);
    else prose.push(line);
  }

  return { answer: prose.join('\n').trim(), sources: [...new Set(sources)].slice(0, 6) };
}

/**
 * Asks Brave for a synthesised answer.
 *
 * Nothing on the page is clicked. There is a privacy notice with a "Got it"
 * button and a settings menu, and dismissing either would be interacting with a
 * consent surface to read a page that is perfectly readable without it.
 */
async function askBrave(page: Page, query: string): Promise<WebResult[]> {
  await page.goto(`https://search.brave.com/ask?q=${encodeURIComponent(query)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  const settled = await waitForAnswer(page, query, 45_000);
  if (!settled || CHALLENGE.test(settled)) return [];

  const { answer, sources } = extractBraveAnswer(settled, query);
  if (answer.length < MEANINGFUL_ANSWER) return [];

  const results: WebResult[] = [
    {
      title: `Answer to: ${query}`,
      // Capped. An answer longer than this is padding, and the prompt has a
      // budget that the conversation itself should be spending.
      snippet: answer.slice(0, 1_200),
      url: `https://search.brave.com/ask?q=${encodeURIComponent(query)}`,
      engine: 'Brave',
      isAnswer: true,
    },
  ];

  if (sources.length > 0) {
    results.push({
      title: 'Sources it cited',
      snippet: sources.join(', '),
      url: null,
      engine: 'Brave',
    });
  }

  return results;
}

/** DuckDuckGo's HTML endpoint: no JavaScript, no interstitial, plain results. */
async function askDuckDuckGo(page: Page, query: string, limit: number): Promise<WebResult[]> {
  await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  const body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
  if (CHALLENGE.test(body)) return [];

  const results = page.locator('.result:not(.result--ad)');
  const attached = await results
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!attached) return [];

  const count = Math.min(await results.count().catch(() => 0), limit * 2);
  const found: WebResult[] = [];

  for (let index = 0; index < count && found.length < limit; index += 1) {
    const result = results.nth(index);
    const title = (await result.locator('.result__a').first().innerText().catch(() => '')).trim();
    const snippet = (await result.locator('.result__snippet').first().innerText().catch(() => '')).trim();
    const href = await result.locator('.result__a').first().getAttribute('href').catch(() => null);
    if (!title && !snippet) continue;
    found.push({ title, snippet: snippet.slice(0, 400), url: unwrap(href), engine: 'DuckDuckGo' });
  }

  return found;
}

/**
 * Leaves the research tab somewhere harmless.
 *
 * A tab parked on an answer is a stale answer that the next lookup could read
 * before its own page loads, and it leaves whatever was asked sitting on screen.
 * Cheap to do, and it means every lookup starts from nothing.
 */
async function clearResearchTab(page: Page): Promise<void> {
  await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined);
}

/**
 * Looks something up, and says who answered.
 *
 * Brave first, because a synthesised answer with dated citations is what a
 * question needs. DuckDuckGo behind it, because an answer that fails to load is
 * worth less than a snippet that does.
 *
 * Returns nothing rather than throwing when both decline. An empty result
 * becomes a recorded gap that the prompt turns into "say you do not know",
 * which is the correct outcome and a much better one than a guess.
 */
export async function webSearch(page: Page, query: string, limit = 3): Promise<WebResult[]> {
  try {
    const answered = await askBrave(page, query).catch(() => [] as WebResult[]);
    if (answered.length > 0) return answered;

    return await askDuckDuckGo(page, query, limit).catch(() => [] as WebResult[]);
  } finally {
    await clearResearchTab(page);
  }
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

    const title = (await page.title().catch(() => '')).trim();
    const body = await page
      .locator('article, main, body')
      .first()
      .innerText({ timeout: 10_000 })
      .catch(() => '');

    const text = body.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
    if (!title && !text) return null;
    return { title: title || url, snippet: text, url };
  } catch {
    return null;
  } finally {
    await clearResearchTab(page);
  }
}
