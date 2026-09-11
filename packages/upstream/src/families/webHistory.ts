import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';

/**
 * What a page said in the past, from a public web archive.
 *
 * ### This is not a search engine
 *
 * Nothing here finds pages. It answers a narrower and more useful question:
 * given a URL somebody already has, what was at it, and when. "Did the
 * tokenomics page say this before the announcement" is a question no search
 * index answers and an archive does.
 *
 * ### Common Crawl's rules, read from their FAQ rather than guessed
 *
 * Checked September 2026, and stricter than the usual etiquette:
 *
 *   "Always use HTTPS -- HTTP connections are not supported and may fail."
 *   "Don't run multiple threads at once on the same IP, and don't use proxy
 *    networks."
 *   "Please sleep between calls to our API."
 *   "If you receive HTTP 503 responses, please slow down your request rate."
 *   "If your IP is temporarily blocked, please wait 24 hours."
 *
 * A twenty-four hour block is a serious consequence for getting this wrong, so
 * `concurrentPerProcess: 1` here is a requirement rather than a courtesy.
 *
 * They also say that broad or large-scale filtering belongs in their columnar
 * URL Index through Athena or Spark rather than against this endpoint. So this
 * family does exact-URL lookups and nothing else: no wildcard scans, no domain
 * sweeps, no walking the corpus.
 *
 * ### The record has to prove it is the record that was asked for
 *
 * An index entry is a pointer: a file, an offset, a length. Everything after
 * that is trust unless it is checked, and three things can go wrong quietly.
 *
 * The server can ignore the `Range` header and start sending a file that is
 * most of a gigabyte, of which the first bytes are a different record entirely.
 * It can serve a range that is not the range asked for. And the bytes can
 * decompress into something that is simply a different page. None of those
 * announce themselves: each produces a plausible archived page that is not the
 * one the index pointed at.
 *
 * So a range is only accepted when the response is 206, carries a
 * `Content-Range` naming exactly the requested first and last byte, and is
 * exactly as many bytes as the index said. After that the record's own metadata
 * is compared with the index entry, field by field, and every comparison is a
 * named state rather than a boolean -- because "the index did not say" and "the
 * index said something else" are different facts and only one of them is a
 * problem.
 *
 * ### The payload digest really is verifiable, and that was established rather than assumed
 *
 * Common Crawl's `digest` is documented as a SHA-1 of the capture contents, and
 * the same value appears as `WARC-Payload-Digest`. Documented is not the same
 * as demonstrated, so it was demonstrated. Probed September 2026 against a live
 * record:
 *
 *   sha1(body as stored)                     -> WLILXNMFR6RNGSENEIQI3GJEZMIG3NFW
 *   sha1(body minus a trailing CRLF)         -> 6HIV6YIVKIAHZRSD4GSZD2EW6TYWBMXE
 *   sha1(first Content-Length bytes)         -> KFMR3RACAHZZH2HGKDPO3FQODMO3XIJ7   <- the index's digest
 *
 * The payload is exactly `Content-Length` bytes and excludes the `\r\n\r\n`
 * that terminates the record. Two of those three answers are wrong and all
 * three look equally reasonable in a comment, which is why a guess here would
 * have produced a cryptographic claim that quietly did not hold.
 *
 * Where the bounds cannot be established -- no `Content-Length`, a truncated
 * record -- the answer is `NOT_VERIFIED` and says why. An unverifiable capture
 * is a fact about the capture, not a reason to pretend.
 *
 * ### What was measured
 *
 *   collinfo.json, every crawl        34.9 KB   177ms
 *   a CDX lookup, 2 captures            948 B   320-440ms
 *   a WARC record by byte range          953 B  190ms, HTTP 206
 *
 * Free, no key, no account. Checked September 2026.
 */

export const WEB_HISTORY_FAMILY = 'web_history';

/**
 * How an index claim compared with what the record itself said.
 *
 * Three states rather than a boolean, because a field the index did not carry
 * has not disagreed with anything. Flattening `NOT_AVAILABLE` into `MISMATCH`
 * invents a discrepancy; flattening it into `MATCHED` invents a confirmation.
 */
export const CHECK_STATES = ['MATCHED', 'MISMATCH', 'NOT_AVAILABLE'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/** Whether the bytes were cryptographically shown to be the indexed capture. */
export const PAYLOAD_VERIFICATIONS = ['VERIFIED', 'MISMATCH', 'NOT_AVAILABLE', 'NOT_VERIFIED'] as const;
export type PayloadVerification = (typeof PAYLOAD_VERIFICATIONS)[number];

/**
 * Whether the archived body is the whole of what the site sent.
 *
 * `UNKNOWN` is the honest default. A crawler truncates large responses, and
 * older crawls do not always say when they did, so "a body came back" must
 * never be read as "this is the complete original page".
 */
export const CAPTURE_COMPLETENESS = ['COMPLETE', 'TRUNCATED', 'UNKNOWN'] as const;
export type CaptureCompleteness = (typeof CAPTURE_COMPLETENESS)[number];

/** Where a capture's bytes live, as the index reports them. */
export interface CaptureLocation {
  filename: string;
  offset: number;
  length: number;
}

export interface HistoricalCapture {
  /** The URL as the archive recorded it, which may differ from what was asked. */
  url: string;
  /** `YYYYMMDDhhmmss`, in the archive's own form. */
  timestamp: string;
  /** The same moment as an ISO string, for anything that has to compare. */
  capturedAt: string;
  /** The crawl this came from -- `CC-MAIN-2026-34`. */
  crawl: string;
  /**
   * The status the *archived* response carried.
   *
   * Not the status of fetching it now. A capture can be a 301, and that is a
   * fact about the site at that moment rather than about the site today.
   */
  status: string;
  mime: string | null;
  /** Content digest, when the index carries one. Identical digests are identical bytes. */
  digest: string | null;
  /** Where the capture redirected to, when it was a redirect. */
  redirect: string | null;
  /** What the index said about truncation, when it said anything. */
  truncated: string | null;
  location: CaptureLocation;
}

/** What the index claimed, carried so the record can be checked against it. */
export const IndexClaim = z.object({
  url: z.string().max(2048).nullable(),
  timestamp: z.string().max(20).nullable(),
  digest: z.string().max(120).nullable(),
  status: z.string().max(10).nullable(),
  truncated: z.string().max(40).nullable(),
});
export type IndexClaim = z.infer<typeof IndexClaim>;

export const WebHistoryQuery = z.discriminatedUnion('kind', [
  /** Which crawls exist, newest first. */
  z.object({ kind: z.literal('crawls') }),
  /** Captures of one exact URL within one crawl. */
  z.object({
    kind: z.literal('captures'),
    crawl: z.string().min(1).max(40),
    url: z.string().min(1).max(2048),
    limit: z.number().int().min(1).max(20),
  }),
  /** The archived bytes of one capture, checked against what the index claimed. */
  z.object({
    kind: z.literal('content'),
    filename: z.string().min(1).max(400),
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive(),
    claim: IndexClaim,
  }),
]);
export type WebHistoryQuery = z.infer<typeof WebHistoryQuery>;

/** How the record compared with the index entry that pointed at it. */
export interface RecordChecks {
  url: CheckState;
  capturedAt: CheckState;
  digest: CheckState;
  status: CheckState;
  /** Both forms, whenever they differ at all, so nothing is hidden by a verdict. */
  notes: string[];
}

export interface ArchivedContent {
  /** The URL the archive says this record is of. */
  targetUri: string | null;
  capturedAt: string | null;
  /** The status line of the archived HTTP response. */
  status: number | null;
  /** Headers of the archived response, lower-cased. */
  headers: Record<string, string>;
  /** The archived body, decoded and bounded. */
  body: string;
  /** True when the body was cut short by this code's own cap, not by the crawler. */
  clipped: boolean;
  /** The payload digest the archive recorded, when it recorded one. */
  payloadDigest: string | null;
  /** Whether the bytes hash to the digest the index published. */
  payloadVerification: PayloadVerification;
  /** Why, in a sentence, whenever that is not a plain VERIFIED. */
  payloadDetail: string;
  /** Whether the crawler stored the whole response. */
  completeness: CaptureCompleteness;
  completenessWhy: string;
  /** What `WARC-Truncated` said, when the record carried it. */
  warcTruncated: string | null;
  checks: RecordChecks;
  /**
   * The host that actually served these bytes.
   *
   * Carried because it is not the family's `origin`. That field is one value
   * per upstream and it is deliberately the index host here, so both of Common
   * Crawl's hosts share a single machine-scoped budget -- which is the correct
   * rate behaviour, since the thing being metered is one IP talking to one
   * operator. But a record comes from `data.commoncrawl.org`, and provenance
   * that named the index for it would be telling a reader something untrue
   * about where their evidence came from.
   */
  servedBy: string;
}

export interface WebHistoryAnswer {
  /** Present for `crawls`. */
  crawls?: { id: string; name: string; from: string | null; to: string | null }[];
  /** Present for `captures`. Empty is an answer: nothing was captured. */
  captures?: HistoricalCapture[];
  /** Present for `content`. */
  content?: ArchivedContent;
}

/**
 * Common Crawl asks for a properly formulated User-Agent, citing RFC 9110.
 *
 * Named so an operator reading their logs can tell what this is and who to
 * contact. Anonymous traffic is what gets a netblock blocked for a day.
 */
const USER_AGENT = 'AI17Z/1.0 (+https://github.com/ShiftAboveCtrl/ai17z) autonomous-agent-toolspace';

/**
 * The largest archived record this will pull down, compressed.
 *
 * A capture's compressed length is known from the index before anything is
 * fetched, so an oversized one is declined rather than downloaded and then
 * discarded.
 */
export const MAX_RECORD_BYTES = 1_000_000;

/** Where archived bytes live, as opposed to where the index lives. */
export const CONTENT_HOST = 'data.commoncrawl.org';
/** Where the index lives. */
export const INDEX_HOST = 'index.commoncrawl.org';

/**
 * The largest a record may become once decompressed.
 *
 * This bound is separate from the fetch cap and it has to be, because the gzip
 * here is the archive file's own rather than a transfer encoding: the response
 * arrives with no `content-encoding`, so nothing in `safeFetch` is looking at
 * it and `maxBytes` has already been satisfied by the compressed size. A
 * hostile or corrupt member could expand without limit inside `gunzipSync`.
 * Node refuses past this rather than allocating.
 */
export const MAX_INFLATED_BYTES = 4_000_000;

/** How much of an archived page is allowed to reach a prompt. */
export const MAX_BODY_CHARS = 100_000;

function isoFromStamp(stamp: string): string {
  // `YYYYMMDDhhmmss`, which is not a format anything parses on its own.
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return stamp;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

/**
 * RFC 4648 base32, upper case and unpadded -- the form WARC digests use.
 *
 * Exported so it can be pinned against the RFC's own vectors. A SHA-1 is 160
 * bits, which is exactly thirty-two five-bit groups, so the trailing partial
 * group below never runs for the digests this family computes -- and code that
 * never runs under its own tests is code nobody has checked.
 */
export function base32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Checks that the response is the byte range that was asked for.
 *
 * A server that ignores `Range` answers 200 with the start of a file that is
 * most of a gigabyte, and the first bytes of it parse perfectly well as some
 * other record. Nothing about that failure looks like a failure, which is why
 * it is checked rather than assumed.
 */
export function assertServedRange(input: {
  status: number;
  contentRange: string | null;
  received: number;
  offset: number;
  length: number;
}): void {
  if (input.status !== 206) {
    throw new UpstreamFailure(
      'BAD_RESPONSE',
      `The archive answered ${input.status} rather than 206, so this is not the requested record but the start of the file it lives in.`,
    );
  }
  if (!input.contentRange) {
    throw new UpstreamFailure('BAD_RESPONSE', 'The archive answered 206 without saying which bytes it sent.');
  }
  const parsed = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(input.contentRange.trim());
  if (!parsed) {
    throw new UpstreamFailure('BAD_RESPONSE', `The archive answered an unreadable Content-Range: ${input.contentRange}`);
  }
  const start = Number(parsed[1]);
  const end = Number(parsed[2]);
  const wantedEnd = input.offset + input.length - 1;
  if (start !== input.offset || end !== wantedEnd) {
    throw new UpstreamFailure(
      'BAD_RESPONSE',
      `The archive sent bytes ${start}-${end} when ${input.offset}-${wantedEnd} was asked for, so these are not the indexed bytes.`,
    );
  }
  if (input.received !== input.length) {
    throw new UpstreamFailure(
      'BAD_RESPONSE',
      `The archive sent ${input.received} bytes where the index said ${input.length}.`,
    );
  }
}

/**
 * Whether two archived URLs are the same page in different clothes.
 *
 * Deliberately narrow. An index and a record can disagree about the scheme or a
 * trailing slash for reasons that are about representation rather than about
 * which page was fetched, and calling those a mismatch would cry wolf on every
 * capture. Anything beyond that -- a different host, a different path -- is a
 * genuine disagreement and is reported as one, because a record of some other
 * page must never quietly become the page that was asked about.
 */
export function sameArchivedUrl(a: string, b: string): { same: boolean; note: string | null } {
  if (a === b) return { same: true, note: null };
  const strip = (value: string) => value.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (strip(a) === strip(b)) {
    return { same: true, note: `The index says "${a}" and the record says "${b}"; they differ only in scheme or trailing slash.` };
  }
  return { same: false, note: `The index says "${a}" but the record is of "${b}".` };
}

function compare(claimed: string | null, actual: string | null, label: string, notes: string[]): CheckState {
  if (claimed === null || actual === null) return 'NOT_AVAILABLE';
  if (claimed === actual) return 'MATCHED';
  notes.push(`${label}: the index said "${claimed}" and the record says "${actual}".`);
  return 'MISMATCH';
}

/**
 * Splits a WARC record and checks it against what the index claimed.
 *
 * Works on bytes rather than a decoded string throughout, because the payload
 * digest is over octets: decoding first and hashing the result would hash
 * something the archive never stored.
 */
export function parseRecord(raw: Buffer, claim: IndexClaim, servedBy: string): ArchivedContent {
  const separator = Buffer.from('\r\n\r\n');
  const warcEnd = raw.indexOf(separator);
  if (warcEnd === -1) {
    throw new UpstreamFailure('BAD_RESPONSE', 'That archived record has no WARC header.');
  }
  const warcHeader = raw.subarray(0, warcEnd).toString('utf8');
  const afterWarc = raw.subarray(warcEnd + 4);

  const warcField = (name: string): string | null => {
    const found = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(warcHeader);
    return found ? found[1]!.trim() : null;
  };

  const httpEnd = afterWarc.indexOf(separator);
  // A record with no HTTP part is a revisit or a truncated fetch. That is an
  // answer about the capture, not a parse failure.
  const httpHead = (httpEnd === -1 ? afterWarc : afterWarc.subarray(0, httpEnd)).toString('utf8');
  const bodyBytes = httpEnd === -1 ? Buffer.alloc(0) : afterWarc.subarray(httpEnd + 4);

  const statusLine = /^HTTP\/[\d.]+\s+(\d{3})/.exec(httpHead);
  const headers: Record<string, string> = {};
  for (const line of httpHead.split('\r\n').slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }

  const declaredDigest = warcField('WARC-Payload-Digest');
  const warcTruncated = warcField('WARC-Truncated');
  const targetUri = warcField('WARC-Target-URI');
  const warcDate = warcField('WARC-Date');
  const archivedStatus = statusLine ? Number(statusLine[1]) : null;

  // --- the payload, and whether it hashes to what the index published --------
  //
  // Established by probe rather than by reading: the payload is exactly
  // Content-Length bytes and excludes the CRLFCRLF that ends the record.
  const declaredLength = Number(headers['content-length']);
  let payload: Buffer | null = null;
  let payloadWhy = '';
  if (Number.isInteger(declaredLength) && declaredLength >= 0 && declaredLength <= bodyBytes.length) {
    payload = bodyBytes.subarray(0, declaredLength);
  } else if (bodyBytes.length >= 4 && bodyBytes.subarray(bodyBytes.length - 4).equals(separator)) {
    payload = bodyBytes.subarray(0, bodyBytes.length - 4);
    payloadWhy = 'The record carried no usable Content-Length, so the payload was taken as the body up to the record terminator.';
  } else {
    payloadWhy = 'The record carried no Content-Length and no record terminator, so the payload bounds cannot be established.';
  }

  const expectedDigest = claim.digest ?? (declaredDigest ? declaredDigest.replace(/^sha1:/i, '') : null);
  let payloadVerification: PayloadVerification;
  let payloadDetail: string;
  if (!expectedDigest) {
    payloadVerification = 'NOT_AVAILABLE';
    payloadDetail = 'Neither the index nor the record published a payload digest, so there is nothing to check against.';
  } else if (!payload) {
    payloadVerification = 'NOT_VERIFIED';
    payloadDetail = payloadWhy;
  } else {
    const computed = base32(createHash('sha1').update(payload).digest());
    if (computed === expectedDigest) {
      payloadVerification = 'VERIFIED';
      payloadDetail = `The bytes hash to ${computed}, which is the digest the archive published for this capture.`;
    } else {
      payloadVerification = 'MISMATCH';
      payloadDetail = `The bytes hash to ${computed} but the archive published ${expectedDigest}. These are not the indexed bytes.`;
    }
  }

  // --- completeness ---------------------------------------------------------
  let completeness: CaptureCompleteness;
  let completenessWhy: string;
  if (warcTruncated || claim.truncated) {
    completeness = 'TRUNCATED';
    completenessWhy = `The crawler recorded this capture as truncated (${warcTruncated ?? claim.truncated}), so the page was longer than what was stored.`;
  } else if (payloadVerification === 'VERIFIED') {
    // The digest is over the payload the crawler stored, so a match says the
    // stored bytes are whole. It does not say the crawler stored everything --
    // but with no truncation flag and an intact payload, complete is the
    // supportable reading.
    completeness = 'COMPLETE';
    completenessWhy = 'Nothing recorded this capture as truncated and the stored payload matches its published digest.';
  } else {
    completeness = 'UNKNOWN';
    completenessWhy =
      'Nothing recorded this capture as truncated, but the stored bytes could not be verified, so whether this is the whole page cannot be established.';
  }

  // --- the index's claims against the record's own account ------------------
  const notes: string[] = [];
  let urlCheck: CheckState;
  if (claim.url === null || targetUri === null) {
    urlCheck = 'NOT_AVAILABLE';
  } else {
    const verdict = sameArchivedUrl(claim.url, targetUri);
    if (verdict.note) notes.push(verdict.note);
    urlCheck = verdict.same ? 'MATCHED' : 'MISMATCH';
  }

  const capturedAtCheck = compare(
    claim.timestamp ? isoFromStamp(claim.timestamp) : null,
    warcDate ? new Date(warcDate).toISOString() : null,
    'Capture time',
    notes,
  );
  const digestCheck = compare(
    claim.digest,
    declaredDigest ? declaredDigest.replace(/^sha1:/i, '') : null,
    'Payload digest',
    notes,
  );
  const statusCheck = compare(
    claim.status,
    archivedStatus === null ? null : String(archivedStatus),
    'Archived status',
    notes,
  );

  const bodyText = bodyBytes.toString('utf8');
  return {
    targetUri,
    capturedAt: warcDate,
    status: archivedStatus,
    headers,
    body: bodyText.slice(0, MAX_BODY_CHARS),
    clipped: bodyText.length > MAX_BODY_CHARS,
    payloadDigest: declaredDigest,
    payloadVerification,
    payloadDetail,
    completeness,
    completenessWhy,
    warcTruncated,
    checks: { url: urlCheck, capturedAt: capturedAtCheck, digest: digestCheck, status: statusCheck, notes },
    servedBy,
  };
}

function commoncrawl(): Upstream<WebHistoryQuery, WebHistoryAnswer> {
  return defineUpstream<WebHistoryQuery, WebHistoryAnswer>({
    id: `${WEB_HISTORY_FAMILY}.commoncrawl`,
    family: WEB_HISTORY_FAMILY,
    name: 'commoncrawl',
    description: 'What a URL held in the past, from Common Crawl captures.',
    // The lookup host. `content` reaches data.commoncrawl.org, which is the
    // same operator; both deliberately share this one machine-scoped budget,
    // because what is metered is one IP talking to one operator.
    origin: INDEX_HOST,
    limit: {
      // Their FAQ: "Don't run multiple threads at once on the same IP." Not a
      // preference, and a breach of it costs a twenty-four hour block.
      concurrentPerProcess: 1,
      // "Please sleep between calls" -- so one a second, which is literally
      // that, and fifteen a minute so sustained use stays modest even with both
      // hosts counted separately.
      //
      // The per-second shape is load-bearing rather than arbitrary. The limiter
      // paces a caller for up to two seconds and refuses anything longer, so a
      // window that refills inside one second spaces requests out, while a
      // ten-second one would refuse the second crawl of a three-crawl search
      // outright. One question asking about six months of history is seven
      // lookups, and it has to be able to finish.
      windows: [perSecond(1, { scope: 'MACHINE' }), perMinute(15, { scope: 'MACHINE' })],
    },
    timeoutMs: 25_000,
    // An archived capture is immutable: the bytes at a timestamp are the bytes
    // at that timestamp, for ever. The list of crawls changes monthly. Both are
    // held long because this endpoint must not be asked twice for one answer.
    freshMs: 6 * 60 * 60_000,
    rank: 1,
    cacheKey: (query) =>
      query.kind === 'crawls'
        ? 'crawls'
        : query.kind === 'captures'
          ? `captures:${query.crawl}:${query.url.toLowerCase()}:${query.limit}`
          : `content:${query.filename}:${query.offset}:${query.length}`,
    async fetch(query, ctx) {
      try {
        if (query.kind === 'crawls') {
          const response = await safeFetch(`https://${INDEX_HOST}/collinfo.json`, {
            signal: ctx.signal,
            headers: { accept: 'application/json', 'user-agent': USER_AGENT },
            // Measured at 34.9 KB across every crawl they have ever published.
            maxBytes: 300_000,
          });
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;
          const rows = JSON.parse(response.text) as Record<string, unknown>[];
          if (!Array.isArray(rows)) throw new UpstreamFailure('BAD_RESPONSE', 'The index answered with no crawl list.');
          return {
            crawls: rows
              .filter((row) => typeof row.id === 'string')
              .map((row) => ({
                id: row.id as string,
                name: typeof row.name === 'string' ? row.name : (row.id as string),
                from: typeof row.from === 'string' ? row.from : null,
                to: typeof row.to === 'string' ? row.to : null,
              })),
          };
        }

        if (query.kind === 'captures') {
          const url =
            `https://${INDEX_HOST}/${encodeURIComponent(query.crawl)}-index` +
            `?url=${encodeURIComponent(query.url)}&output=json&limit=${query.limit}`;
          const response = await safeFetch(url, {
            signal: ctx.signal,
            headers: { accept: 'application/json', 'user-agent': USER_AGENT },
            maxBytes: 400_000,
          });

          // A 404 here carries {"message": "No Captures found for: ..."} and it
          // is an answer rather than a fault: this crawl holds nothing for this
          // URL. Letting it reach the breaker would cool off a working index
          // because somebody asked about a page that was never crawled -- and
          // it must not become "the page did not exist" either.
          if (response.status === 404) return { captures: [] };

          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;

          const captures: HistoricalCapture[] = [];
          for (const line of response.text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let row: Record<string, unknown>;
            try {
              row = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              // One malformed line does not discard the captures that parsed.
              continue;
            }
            if (typeof row.timestamp !== 'string' || typeof row.filename !== 'string') continue;
            const offset = Number(row.offset);
            const length = Number(row.length);
            if (!Number.isFinite(offset) || !Number.isFinite(length)) continue;
            captures.push({
              url: typeof row.url === 'string' ? row.url : query.url,
              timestamp: row.timestamp,
              capturedAt: isoFromStamp(row.timestamp),
              crawl: query.crawl,
              status: typeof row.status === 'string' ? row.status : 'unknown',
              mime: typeof row.mime === 'string' ? row.mime : null,
              digest: typeof row.digest === 'string' ? row.digest : null,
              redirect: typeof row.redirect === 'string' ? row.redirect : null,
              truncated: typeof row.truncated === 'string' ? row.truncated : null,
              location: { filename: row.filename, offset, length },
            });
          }
          return { captures };
        }

        if (query.length > MAX_RECORD_BYTES) {
          throw new UpstreamFailure(
            'UNSUPPORTED',
            `That capture is ${query.length} bytes, past the ${MAX_RECORD_BYTES} this will fetch.`,
          );
        }

        const end = query.offset + query.length - 1;
        const response = await safeFetch(`https://${CONTENT_HOST}/${query.filename}`, {
          signal: ctx.signal,
          headers: {
            'user-agent': USER_AGENT,
            // The whole point: one record out of a file that is most of a
            // gigabyte. The probe's file was 905,915,622 bytes and the record
            // wanted was 953 of them.
            range: `bytes=${query.offset}-${end}`,
          },
          maxBytes: MAX_RECORD_BYTES,
          // Gzip, and decoding it as text does not fail loudly -- it produces
          // replacement characters and the damage surfaces later as a
          // decompression error with no obvious cause.
          binary: true,
        });

        // A rate limit or an outage is still classified first: those are about
        // the service, not about the range.
        if (response.status !== 206) {
          const status = classifyStatus(response.status, response.headers);
          if (status) throw status;
        }
        if (!response.bytes) throw new UpstreamFailure('BAD_RESPONSE', 'The archive answered with no bytes.');

        assertServedRange({
          status: response.status,
          contentRange: response.headers.get('content-range'),
          received: response.bytes.byteLength,
          offset: query.offset,
          length: query.length,
        });

        let inflated: Buffer;
        try {
          // The bound that `maxBytes` cannot provide: this gzip is the file's
          // own, arrives with no content-encoding, and has already satisfied
          // the fetch cap at its compressed size.
          //
          // One record is one gzip member, and the range is exactly the length
          // the index published -- checked above -- so a second member cannot
          // be hiding past the end of it.
          inflated = gunzipSync(response.bytes, { maxOutputLength: MAX_INFLATED_BYTES });
        } catch (error) {
          const message = (error as Error).message;
          if (/buffer|size|length/i.test(message)) {
            throw new UpstreamFailure('UNSUPPORTED', `That archived record expands past ${MAX_INFLATED_BYTES} bytes.`);
          }
          throw new UpstreamFailure('BAD_RESPONSE', `That archived record is not readable gzip: ${message}`);
        }

        return { content: parseRecord(inflated, query.claim, CONTENT_HOST) };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerWebHistoryUpstreams(): void {
  registerUpstream(commoncrawl());
}
