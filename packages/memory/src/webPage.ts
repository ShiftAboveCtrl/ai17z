/**
 * Teaching an agent from a page on the web.
 *
 * The reason this was left undone is that "index a website" is four decisions
 * disguised as one: what counts as the same page, how deep to follow links, how
 * often to come back, and whether the site wanted to be read at all. Each has a
 * wrong answer that turns a documentation feature into a crawler somebody
 * accidentally pointed at the internet.
 *
 * So the boundary is drawn as narrowly as it can be while still being useful:
 *
 *   **One page. The one you named. No links followed, ever.**
 *
 * That is not a limitation waiting to be lifted. A knowledge source is a thing
 * an owner can point at and be responsible for, and a person can read one page
 * and know what it says. Nobody can do that for a crawl. Somebody who wants
 * five pages adds five sources and can see all five on the screen.
 *
 * Three more decisions, each made the conservative way:
 *
 *   - **robots.txt is honoured.** Not because a fetch of one page is a burden
 *     to anybody, but because a tool that ignores it once will be pointed at
 *     something that minds, and the owner of this installation is the one whose
 *     address it goes out from.
 *   - **Refresh is on a schedule the owner sets, and never automatic by
 *     default.** A page that has not changed writes nothing, because rewriting
 *     identical chunks churns memory rows for no reading gain.
 *   - **JavaScript is not executed.** A documentation site that renders client
 *     side yields nothing readable, and that is reported as such rather than
 *     indexed as an empty page. Running the browser here would work, and would
 *     mean this feature could fetch anything and run whatever it found.
 */
import { createHash } from 'node:crypto';

/** Long enough for a slow documentation host, short enough not to hold a worker. */
const FETCH_TIMEOUT_MS = 20_000;

/** A page bigger than this is a download, not a document. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/**
 * Below this, an HTML page that parsed is treated as having rendered nothing.
 *
 * The same shape of problem as a scanned PDF: a client-rendered site returns
 * valid HTML consisting of a loading div, and indexing it silently teaches
 * nothing. A real page of documentation is thousands of characters.
 */
const MIN_READABLE_CHARS = 200;

export interface WebPage {
  url: string;
  title: string;
  text: string;
  /** A hash of the readable text, so an unchanged page writes nothing. */
  contentHash: string;
  fetchedAt: string;
  refusal: string | null;
}

/** What a URL has to be before anything is fetched. */
export function checkUrl(raw: string): { url: URL | null; refusal: string | null } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: null, refusal: 'That is not a web address. It needs to start with https://' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { url: null, refusal: `${url.protocol.replace(':', '')} addresses cannot be read. Use https://` };
  }
  // Loopback and private ranges. A knowledge source is a thing somebody points
  // at deliberately, and pointing one at 169.254.169.254 is how a fetcher reads
  // a cloud metadata service instead of a document.
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) {
    return {
      url: null,
      refusal: 'That address is on this machine or a private network. A knowledge source reads the public web.',
    };
  }
  return { url, refusal: null };
}

/**
 * Whether robots.txt permits reading this exact path.
 *
 * A deliberately small reader: the `User-agent: *` group and its `Disallow`
 * lines, longest match wins, `Allow` beats `Disallow` at equal length. It does
 * not implement crawl-delay or sitemaps because nothing here crawls. A
 * robots.txt that cannot be fetched is treated as permission -- the convention
 * is that absence means no restriction, and failing closed would make a
 * temporarily unreachable file look like a refusal by the site.
 */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim());
  let inStar = false;
  const rules: { allow: boolean; path: string }[] = [];

  for (const line of lines) {
    const [rawField, ...rest] = line.split(':');
    if (!rawField || rest.length === 0) continue;
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (field === 'user-agent') {
      inStar = value === '*';
      continue;
    }
    if (!inStar) continue;
    if (field === 'disallow') rules.push({ allow: false, path: value });
    if (field === 'allow') rules.push({ allow: true, path: value });
  }

  // An empty Disallow means "nothing is disallowed", which is the opposite of
  // a Disallow with no value being treated as matching everything.
  let best: { allow: boolean; path: string } | null = null;
  for (const rule of rules) {
    if (rule.path === '') continue;
    if (!path.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * The readable text of an HTML document.
 *
 * Deliberately not a full readability implementation. Script, style, nav and
 * footer are removed, headings keep their level as Markdown so chunking can see
 * document structure, and everything else becomes paragraphs. A page this
 * mangles is a page somebody should paste in as text instead, and the length
 * check below is what tells them.
 */
export function readableText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).replace(/\s+/g, ' ').trim() : '';

  // The head goes first. Its title and meta text are not body prose, and
  // leaving them in makes an empty page look as though it had a sentence on it,
  // which is exactly the silent success this whole check exists to catch.
  let body = html.replace(/<head[\s\S]*?<\/head>/i, ' ');
  // Order matters: strip whole elements before unwrapping the rest.
  body = body.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ');
  body = body.replace(/<(nav|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');

  // Headings become Markdown so the chunker can see where sections start.
  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, inner: string) => {
    const text = stripTags(inner);
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n\n';
  });

  body = body.replace(/<li[^>]*>/gi, '\n- ');
  body = body.replace(/<\/(p|div|section|article|tr|ul|ol|pre|blockquote|h[1-6])>/gi, '\n\n');
  body = body.replace(/<br\s*\/?>/gi, '\n');

  const text = decodeEntities(stripTags(body))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '-',
    ndash: '-',
    hellip: '...',
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (all, name: string) => named[name.toLowerCase()] ?? all);
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

export interface FetchPageOptions {
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Skips the robots check, only for a test asserting the rest of the path. */
  skipRobots?: boolean;
  now?: Date;
}

/**
 * Reads one page.
 *
 * Never throws and never follows a link. Returns a refusal with a sentence
 * somebody can act on for every way this can fail, because a knowledge source
 * that quietly indexes nothing is the failure mode this whole file is arranged
 * against.
 */
export async function fetchPage(rawUrl: string, options: FetchPageOptions = {}): Promise<WebPage> {
  const doFetch = options.fetchImpl ?? fetch;
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const empty = (refusal: string): WebPage => ({
    url: rawUrl,
    title: '',
    text: '',
    contentHash: '',
    fetchedAt,
    refusal,
  });

  const { url, refusal } = checkUrl(rawUrl);
  if (!url) return empty(refusal!);

  if (!options.skipRobots) {
    const allowed = await robotsPermits(url, doFetch);
    if (!allowed) {
      return empty(`${url.hostname} asks automated readers not to read this page, in its robots.txt.`);
    }
  }

  let response: Response;
  try {
    response = await doFetch(url.href, {
      // Redirects are followed because a documentation URL is routinely a
      // redirect to a versioned path, and the destination is still one page.
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Says what it is. A site that wants to refuse this can, which is the
        // point of being identifiable.
        'user-agent': 'AI17Z-knowledge/1.0 (+reads one page an owner named)',
        accept: 'text/html,text/plain;q=0.9',
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the request failed';
    return empty(`This page could not be fetched: ${detail.slice(0, 120)}`);
  }

  if (!response.ok) {
    return empty(`This page returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
  }

  const type = response.headers.get('content-type') ?? '';
  if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
    return empty(`This address returns ${type.split(';')[0]!.trim()}, which is not a page of text.`);
  }

  const raw = await response.text().catch(() => null);
  if (raw === null) return empty('This page could not be read as text.');
  if (raw.length > MAX_PAGE_BYTES) return empty('This page is larger than 5MB, which makes it a download rather than a document.');

  const { title, text } = /html|xhtml/i.test(type) || /<html/i.test(raw) ? readableText(raw) : { title: '', text: raw.trim() };

  if (text.length < MIN_READABLE_CHARS) {
    // The same silent failure as a scanned PDF, in a different costume.
    // States the measurement, then offers the likely cause without asserting
    // it. A page can be short because it renders in the browser or because it
    // is simply a short page, and the fetcher cannot tell which -- example.com
    // is 129 characters of real text. Naming the wrong cause confidently sends
    // somebody looking for a fault that is not there.
    //
    // Both branches say what to do. A message that explains a fault and stops
    // leaves somebody knowing they are stuck and not how to get unstuck.
    const advice =
      'That usually means the page builds itself in the browser, which is not run here. Paste the text in as a source instead, or point this at a page that serves its words.';
    return empty(
      text.length === 0
        ? `This page has no readable text. ${advice}`
        : `This page has only ${text.length} characters of readable text, which is too little to teach anything. ${advice}`,
    );
  }

  return {
    url: response.url || url.href,
    title,
    text,
    contentHash: createHash('sha256').update(text).digest('hex'),
    fetchedAt,
    refusal: null,
  };
}

async function robotsPermits(url: URL, doFetch: typeof fetch): Promise<boolean> {
  try {
    const response = await doFetch(new URL('/robots.txt', url.origin).href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'AI17Z-knowledge/1.0' },
    });
    // Anything but a served file means no stated restriction.
    if (!response.ok) return true;
    return robotsAllows(await response.text(), url.pathname);
  } catch {
    // Unreachable is not a refusal. Failing closed would make a temporary
    // network problem look like the site saying no.
    return true;
  }
}
