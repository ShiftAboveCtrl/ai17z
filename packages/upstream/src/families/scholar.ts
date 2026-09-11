import { parseXml, XmlElement, XmlText, type XmlNode } from '@rgrove/parse-xml';
import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * Scholarly works, from a bibliographic index and a preprint archive.
 *
 * Two sources with different jobs, kept apart on purpose. Crossref is the DOI
 * registry: it knows what was published, by whom, where, and -- the valuable
 * part -- whether it was later retracted or corrected. arXiv is the preprint
 * archive: it has the paper months earlier and often has no DOI at all. Neither
 * substitutes for the other, and an answer that blurred them would let an agent
 * describe a preprint as peer reviewed.
 *
 * ### Crossref's two budgets are two different limits
 *
 * Since 1 December 2025 Crossref rates single-record requests and list/search
 * requests differently, and the response says which pool served it. Probed
 * September 2026:
 *
 *   /works/{doi}   x-api-pool: public-single   x-rate-limit-limit: 5   /1s
 *   /works?query   x-api-pool: public-array    x-rate-limit-limit: 1   /1s
 *
 * Applying the singleton budget to a search would be five times their published
 * rate for that endpoint, so the windows below carry a discriminator and the
 * two request kinds are counted separately.
 *
 * Keyless and unregistered, deliberately. Crossref offers a faster "polite
 * pool" in exchange for a contact address, which is an installation's to give
 * and not this file's to invent -- see `politeMailto`.
 *
 * ### arXiv's limit is machine-wide, and says so
 *
 * Their terms, quoted: "make no more than one request every three seconds, and
 * limit requests to a single connection at a time", and those limits "apply to
 * all of the machines under your control as a whole. You should not attempt to
 * overcome these limits by increasing the number of machines used to make
 * requests."
 *
 * So this is `MACHINE` scope with a capacity of one -- a process-local limiter
 * would be a direct breach of a published term rather than a missed
 * optimisation, because two AI17Z installations on one host would each believe
 * they had the whole allowance.
 *
 * Descriptive metadata is CC0 under their terms. Full text is not mirrored:
 * the answer links to arXiv and the agent opens it if it needs to.
 *
 * ### Sizes, measured
 *
 *   a Crossref DOI record, 2,932 authors     406 KB
 *   a Crossref DOI record, ordinary           11 KB
 *   a Crossref search, 3 rows with select    1.4 KB
 *   an arXiv entry                           2.8 KB
 *
 * The first is real rather than pathological -- a particle physics
 * collaboration has thousands of authors -- so authors are truncated on the way
 * out and the count is reported.
 */

export const PAPER_INDEX_FAMILY = 'paper_index';
export const PREPRINT_FAMILY = 'preprint_archive';

/** What kind of work this is, as the source classified it. */
export const WORK_KINDS = ['PREPRINT', 'JOURNAL_ARTICLE', 'PROCEEDINGS', 'BOOK_CHAPTER', 'DATASET', 'OTHER'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * What the sources say has happened to a work since publication.
 *
 * `NO_KNOWN_UPDATE` is the important one, and it is deliberately not called
 * anything like `CLEAN` or `VALID`. It means the sources queried hold no such
 * record. It does not mean the work is sound, was replicated, or has not been
 * disputed everywhere except in this metadata.
 */
export const INTEGRITY_STATES = [
  'RETRACTED',
  'WITHDRAWN',
  'EXPRESSION_OF_CONCERN',
  'CORRECTED',
  'UPDATED',
  'NO_KNOWN_UPDATE',
  'UNKNOWN',
] as const;
export type IntegrityState = (typeof INTEGRITY_STATES)[number];

export interface IntegrityNotice {
  /** What happened: the source's own label, normalised. */
  state: IntegrityState;
  /** The notice's own DOI, so the agent can read the retraction itself. */
  noticeDoi: string | null;
  /** The source's own words for it -- "Retraction", "Correction". */
  label: string;
  /** Who supplied it: `retraction-watch`, `publisher`, and so on. */
  source: string;
  date: string | null;
}

export interface Author {
  name: string;
  /** ORCID where the source carried one, which is the only stable author id. */
  orcid: string | null;
}

/** One work, in the shape both sources are normalised into. */
export interface ScholarlyWork {
  /** Canonical DOI (`10.x/...`), when the work has one. Preprints often do not. */
  doi: string | null;
  /** arXiv identifier without the version, which is the identity of the work. */
  arxivId: string | null;
  /** The version actually observed. A v3 can differ materially from a v1. */
  arxivVersion: number | null;
  title: string | null;
  authors: Author[];
  /** How many there were, because the list above is truncated. */
  authorCount: number;
  kind: WorkKind;
  /** The source's own type string, kept because the normalisation loses detail. */
  rawType: string | null;
  /** Journal, conference or repository. */
  container: string | null;
  publisher: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  abstract: string | null;
  /** Where a person should go to read it. */
  url: string | null;
  /** A journal reference the preprint itself declares, when it has been published. */
  journalReference: string | null;
  subjects: string[];
  integrity: IntegrityState;
  notices: IntegrityNotice[];
  /**
   * Citations, always with who counted them.
   *
   * Never a bare number. Indexes cover different literature, so two sources
   * disagreeing is ordinary and neither figure is "the" count.
   */
  citations: { count: number; source: string; observedAt: string } | null;
  /** Which source this record came from. */
  source: string;
  sourceId: string;
}

// --- DOI identity ------------------------------------------------------------

/**
 * The one canonical form of a DOI.
 *
 * A DOI arrives as a bare identifier, a `doi:` URI, an `https://doi.org/` link,
 * or the old `dx.doi.org` one, and all four are the same work. Comparing them
 * as strings makes the same paper look like four papers, which is how a lookup
 * "fails" for a DOI the caller copied out of a browser.
 *
 * Resolution is case-insensitive, so the canonical form is lower case -- but
 * only for the prefix and suffix together as an identifier. The registrant's
 * own capitalisation is not meaningful to resolution.
 */
export function canonicalDoi(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const withoutScheme = trimmed
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .replace(/^info:doi\//i, '')
    .trim();
  // A DOI is "10." then a registrant code, a slash, and a suffix that may
  // contain almost anything except whitespace.
  if (!/^10\.\d{4,9}\/\S+$/.test(withoutScheme)) return null;
  return withoutScheme.toLowerCase();
}

/** arXiv ids come as `2401.12345`, `2401.12345v3`, or the pre-2007 `hep-ex/0123456`. */
export function parseArxivId(input: string): { id: string; version: number | null } | null {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/^arxiv:/i, '')
    .replace(/\.pdf$/i, '');
  const modern = /^(\d{4}\.\d{4,5})(?:v(\d+))?$/i.exec(trimmed);
  if (modern) return { id: modern[1]!, version: modern[2] ? Number(modern[2]) : null };
  const legacy = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v(\d+))?$/i.exec(trimmed);
  if (legacy) return { id: legacy[1]!, version: legacy[2] ? Number(legacy[2]) : null };
  return null;
}

// --- queries -----------------------------------------------------------------

export const PaperQuery = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('doi'), doi: z.string().min(1).max(400) }),
  z.object({ kind: z.literal('search'), query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20) }),
]);
export type PaperQuery = z.infer<typeof PaperQuery>;

export const PreprintQuery = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('id'), arxivId: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('search'), query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20) }),
]);
export type PreprintQuery = z.infer<typeof PreprintQuery>;

export interface WorksAnswer {
  works: ScholarlyWork[];
  /** How many the index says matched, which is not how many came back. */
  totalMatched: number | null;
}

/** How many authors travel with a work. */
export const MAX_AUTHORS = 25;
/** How much abstract may travel. */
export const MAX_ABSTRACT = 4_000;

const USER_AGENT = 'AI17Z/1.0 (+https://github.com/ShiftAboveCtrl/ai17z) scholarly-metadata';

/**
 * An installation's Crossref contact address, when its owner gave one.
 *
 * Crossref's polite pool is faster in exchange for being able to contact
 * whoever is calling. That address belongs to an installation and is never
 * invented here: a developer's personal address baked into a released product
 * would identify the wrong person to an operator, on every machine that ever
 * runs it.
 *
 * Unset is the ordinary case and the public pool works perfectly well.
 */
let politeMailto: string | null = null;

export function useCrossrefContact(mailto: string | null): void {
  politeMailto = mailto && mailto.includes('@') ? mailto : null;
}

export function crossrefContact(): string | null {
  return politeMailto;
}

// --- Crossref ----------------------------------------------------------------

function kindFromCrossref(type: string | undefined): WorkKind {
  switch (type) {
    case 'journal-article':
      return 'JOURNAL_ARTICLE';
    case 'posted-content':
      // Crossref's word for a preprint. Losing this is how a preprint becomes
      // indistinguishable from a peer-reviewed article.
      return 'PREPRINT';
    case 'proceedings-article':
      return 'PROCEEDINGS';
    case 'book-chapter':
      return 'BOOK_CHAPTER';
    case 'dataset':
      return 'DATASET';
    default:
      return 'OTHER';
  }
}

function integrityFromLabel(type: string, label: string): IntegrityState {
  const text = `${type} ${label}`.toLowerCase();
  if (text.includes('retract')) return 'RETRACTED';
  if (text.includes('withdraw')) return 'WITHDRAWN';
  if (text.includes('concern')) return 'EXPRESSION_OF_CONCERN';
  if (text.includes('correct') || text.includes('erratum')) return 'CORRECTED';
  return 'UPDATED';
}

/** The worst thing that has happened to a work, which is what a reader needs first. */
function worstOf(notices: IntegrityNotice[]): IntegrityState {
  const order: IntegrityState[] = ['RETRACTED', 'WITHDRAWN', 'EXPRESSION_OF_CONCERN', 'CORRECTED', 'UPDATED'];
  for (const state of order) {
    if (notices.some((notice) => notice.state === state)) return state;
  }
  return 'NO_KNOWN_UPDATE';
}

function dateFromParts(parts: unknown): string | null {
  const list = (parts as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0];
  if (!Array.isArray(list) || list.length === 0 || typeof list[0] !== 'number') return null;
  const [year, month = 1, day = 1] = list;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function workFromCrossref(message: Record<string, unknown>): ScholarlyWork {
  const authorsRaw = (message.author as { given?: string; family?: string; name?: string; ORCID?: string }[]) ?? [];
  const notices: IntegrityNotice[] = ((message['updated-by'] as Record<string, unknown>[]) ?? []).map((notice) => ({
    state: integrityFromLabel(String(notice.type ?? ''), String(notice.label ?? '')),
    noticeDoi: typeof notice.DOI === 'string' ? canonicalDoi(notice.DOI) : null,
    label: String(notice.label ?? notice.type ?? 'update'),
    // Kept because it matters who says so: a publisher's own correction notice
    // and a third-party retraction database are different kinds of evidence.
    source: String(notice.source ?? 'unknown'),
    date: dateFromParts(notice.updated),
  }));

  const doi = typeof message.DOI === 'string' ? canonicalDoi(message.DOI) : null;
  const citationCount = message['is-referenced-by-count'];

  return {
    doi,
    arxivId: null,
    arxivVersion: null,
    title: (message.title as string[])?.[0]?.trim() ?? null,
    authors: authorsRaw.slice(0, MAX_AUTHORS).map((author) => ({
      name: author.name ?? ([author.given, author.family].filter(Boolean).join(' ') || 'unknown'),
      orcid: typeof author.ORCID === 'string' ? author.ORCID : null,
    })),
    authorCount: authorsRaw.length,
    kind: kindFromCrossref(message.type as string),
    rawType: (message.type as string) ?? null,
    container: (message['container-title'] as string[])?.[0] ?? null,
    publisher: (message.publisher as string) ?? null,
    publishedAt: dateFromParts(message.issued) ?? dateFromParts(message.published),
    updatedAt: dateFromParts(message.deposited),
    abstract: typeof message.abstract === 'string' ? message.abstract.slice(0, MAX_ABSTRACT) : null,
    url: doi ? `https://doi.org/${doi}` : ((message.URL as string) ?? null),
    journalReference: null,
    subjects: ((message.subject as string[]) ?? []).slice(0, 10),
    integrity: notices.length > 0 ? worstOf(notices) : 'NO_KNOWN_UPDATE',
    notices,
    citations:
      typeof citationCount === 'number'
        ? { count: citationCount, source: 'crossref', observedAt: new Date().toISOString() }
        : null,
    source: 'crossref',
    sourceId: doi ?? '',
  };
}

/**
 * Fields asked for on a search.
 *
 * Without this a three-row search returns whole records, and one of those
 * records can be 406 KB on its own.
 */
const SEARCH_FIELDS = 'DOI,title,type,issued,container-title,publisher,author,subject,is-referenced-by-count,abstract,URL';

function crossref(): Upstream<PaperQuery, WorksAnswer> {
  return defineUpstream<PaperQuery, WorksAnswer>({
    id: `${PAPER_INDEX_FAMILY}.crossref`,
    family: PAPER_INDEX_FAMILY,
    name: 'crossref',
    description: 'The DOI registry: what was published, by whom, and what has happened to it since.',
    origin: 'api.crossref.org',
    limit: {
      // Their published concurrency for the public pool is one.
      concurrentPerProcess: 1,
      windows: [
        // Two budgets, counted apart, because Crossref rates them apart and
        // names which one served each response.
        {
          ...perSecond(5, { scope: 'MACHINE', source: 'PUBLISHED' }),
          per: (query) => ((query as PaperQuery | undefined)?.kind === 'doi' ? 'single' : null),
        },
        {
          ...perSecond(1, { scope: 'MACHINE', source: 'PUBLISHED' }),
          per: (query) => ((query as PaperQuery | undefined)?.kind === 'search' ? 'array' : null),
        },
      ],
    },
    timeoutMs: 20_000,
    // Bibliographic metadata barely changes; a retraction is the exception and
    // an hour is soon enough to notice one.
    freshMs: 60 * 60_000,
    rank: 1,
    cacheKey: (query) => (query.kind === 'doi' ? `doi:${canonicalDoi(query.doi) ?? query.doi}` : `q:${query.query.toLowerCase()}:${query.limit}`),
    async fetch(query, ctx) {
      try {
        const contact = politeMailto ? `&mailto=${encodeURIComponent(politeMailto)}` : '';
        const url =
          query.kind === 'doi'
            ? `https://api.crossref.org/works/${encodeURIComponent(canonicalDoi(query.doi) ?? query.doi)}${contact ? `?${contact.slice(1)}` : ''}`
            : `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query.query)}` +
              `&rows=${query.limit}&select=${SEARCH_FIELDS}${contact}`;

        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          // A single record with three thousand authors measured 406 KB.
          maxBytes: 2_000_000,
        });

        // A DOI nobody has registered is the question being wrong, not the
        // registry being broken -- it must not cool off a working source.
        //
        // Only for a single record. A search that 404s has not found nothing:
        // Crossref answers a search with 200 and an empty list, so a 404 there
        // is the endpoint misbehaving, and reporting it as "no results" would
        // turn an outage into a finding about the literature.
        if (response.status === 404 && query.kind === 'doi') return { works: [], totalMatched: 0 };

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = JSON.parse(response.text) as {
          message?: Record<string, unknown> & { items?: Record<string, unknown>[]; 'total-results'?: number };
        };
        if (!body.message) throw new UpstreamFailure('BAD_RESPONSE', 'Crossref answered without a message.');

        if (query.kind === 'doi') {
          return { works: [workFromCrossref(body.message)], totalMatched: 1 };
        }
        const items = body.message.items ?? [];
        return {
          works: items.map(workFromCrossref),
          totalMatched: typeof body.message['total-results'] === 'number' ? body.message['total-results'] : null,
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

// --- arXiv -------------------------------------------------------------------

function localName(element: XmlElement): string {
  const at = element.name.indexOf(':');
  return (at === -1 ? element.name : element.name.slice(at + 1)).toLowerCase();
}

function children(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter(
    (child): child is XmlElement => child instanceof XmlElement && localName(child) === name.toLowerCase(),
  );
}

function firstChild(node: XmlElement, name: string): XmlElement | null {
  return children(node, name)[0] ?? null;
}

function text(node: XmlElement | null, max = MAX_ABSTRACT): string | null {
  if (!node) return null;
  let out = '';
  const walk = (current: XmlNode): void => {
    if (current instanceof XmlText) out += current.text;
    else if (current instanceof XmlElement) for (const child of current.children) walk(child);
  };
  for (const child of node.children) walk(child);
  const trimmed = out.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function attribute(node: XmlElement | null, name: string): string | null {
  if (!node) return null;
  const found = Object.entries(node.attributes).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof found?.[1] === 'string' && found[1].trim() !== '' ? found[1].trim() : null;
}

function workFromArxiv(entry: XmlElement): ScholarlyWork {
  const rawId = text(firstChild(entry, 'id'), 300) ?? '';
  const parsed = parseArxivId(rawId);
  const authorNodes = children(entry, 'author');
  const doiText = text(firstChild(entry, 'doi'), 200);

  return {
    doi: doiText ? canonicalDoi(doiText) : null,
    arxivId: parsed?.id ?? null,
    // Kept separately from the id: 2401.12345v1 and v3 are the same work and
    // may not say the same thing, so identity is the base and the evidence is
    // the version that was read.
    arxivVersion: parsed?.version ?? null,
    title: text(firstChild(entry, 'title'), 1_000),
    authors: authorNodes.slice(0, MAX_AUTHORS).map((author) => ({
      name: text(firstChild(author, 'name'), 200) ?? 'unknown',
      orcid: null,
    })),
    authorCount: authorNodes.length,
    // Always a preprint. A journal reference means it was *also* published --
    // it does not turn this record into the peer-reviewed article.
    kind: 'PREPRINT',
    rawType: 'arxiv-preprint',
    container: 'arXiv',
    publisher: 'arXiv',
    publishedAt: text(firstChild(entry, 'published'), 40),
    updatedAt: text(firstChild(entry, 'updated'), 40),
    abstract: text(firstChild(entry, 'summary')),
    url: parsed ? `https://arxiv.org/abs/${parsed.id}${parsed.version ? `v${parsed.version}` : ''}` : rawId || null,
    journalReference: text(firstChild(entry, 'journal_ref'), 300),
    subjects: children(entry, 'category')
      .map((category) => attribute(category, 'term'))
      .filter((term): term is string => Boolean(term))
      .slice(0, 10),
    // arXiv publishes withdrawals as a version comment rather than as
    // structured metadata, so this source cannot establish integrity either way.
    integrity: 'UNKNOWN',
    notices: [],
    // No citation counts here, and inventing a zero would read as "never cited".
    citations: null,
    source: 'arxiv',
    sourceId: parsed?.id ?? rawId,
  };
}

function arxiv(): Upstream<PreprintQuery, WorksAnswer> {
  return defineUpstream<PreprintQuery, WorksAnswer>({
    id: `${PREPRINT_FAMILY}.arxiv`,
    family: PREPRINT_FAMILY,
    name: 'arxiv',
    description: 'Preprints, with the metadata arXiv publishes under CC0.',
    origin: 'export.arxiv.org',
    limit: {
      // "limit requests to a single connection at a time" -- their words.
      concurrentPerProcess: 1,
      // "no more than one request every three seconds", and the terms say that
      // applies across every machine under our control. MACHINE scope is not an
      // optimisation here; a process-local counter would breach a published
      // term the moment a second AI17Z ran on the same host.
      windows: [{ ...perSecond(1, { scope: 'MACHINE', source: 'PUBLISHED' }), intervalMs: 3_000, label: '1/3s' }],
    },
    // Their search endpoint took 15.6 seconds in a probe, so this is generous
    // on purpose rather than optimistic.
    timeoutMs: 30_000,
    freshMs: 60 * 60_000,
    rank: 1,
    cacheKey: (query) => (query.kind === 'id' ? `id:${query.arxivId.toLowerCase()}` : `q:${query.query.toLowerCase()}:${query.limit}`),
    async fetch(query, ctx) {
      try {
        const url =
          query.kind === 'id'
            ? `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(parseArxivId(query.arxivId)?.id ?? query.arxivId)}&max_results=1`
            : `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query.query}`)}` +
              `&max_results=${query.limit}&sortBy=relevance`;

        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/atom+xml', 'user-agent': USER_AGENT },
          maxBytes: 1_000_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        let root: XmlElement;
        try {
          const document = parseXml(response.text);
          if (!document.root) throw new Error('no root element');
          root = document.root;
        } catch (error) {
          throw new UpstreamFailure('BAD_RESPONSE', `arXiv answered with unreadable XML: ${(error as Error).message}`);
        }

        const entries = children(root, 'entry');
        const totalText = text(firstChild(root, 'totalresults'), 30);
        return {
          works: entries.map(workFromArxiv),
          totalMatched: totalText && /^\d+$/.test(totalText) ? Number(totalText) : null,
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerScholarUpstreams(): void {
  registerUpstream(crossref());
  registerUpstream(arxiv());
}
