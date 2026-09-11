import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  CAPTURE_COMPLETENESS,
  CHECK_STATES,
  INDEX_HOST,
  MAX_RECORD_BYTES,
  PAYLOAD_VERIFICATIONS,
  WEB_HISTORY_FAMILY,
  ask,
  familyHealth,
  type HistoricalCapture,
  type IndexClaim,
  type Provenance,
  type WebHistoryAnswer,
  type WebHistoryQuery,
} from '@xbam/upstream';

/**
 * What a page said before, and the ways that could be misread.
 *
 * ### Historical evidence must never arrive looking current
 *
 * Every answer here is stamped `asOf`, and every capture carries its own
 * timestamp, because the failure this capability invites is subtle: an agent
 * reads an archived page, finds a contract address on it, and states it as the
 * project's address today. The page is real, the address is real, and the claim
 * is wrong, because the page is from two years ago.
 *
 * ### Five distinctions, kept apart deliberately
 *
 * Each of these is a different answer and collapsing any pair produces a
 * confident falsehood:
 *
 *   not captured            is not   the page did not exist
 *   a capture from 2024     is not   the page today
 *   the archive failed      is not   there is no history
 *   an archived 404         is not   no capture
 *   an archived redirect    is not   a redirect today
 *
 * The middle one is the one that bites hardest in practice. An archive being
 * unreachable is an absence of evidence, and an agent that reports it as "this
 * page has no history" has turned a network problem into a finding about
 * somebody's project.
 *
 * ### An archived redirect is reported, never followed
 *
 * A capture of a 301 says the URL pointed elsewhere at that moment. Following
 * it and presenting the destination as what the original URL held would be
 * inventing a page: the archive has a record of the redirect, and a separate
 * record of the destination, and they are different captures taken at different
 * moments. Both can be looked up; neither may stand in for the other.
 */

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

function reported(provenance: Provenance): z.infer<typeof ProvenanceOut> {
  return {
    source: provenance.upstreamId,
    host: provenance.origin,
    readAt: provenance.fetchedAt,
    fellBackFrom: provenance.fellBackFrom,
  };
}

/**
 * How many crawls one question may search.
 *
 * Every crawl is a separate request to an endpoint whose operator asks for a
 * sleep between calls, so this is the difference between a question and a
 * sweep. Six monthly crawls is roughly half a year of coverage.
 */
const MAX_CRAWLS_SEARCHED = 6;

const Url = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => /^https?:\/\/[^\s]+$/i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value), {
    message: 'Give a URL or a hostname, for example https://example.com/about or example.com/about.',
  });

const Capture = z.object({
  url: z.string(),
  capturedAt: z.string(),
  crawl: z.string(),
  /** The status the archived response carried, not the status of fetching it now. */
  archivedStatus: z.string(),
  mime: z.string().nullable(),
  digest: z.string().nullable(),
  /**
   * Where the archived response redirected to, when it was a redirect.
   *
   * Reported, never followed. Looking this URL up is a separate historical
   * question with its own answer.
   */
  archivedRedirect: z.string().nullable(),
  /** Whether this capture's bytes are small enough to read. */
  readable: z.boolean(),
  /** Opaque handle naming the bytes and what the index claimed about them. */
  ref: z.string(),
});

/**
 * The ref carries the index's claims, not just the byte pointer.
 *
 * Opaque on purpose -- it is a handle, not an interface -- but it has to hold
 * what the index said, because that is the only thing the retrieved record can
 * be checked against. A pointer alone can be honoured perfectly by a record of
 * some completely different page.
 */
function encodeRef(capture: HistoricalCapture): string {
  const packed = {
    f: capture.location.filename,
    o: capture.location.offset,
    l: capture.location.length,
    u: capture.url,
    t: capture.timestamp,
    d: capture.digest,
    s: capture.status,
    x: capture.truncated,
  };
  return Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
}

function decodeRef(
  ref: string,
): { filename: string; offset: number; length: number; claim: IndexClaim } | null {
  let packed: Record<string, unknown>;
  try {
    packed = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const filename = typeof packed.f === 'string' ? packed.f : null;
  const offset = Number(packed.o);
  const length = Number(packed.l);
  if (!filename || !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) return null;
  return {
    filename,
    offset,
    length,
    claim: {
      url: typeof packed.u === 'string' ? packed.u : null,
      timestamp: typeof packed.t === 'string' ? packed.t : null,
      digest: typeof packed.d === 'string' ? packed.d : null,
      status: typeof packed.s === 'string' ? packed.s : null,
      truncated: typeof packed.x === 'string' ? packed.x : null,
    },
  };
}

async function archiveReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(WEB_HISTORY_FAMILY);
  return health.some((entry) => entry.health.state === 'READY')
    ? { status: 'AVAILABLE' }
    : { status: 'UNAVAILABLE', why: 'No web archive is answering.' };
}

const history = defineCapability({
  id: 'web.history',
  name: 'What a page held in the past',
  description:
    'Finds archived captures of one exact URL and says when each was taken. Answers questions about the past: ' +
    'what a homepage said before a launch, whether a page changed, when something first appeared. ' +
    'Everything it returns is historical and stamped with its date; it never reports the current page. ' +
    'Finding no captures does not mean the page did not exist.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    url: Url,
    /** How far back to look, in monthly crawls. */
    crawls: z.number().int().min(1).max(MAX_CRAWLS_SEARCHED).default(3),
    limitPerCrawl: z.number().int().min(1).max(10).default(5),
  }),
  output: z.object({
    url: z.string(),
    captures: z.array(Capture),
    /** Which crawls were actually searched, so "nothing found" has a scope. */
    crawlsSearched: z.array(z.string()),
    /**
     * Crawls that were not searched, each with why.
     *
     * Named rather than silently skipped, and with a reason rather than a bare
     * list, because the reasons are not interchangeable: an archive that failed
     * and a request this process declined to make are different facts, and only
     * one of them is about the archive.
     */
    crawlsNotSearched: z.array(z.object({ crawl: z.string(), why: z.string() })),
    /** Earliest and latest capture seen, when there were any. */
    earliest: z.string().nullable(),
    latest: z.string().nullable(),
    /** Said on every answer. */
    limitations: z.array(z.string()),
    /** Which host answered the index lookups. */
    indexSource: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 90_000,
  readiness: () => archiveReadable(),
  async run(input) {
    const list = await ask<WebHistoryQuery, WebHistoryAnswer>(WEB_HISTORY_FAMILY, { kind: 'crawls' });
    const available = (list.value.crawls ?? []).slice(0, input.crawls);

    const captures: HistoricalCapture[] = [];
    const searched: string[] = [];
    const notSearched: { crawl: string; why: string }[] = [];

    for (const crawl of available) {
      // Sequentially, one crawl at a time. Their FAQ asks for exactly this and
      // the penalty for ignoring it is a day-long block.
      let answer: Awaited<ReturnType<typeof ask<WebHistoryQuery, WebHistoryAnswer>>> | null = null;
      let why: string | null = null;
      try {
        answer = await ask<WebHistoryQuery, WebHistoryAnswer>(WEB_HISTORY_FAMILY, {
          kind: 'captures',
          crawl: crawl.id,
          url: input.url,
          limit: input.limitPerCrawl,
        });
      } catch (error) {
        // Why it was not searched matters. A request this process declined to
        // send, to stay inside the archive's published rate, says nothing at
        // all about the archive -- reporting that as "unreachable" would be
        // blaming somebody else for our own pacing.
        const kind = (error as { kind?: string }).kind;
        why =
          kind === 'RATE_LIMITED'
            ? 'not asked, to stay inside the archive published rate'
            : `the archive could not be searched (${kind ?? 'failed'})`;
      }

      // A crawl that was not searched is not a crawl that held nothing.
      // Counting it as searched would turn our own pacing, or a network
      // failure, into evidence about somebody's website.
      if (!answer) {
        notSearched.push({ crawl: crawl.id, why: why ?? 'not searched' });
        continue;
      }
      searched.push(crawl.id);
      captures.push(...(answer.value.captures ?? []));
    }

    const ordered = captures.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const limitations = [
      'Everything here is historical. A capture describes the page at its timestamp, not the page now.',
      'An archive holds what it happened to crawl. No capture is not evidence that the page did not exist.',
      'An archived status or redirect describes that moment, not where the URL goes today.',
    ];
    if (ordered.some((capture) => capture.redirect)) {
      limitations.push(
        'One or more captures are redirects. Where they pointed then is reported, and has not been followed: ' +
          'the destination is a separate capture taken at its own moment, and is not what this URL contained.',
      );
    }
    if (notSearched.length > 0) {
      limitations.unshift(
        `${notSearched.length} of ${available.length} crawls were not searched ` +
          `(${notSearched.map((entry) => `${entry.crawl}: ${entry.why}`).join('; ')}), ` +
          'so this is an incomplete view rather than a complete one.',
      );
    }

    return {
      url: input.url,
      captures: ordered.map((capture) => ({
        url: capture.url,
        capturedAt: capture.capturedAt,
        crawl: capture.crawl,
        archivedStatus: capture.status,
        mime: capture.mime,
        digest: capture.digest,
        archivedRedirect: capture.redirect,
        readable: capture.location.length <= MAX_RECORD_BYTES,
        ref: encodeRef(capture),
      })),
      crawlsSearched: searched,
      crawlsNotSearched: notSearched,
      earliest: ordered[0]?.capturedAt ?? null,
      latest: ordered[ordered.length - 1]?.capturedAt ?? null,
      limitations,
      indexSource: INDEX_HOST,
      provenance: reported(list.provenance),
    };
  },
});

const capture = defineCapability({
  id: 'web.history_capture',
  name: 'Read an archived page',
  description:
    'Fetches the content of one archived capture, using a ref from web.history, and checks that the bytes ' +
    'really are the capture the index pointed at. The text returned is what the page said at that capture time ' +
    'and must be quoted as of that date, never as what the page says now.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /** The opaque ref from `web.history`. */
    ref: z.string().trim().min(3).max(2000),
  }),
  output: z.object({
    /** The URL the archive says this record is of. */
    url: z.string().nullable(),
    /** Stamped on the content itself, so it cannot travel without its date. */
    asOf: z.string().nullable(),
    /** The status the archived response carried. */
    archivedStatus: z.number().nullable(),
    /** Where it redirected then, when it was a redirect. Not followed. */
    archivedRedirect: z.string().nullable(),
    contentType: z.string().nullable(),
    /** The archived body, bounded. */
    content: z.string(),
    /** True when this code clipped the body, which is not the crawler truncating it. */
    clipped: z.boolean(),
    /**
     * What can actually be shown about these bytes.
     *
     * Separate from the content deliberately: an agent quoting an archived page
     * should be able to say whether the archive's own digest confirms the bytes,
     * or whether it could not be checked.
     */
    integrity: z.object({
      payload: z.enum(PAYLOAD_VERIFICATIONS),
      payloadDetail: z.string(),
      completeness: z.enum(CAPTURE_COMPLETENESS),
      completenessWhy: z.string(),
      matchesIndex: z.object({
        url: z.enum(CHECK_STATES),
        capturedAt: z.enum(CHECK_STATES),
        digest: z.enum(CHECK_STATES),
        status: z.enum(CHECK_STATES),
      }),
      notes: z.array(z.string()),
      payloadDigest: z.string().nullable(),
    }),
    limitations: z.array(z.string()),
    /** Which host holds the index, as opposed to which served these bytes. */
    indexSource: z.string(),
    contentSource: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 40_000,
  readiness: () => archiveReadable(),
  async run(input) {
    const located = decodeRef(input.ref);
    if (!located) {
      throw new Error('That is not a capture reference. Use the ref from web.history exactly as it was given.');
    }

    const answer = await ask<WebHistoryQuery, WebHistoryAnswer>(WEB_HISTORY_FAMILY, {
      kind: 'content',
      filename: located.filename,
      offset: located.offset,
      length: located.length,
      claim: located.claim,
    });
    const content = answer.value.content;
    if (!content) throw new Error('The archive returned no record for that capture.');

    const asOf = content.capturedAt;
    const limitations = [
      asOf
        ? `This is the page as of ${asOf}. It is not the page now, and anything taken from it must be quoted with that date.`
        : 'This is an archived capture, not the page now.',
      'An archived page can contain addresses, prices and claims that were superseded long ago.',
    ];

    if (content.status !== null && content.status >= 400) {
      // An archived error page is a real capture of a real moment, and it is
      // not the same as the URL having no captures.
      limitations.push(
        `The archived response was ${content.status}: the site itself answered with an error at that moment. ` +
          'That is a fact about then, not an absence of history.',
      );
    }

    const redirect = content.headers['location'] ?? null;
    if (content.status !== null && content.status >= 300 && content.status < 400) {
      limitations.push(
        'This capture is a redirect. Where it pointed then is reported and has not been followed; ' +
          'the destination is its own capture at its own moment and is not what this URL contained.',
      );
    }

    if (content.payloadVerification !== 'VERIFIED') {
      limitations.push(`These bytes are not cryptographically confirmed: ${content.payloadDetail}`);
    }
    if (content.completeness !== 'COMPLETE') {
      limitations.push(content.completenessWhy);
    }
    const disagreements = Object.entries(content.checks)
      .filter(([key, value]) => key !== 'notes' && value === 'MISMATCH')
      .map(([key]) => key);
    if (disagreements.length > 0) {
      limitations.unshift(
        `This record disagrees with the index that pointed at it (${disagreements.join(', ')}), ` +
          'so it may not be the capture that was asked for.',
      );
    }

    return {
      url: content.targetUri,
      asOf,
      archivedStatus: content.status,
      archivedRedirect: redirect,
      contentType: content.headers['content-type'] ?? null,
      content: content.body,
      clipped: content.clipped,
      integrity: {
        payload: content.payloadVerification,
        payloadDetail: content.payloadDetail,
        completeness: content.completeness,
        completenessWhy: content.completenessWhy,
        matchesIndex: {
          url: content.checks.url,
          capturedAt: content.checks.capturedAt,
          digest: content.checks.digest,
          status: content.checks.status,
        },
        notes: content.checks.notes,
        payloadDigest: content.payloadDigest,
      },
      limitations,
      indexSource: INDEX_HOST,
      contentSource: content.servedBy,
      // The host that actually served the record, not the family's index host.
      // Provenance a reader cannot trust on the small things is provenance they
      // will not trust on the large ones.
      provenance: { ...reported(answer.provenance), host: content.servedBy },
    };
  },
});

export function registerWebHistoryCapabilities(): void {
  registerCapability(history);
  registerCapability(capture);
}
