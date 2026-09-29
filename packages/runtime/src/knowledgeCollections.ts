/**
 * Documentation sites and repositories, taught as one source each and kept
 * current a document at a time.
 *
 * Built on the knowledge sources that already exist: a collection's chunks are
 * KNOWLEDGE memories with a knowledge_source_id, retrieved and cited exactly as
 * a single page's are. What a collection adds is that it holds many documents,
 * so a refresh compares each document's revision with the last one, rewrites
 * only what changed, removes what went, and reports the difference.
 *
 * ## Bounded, always
 *
 * A documentation site is read by following links, which a URL source never
 * did, so the crawl is fenced on every side: one host, one path prefix,
 * robots.txt honoured page by page, a page and depth budget, a byte budget, a
 * clock, and a pause between requests. The ceilings in COLLECTION_CEILINGS hold
 * whatever the config says. Every request goes through safeFetch, which judges
 * each redirect and refuses private addresses.
 *
 * A repository is read through its tree at one commit, not through its web
 * pages, so every chunk carries a path and the commit it came from, and a
 * refresh knows exactly which files changed from their blob hashes.
 *
 * Nothing here runs a page's scripts or follows its instructions. What was read
 * is document text, and the prompt layer quotes it as such.
 */
import { createHash } from 'node:crypto';
import {
  COLLECTION_CEILINGS,
  DocumentationSiteConfig,
  GithubRepositoryConfig,
  type KnowledgeLabelsInput,
} from '@xbam/shared/contracts';
import { createLogger, errorMessage } from '@xbam/shared';
import {
  knowledge as knowledgeRepo,
  memories as memoriesRepo,
  memoryContentHash,
  type KnowledgeChange,
  type KnowledgeDocKind,
  type KnowledgeSourceRecord,
} from '@xbam/database';
import { checkUrl, chunkDocument, looksLikeSecret, readableText, robotsAllows } from '@xbam/memory';
import { safeFetch } from '@xbam/upstream';

const log = createLogger('knowledge-collections');

// ── Fetching ────────────────────────────────────────────────────────────────

export interface Fetched {
  status: number;
  url: string;
  contentType: string;
  text: string;
}

export type FetchText = (url: string, init: { maxBytes: number; timeoutMs: number; accept: string }) => Promise<Fetched>;

/** The production fetcher: every hop judged, private addresses refused, bytes capped as they stream. */
export const fetchPublicText: FetchText = async (url, init) => {
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(init.timeoutMs),
    maxBytes: init.maxBytes,
    headers: {
      // Says what it is, so a site that wants to refuse it can.
      'user-agent': 'AI17Z-knowledge/1.0 (+reads documentation an owner attached)',
      accept: init.accept,
    },
  });
  return {
    status: response.status,
    url: response.url,
    contentType: response.headers.get('content-type') ?? '',
    text: response.text,
  };
};

const PAGE_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
/** Between requests to one host. A documentation site is somebody's server. */
const POLITE_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Documentation sites ─────────────────────────────────────────────────────

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  contentHash: string;
  depth: number;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Pages not read, and why. */
  refused: { url: string; reason: string }[];
  /** Set when the crawl stopped before it ran out of links: the budget, the clock, a failure. */
  stoppedBecause: string | null;
  requests: number;
  bytes: number;
}

/** File types that are not documentation pages. */
const NOT_A_PAGE = /\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|tar|mp4|mp3|webm|woff2?|ttf|eot|css|js|mjs|map|json|xml|rss|atom|txt|csv|wasm)$/i;

/** A page's identity: no fragment, no query, no trailing index file or slash. */
export function canonicalPageUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  u.search = '';
  u.hostname = u.hostname.toLowerCase();
  let path = u.pathname.replace(/\/index\.html?$/i, '/').replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path || '/';
  return u.toString();
}

/** The directory an address sits in, which is where a crawl from it may go. */
export function defaultPathPrefix(start: URL): string {
  const path = start.pathname;
  if (path.endsWith('/')) return path;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.') ? path.slice(0, path.lastIndexOf('/') + 1) : `${path}/`;
}

/** Links a page offers, resolved against it. Only anchors: nothing a script builds. */
export function linksIn(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const base = html.match(/<base\s+[^>]*href=["']([^"']+)["']/i)?.[1];
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    const resolved = canonicalPageUrl(m[1]!, base ? new URL(base, pageUrl).href : pageUrl);
    if (resolved) out.add(resolved);
  }
  return [...out];
}

/** A page that asks not to be indexed is not indexed, even when robots.txt allows it. */
function asksNotToBeIndexed(html: string): boolean {
  return /<meta\s+[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
}

/**
 * Reads a documentation site, breadth first, within every bound.
 *
 * Breadth first because a documentation site's most important pages are the
 * ones closest to its front page, so a crawl stopped by its budget stops having
 * read the ones that matter most.
 */
export async function crawlDocumentationSite(
  startUrl: string,
  rawConfig: unknown,
  deps: { fetch?: FetchText; delayMs?: number; now?: () => number } = {},
): Promise<CrawlResult> {
  const config = DocumentationSiteConfig.parse(rawConfig ?? {});
  const fetchText = deps.fetch ?? fetchPublicText;
  const delay = deps.delayMs ?? POLITE_DELAY_MS;
  const now = deps.now ?? Date.now;
  const result: CrawlResult = { pages: [], refused: [], stoppedBecause: null, requests: 0, bytes: 0 };

  const checked = checkUrl(startUrl);
  if (!checked.url) {
    result.stoppedBecause = checked.refusal;
    return result;
  }
  const start = checked.url;
  const host = start.hostname.toLowerCase();
  const prefix = config.pathPrefix ?? defaultPathPrefix(start);
  const maxPages = Math.min(config.maxPages, COLLECTION_CEILINGS.sitePages);
  const maxDepth = Math.min(config.maxDepth, COLLECTION_CEILINGS.siteDepth);
  const deadline = now() + COLLECTION_CEILINGS.siteMinutes * 60_000;

  // robots.txt once, for the host. Unreachable means no stated restriction.
  let robots = '';
  try {
    const r = await fetchText(new URL('/robots.txt', start.origin).href, { maxBytes: 256 * 1024, timeoutMs: PAGE_TIMEOUT_MS, accept: 'text/plain' });
    result.requests += 1;
    if (r.status === 200) robots = r.text;
  } catch {
    // Unreachable is not a refusal: absence of a robots.txt means no restriction.
  }

  const inScope = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase() !== host) return false;
      const path = u.pathname;
      // "/v2" is the prefix "/v2/" without its slash, and inside it.
      if (!(path.startsWith(prefix) || `${path}/` === prefix)) return false;
      if (config.exclude.some((e) => path.startsWith(e))) return false;
      return !NOT_A_PAGE.test(path);
    } catch {
      return false;
    }
  };

  const first = canonicalPageUrl(start.href)!;
  const queue: { url: string; depth: number }[] = [{ url: first, depth: 0 }];
  const seen = new Set<string>([first]);
  const seenContent = new Set<string>();

  while (queue.length > 0) {
    if (result.pages.length >= maxPages) {
      result.stoppedBecause = `It stopped at ${maxPages} pages, the limit for this collection.`;
      break;
    }
    if (now() >= deadline) {
      result.stoppedBecause = `It stopped after ${COLLECTION_CEILINGS.siteMinutes} minutes, the limit for one refresh.`;
      break;
    }
    if (result.bytes >= COLLECTION_CEILINGS.siteBytes) {
      result.stoppedBecause = 'It stopped at the size limit for one collection.';
      break;
    }
    const { url, depth } = queue.shift()!;
    const path = new URL(url).pathname;
    if (robots && !robotsAllows(robots, path)) {
      result.refused.push({ url, reason: 'robots.txt asks automated readers not to read it.' });
      continue;
    }

    if (result.requests > 1 && delay > 0) await sleep(delay);
    let page: Fetched;
    try {
      page = await fetchText(url, { maxBytes: MAX_PAGE_BYTES, timeoutMs: PAGE_TIMEOUT_MS, accept: 'text/html,text/plain;q=0.9' });
      result.requests += 1;
    } catch (error) {
      result.refused.push({ url, reason: `It could not be fetched: ${errorMessage(error).slice(0, 160)}` });
      continue;
    }
    result.bytes += page.text.length;
    if (page.status >= 400) {
      result.refused.push({ url, reason: `It answered ${page.status}.` });
      continue;
    }
    if (page.contentType && !/text\/html|application\/xhtml|text\/plain/i.test(page.contentType)) {
      result.refused.push({ url, reason: `It is ${page.contentType.split(';')[0]}, not a page of text.` });
      continue;
    }
    // A redirect off the host or out of the prefix is followed by safeFetch and
    // then refused here: the collection is what the owner scoped it to.
    const landed = canonicalPageUrl(page.url) ?? url;
    if (!inScope(landed)) {
      result.refused.push({ url, reason: 'It redirected outside this collection.' });
      continue;
    }

    const isHtml = /html/i.test(page.contentType) || /<html/i.test(page.text);
    if (isHtml && depth < maxDepth) {
      for (const link of linksIn(page.text, landed)) {
        if (!seen.has(link) && inScope(link)) {
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
    if (isHtml && asksNotToBeIndexed(page.text)) {
      result.refused.push({ url, reason: 'The page asks not to be indexed.' });
      continue;
    }

    const { title, text } = isHtml ? readableText(page.text) : { title: '', text: page.text.trim() };
    if (text.length < 120) {
      result.refused.push({ url, reason: 'It has almost no readable text, probably because it builds itself in the browser.' });
      continue;
    }
    const contentHash = createHash('sha256').update(text).digest('hex');
    // Two addresses serving the same page are one document.
    if (seenContent.has(contentHash)) continue;
    seenContent.add(contentHash);
    result.pages.push({ url: landed, title: title || landed, text, contentHash, depth });
  }

  stripBoilerplate(result.pages);
  return result;
}

/**
 * Removes blocks every page repeats: the sidebar, the cookie notice, the
 * "edit this page" line. readableText drops nav and footer elements; this
 * catches the ones a site draws with plain divs, which is most of them.
 */
export function stripBoilerplate(pages: CrawledPage[]): void {
  if (pages.length < 5) return;
  const counts = new Map<string, number>();
  const blocksOf = (text: string) =>
    text
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean);
  for (const page of pages) for (const block of new Set(blocksOf(page.text))) counts.set(block, (counts.get(block) ?? 0) + 1);
  const threshold = Math.ceil(pages.length * 0.6);
  for (const page of pages) {
    const kept = blocksOf(page.text).filter((b) => (counts.get(b) ?? 0) < threshold || /^#{1,6}\s/.test(b));
    page.text = kept.join('\n\n');
    page.contentHash = createHash('sha256').update(page.text).digest('hex');
  }
}

// ── GitHub repositories ─────────────────────────────────────────────────────

export interface RepoFile {
  path: string;
  sha: string;
  size: number;
  kind: KnowledgeDocKind;
}

/** Folders that are never documentation and never the source an owner meant. */
const REPO_EXCLUDED = /(^|\/)(?:node_modules|dist|build|out|vendor|third_party|\.git|\.github|coverage|target|\.next|\.cache|__pycache__)(\/|$)/i;
const DOC_FILE = /\.(?:md|mdx|markdown|rst|adoc|txt)$/i;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|sol|rs|go|py|move|vy|cairo|java|kt|swift|rb|c|h|cpp|hpp|cs|toml|yaml|yml)$/i;
const LOCKFILE = /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$/i;

export function parseRepoLocation(location: string): { owner: string; repo: string } | null {
  const trimmed = location.trim().replace(/\.git$/i, '');
  const m =
    trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:\/.*)?$/i) ??
    trimmed.match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/**
 * Which files of a tree a collection reads, and as what.
 *
 * Documentation by default: every README, a docs folder, and Markdown anywhere
 * outside the excluded folders. Source only under folders the owner named.
 */
export function selectRepoFiles(
  tree: { path: string; type: string; sha: string; size?: number }[],
  config: GithubRepositoryConfig,
): RepoFile[] {
  const under = (path: string, folders: string[]) =>
    folders.some((f) => {
      const clean = f.replace(/^\/+|\/+$/g, '');
      return clean === '' || path === clean || path.startsWith(`${clean}/`);
    });
  const out: RepoFile[] = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    const path = entry.path;
    const size = entry.size ?? 0;
    if (REPO_EXCLUDED.test(path) || LOCKFILE.test(path) || size > COLLECTION_CEILINGS.repoFileBytes) continue;
    const readme = /(^|\/)readme(\.[a-z]+)?$/i.test(path);
    const docs = config.docPaths.length > 0 ? under(path, config.docPaths) && DOC_FILE.test(path) : DOC_FILE.test(path);
    const source = config.sourcePaths.length > 0 && under(path, config.sourcePaths) && SOURCE_FILE.test(path);
    if (readme) out.push({ path, sha: entry.sha, size, kind: 'README' });
    else if (docs) out.push({ path, sha: entry.sha, size, kind: 'DOC' });
    else if (source) out.push({ path, sha: entry.sha, size, kind: 'SOURCE' });
  }
  // READMEs first, then documentation, then source, so a file budget keeps the prose.
  const order: Record<KnowledgeDocKind, number> = { README: 0, DOC: 1, PAGE: 2, SOURCE: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path)).slice(0, Math.min(config.maxFiles, COLLECTION_CEILINGS.repoFiles));
}

export interface RepoSnapshot {
  owner: string;
  repo: string;
  commit: string;
  files: RepoFile[];
  truncated: boolean;
}

/** The repository's tree at a commit. Public repositories only; no token is ever used here. */
export async function readRepoTree(location: string, rawConfig: unknown, fetchText: FetchText = fetchPublicText): Promise<RepoSnapshot> {
  const config = GithubRepositoryConfig.parse(rawConfig ?? {});
  const where = parseRepoLocation(location);
  if (!where) throw new CollectionUnavailable('That is not a GitHub repository address. Give it as https://github.com/owner/name.');
  const api = async (path: string) => {
    const r = await fetchText(`https://api.github.com${path}`, { maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000, accept: 'application/vnd.github+json' });
    if (r.status === 404) throw new CollectionUnavailable(`${where.owner}/${where.repo} could not be found. Only public repositories can be taught.`);
    if (r.status === 403 || r.status === 429) throw new Error('GitHub is limiting requests right now. It will be tried again later.');
    if (r.status >= 400) throw new Error(`GitHub answered ${r.status}.`);
    return JSON.parse(r.text) as Record<string, unknown>;
  };
  const ref = config.ref || String((await api(`/repos/${where.owner}/${where.repo}`)).default_branch ?? 'main');
  const commit = await api(`/repos/${where.owner}/${where.repo}/commits/${encodeURIComponent(ref)}`);
  const sha = String(commit.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub did not say which commit ${ref} is.`);
  const tree = await api(`/repos/${where.owner}/${where.repo}/git/trees/${sha}?recursive=1`);
  const entries = Array.isArray(tree.tree) ? (tree.tree as { path: string; type: string; sha: string; size?: number }[]) : [];
  return { ...where, commit: sha, files: selectRepoFiles(entries, config), truncated: tree.truncated === true };
}

/** A source that cannot be read at all, as opposed to a read that failed this time. */
export class CollectionUnavailable extends Error {}

// ── Indexing ────────────────────────────────────────────────────────────────

export interface CollectionReport {
  sourceId: string;
  documents: number;
  chunks: number;
  change: KnowledgeChange;
  refused: { path: string; reason: string }[];
  withheld: { path: string; reason: string }[];
  revision: string | null;
  /** The read stopped early, so documents it did not reach were kept rather than removed. */
  partial: string | null;
  error: string | null;
}

interface IncomingDoc {
  key: string;
  title: string | null;
  kind: KnowledgeDocKind;
  revision: string;
  /** Read lazily, so an unchanged document is never fetched. */
  text: () => Promise<string>;
}

/**
 * Writes one document's chunks and removes the ones it no longer produces.
 * Returns how many chunks it kept.
 */
async function writeDocument(
  source: KnowledgeSourceRecord,
  doc: { key: string; title: string | null; kind: KnowledgeDocKind; revision: string; text: string },
  report: CollectionReport,
): Promise<number> {
  const labels = (source.labels ?? {}) as KnowledgeLabelsInput;
  const chunks = chunkDocument(doc.text, { path: doc.key, revision: doc.revision, modifiedAt: null });
  const keep: string[] = [];
  for (const chunk of chunks) {
    const secret = looksLikeSecret(chunk.content);
    if (secret) {
      report.withheld.push({ path: doc.key, reason: `contains what looks like ${secret}` });
      continue;
    }
    keep.push(memoryContentHash(chunk.content));
    await memoriesRepo.writeMemory({
      agentId: source.agentId,
      scope: 'KNOWLEDGE',
      memoryType: 'DOCUMENT',
      content: chunk.content,
      summary: chunk.origin.heading || doc.title || doc.key,
      knowledgeSourceId: source.id,
      origin: {
        path: doc.key,
        heading: chunk.origin.heading,
        revision: doc.revision,
        modifiedAt: null,
        sourceName: source.name,
        docKind: doc.kind,
        ...(labels.version ? { version: labels.version } : {}),
        ...(labels.generation ? { generation: labels.generation } : {}),
        ...(labels.authority ? { authority: labels.authority } : {}),
        ...(labels.effectiveDate ? { effectiveDate: labels.effectiveDate } : {}),
      },
      importance: doc.kind === 'SOURCE' ? 0.5 : 0.6,
      confidence: 0.9,
    });
  }
  // Written first, pruned second, so an answer mid-refresh never finds a gap.
  await knowledgeRepo.pruneDocumentChunks(source.id, doc.key, keep);
  await knowledgeRepo.upsertDocument({
    sourceId: source.id,
    docKey: doc.key,
    title: doc.title,
    docKind: doc.kind,
    revision: doc.revision,
    contentHash: createHash('sha256').update(doc.text).digest('hex'),
    chunkCount: keep.length,
  });
  return keep.length;
}

/**
 * Brings a collection's documents in line with its source.
 *
 * Unchanged documents are not fetched (repositories) or not rewritten (sites).
 * Removed documents are removed only when the read was complete: a crawl that
 * stopped at its budget has not shown that the pages it did not reach are gone.
 */
async function reconcile(
  source: KnowledgeSourceRecord,
  incoming: IncomingDoc[],
  complete: boolean,
  report: CollectionReport,
): Promise<void> {
  const existing = new Map((await knowledgeRepo.listDocuments(source.id)).map((d) => [d.docKey, d]));
  const unchanged: string[] = [];
  for (const doc of incoming) {
    const before = existing.get(doc.key);
    existing.delete(doc.key);
    if (before && before.revision === doc.revision) {
      unchanged.push(doc.key);
      report.change.unchanged += 1;
      continue;
    }
    let text: string;
    try {
      text = await doc.text();
    } catch (error) {
      report.refused.push({ path: doc.key, reason: errorMessage(error).slice(0, 160) });
      if (before) unchanged.push(doc.key);
      continue;
    }
    if (!text.trim()) {
      report.refused.push({ path: doc.key, reason: 'It had no readable text.' });
      continue;
    }
    await writeDocument(source, { key: doc.key, title: doc.title, kind: doc.kind, revision: doc.revision, text }, report);
    if (before) report.change.changed += 1;
    else report.change.added += 1;
  }
  await knowledgeRepo.touchDocuments(source.id, unchanged);
  if (complete && existing.size > 0) {
    await knowledgeRepo.removeDocuments(source.id, [...existing.keys()]);
    report.change.removed += existing.size;
  }
}

/**
 * Reads a documentation-site or repository collection and records the outcome.
 *
 * Returns a report rather than throwing, like indexSource: a collection that
 * cannot be read is something its owner needs to see on the screen.
 */
export async function indexCollection(
  source: KnowledgeSourceRecord,
  deps: { fetch?: FetchText; delayMs?: number } = {},
): Promise<CollectionReport> {
  const report: CollectionReport = {
    sourceId: source.id,
    documents: 0,
    chunks: 0,
    change: { added: 0, changed: 0, removed: 0, unchanged: 0, at: new Date().toISOString() },
    refused: [],
    withheld: [],
    revision: null,
    partial: null,
    error: null,
  };
  await knowledgeRepo.updateSource(source.id, { refreshingSince: new Date().toISOString(), lastAttemptAt: new Date().toISOString() });

  try {
    if (!source.location) throw new CollectionUnavailable('This collection has no address to read.');
    if (source.kind === 'DOCUMENTATION_SITE') {
      const crawl = await crawlDocumentationSite(source.location, source.config, deps);
      if (crawl.pages.length === 0) {
        throw crawl.stoppedBecause && crawl.requests <= 1
          ? new CollectionUnavailable(crawl.stoppedBecause)
          : new CollectionUnavailable(
              crawl.refused[0]
                ? `No page could be read. The first address said: ${crawl.refused[0].reason}`
                : 'No page could be read.',
            );
      }
      report.refused.push(...crawl.refused.map((r) => ({ path: r.url, reason: r.reason })));
      report.partial = crawl.stoppedBecause;
      report.revision = createHash('sha256').update(crawl.pages.map((p) => p.contentHash).sort().join()).digest('hex').slice(0, 12);
      await reconcile(
        source,
        crawl.pages.map((p) => ({ key: p.url, title: p.title, kind: 'PAGE' as const, revision: p.contentHash.slice(0, 16), text: async () => p.text })),
        crawl.stoppedBecause === null,
        report,
      );
    } else if (source.kind === 'GITHUB_REPOSITORY') {
      const fetchText = deps.fetch ?? fetchPublicText;
      const snapshot = await readRepoTree(source.location, source.config, fetchText);
      report.revision = snapshot.commit.slice(0, 12);
      if (snapshot.truncated) report.partial = 'GitHub returned only part of this repository tree, so files it did not list were kept.';
      let bytes = 0;
      await reconcile(
        source,
        snapshot.files.map((f) => ({
          key: f.path,
          title: f.path,
          kind: f.kind,
          revision: f.sha,
          text: async () => {
            if (bytes >= COLLECTION_CEILINGS.repoBytes) throw new Error('The size limit for one collection was reached.');
            const r = await fetchText(
              `https://raw.githubusercontent.com/${snapshot.owner}/${snapshot.repo}/${snapshot.commit}/${f.path.split('/').map(encodeURIComponent).join('/')}`,
              { maxBytes: COLLECTION_CEILINGS.repoFileBytes, timeoutMs: 30_000, accept: 'text/plain' },
            );
            if (r.status >= 400) throw new Error(`It answered ${r.status}.`);
            bytes += r.text.length;
            // Markdown's own headings survive; code is kept as it is, fenced so a
            // chunk of it reads as code.
            return f.kind === 'SOURCE' ? `# ${f.path}\n\n\`\`\`\n${r.text}\n\`\`\`` : r.text;
          },
        })),
        !snapshot.truncated,
        report,
      );
    } else {
      throw new Error(`${source.kind} sources are indexed by indexSource, not as a collection.`);
    }

    const documents = await knowledgeRepo.listDocuments(source.id);
    report.documents = documents.length;
    report.chunks = await knowledgeRepo.countChunks(source.id);
    await knowledgeRepo.updateSource(source.id, {
      revision: report.revision,
      indexedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      documentCount: report.documents,
      chunkCount: report.chunks,
      lastChange: report.change,
      lastError: null,
      errorKind: null,
      refreshingSince: null,
    });
    log.info('knowledge collection indexed', {
      sourceId: source.id,
      kind: source.kind,
      documents: report.documents,
      chunks: report.chunks,
      ...report.change,
      partial: Boolean(report.partial),
    });
  } catch (error) {
    report.error = errorMessage(error);
    await knowledgeRepo.updateSource(source.id, {
      lastError: report.error.slice(0, 1_000),
      errorKind: error instanceof CollectionUnavailable ? 'UNAVAILABLE' : 'FAILED',
      refreshingSince: null,
    });
    log.warn('knowledge collection failed', { sourceId: source.id, message: report.error });
  }
  return report;
}
