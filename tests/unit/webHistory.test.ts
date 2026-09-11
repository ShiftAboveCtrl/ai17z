import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The past, and the ways reporting it could lie.
 *
 *   not captured            is not   the page did not exist
 *   a capture from 2024     is not   the page today
 *   the archive failed      is not   there is no history
 *   an archived 404         is not   no capture
 *   an archived redirect    is not   a redirect today
 *
 * Each is a separate answer, and collapsing any pair produces a confident
 * falsehood about somebody's project. The third bites hardest: an unreachable
 * archive is an absence of evidence, and reporting it as "this page has no
 * history" turns a network problem into a finding.
 *
 * And underneath all of that, one more: an index entry is a pointer, and a
 * pointer can be honoured perfectly by bytes that are some other page entirely.
 * So the record has to prove it is the record that was asked for.
 */

let responses: Record<
  string,
  {
    status: number;
    body?: string;
    bytes?: Uint8Array;
    /** Forces a bogus Content-Range, to prove the range is actually checked. */
    contentRange?: string;
    /** Answers 200 with the whole file, as a server that ignores Range does. */
    ignoreRange?: boolean;
  }
> = {};
const asked: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown, init?: { headers?: Record<string, string> }) {
    const url = String(input);
    asked.push(url);
    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: '{}' };
    const body: BodyInit = answer.bytes ? (answer.bytes as unknown as BodyInit) : (answer.body ?? '');
    const headers = new Headers({ 'content-type': 'application/json' });

    // A range request is answered 206 with a Content-Range naming exactly the
    // bytes sent, which is what the real archive does and what the family
    // insists on before it will parse anything.
    const range = init?.headers?.range;
    let status = answer.status;
    if (range && answer.status === 200 && !answer.ignoreRange) {
      status = 206;
      const wanted = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(wanted?.[1] ?? 0);
      const end = Number(wanted?.[2] ?? 0);
      if (answer.contentRange !== undefined) {
        if (answer.contentRange !== '') headers.set('content-range', answer.contentRange);
      } else {
        headers.set('content-range', `bytes ${start}-${end}/905915622`);
      }
    }
    return new Response(body, { status, headers });
  },
}));

const {
  base32,
  registerWebHistoryUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  healthOf,
} = await import('@xbam/upstream');
const { registerWebHistoryCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

function context() {
  return {
    agentId: 'agent-1',
    jobId: null,
    accountId: null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => context().logger } as never,
    signal: new AbortController().signal,
  };
}

async function invoke(id: string, input: unknown) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`${id} is not registered`);
  return capability.run(capability.input.parse(input) as never, context());
}

const CRAWLS = JSON.stringify([
  { id: 'CC-MAIN-2026-34', name: 'August 2026 Index', from: '2026-08-07T10:18:45', to: '2026-08-20T01:52:41' },
  { id: 'CC-MAIN-2026-30', name: 'July 2026 Index', from: '2026-07-10T07:05:34', to: '2026-07-23T01:13:28' },
  { id: 'CC-MAIN-2026-25', name: 'June 2026 Index', from: '2026-06-10T07:05:34', to: '2026-06-23T01:13:28' },
]);

const FILE = 'crawl-data/CC-MAIN-2026-34/segments/1/warc/CC-MAIN-00162.warc.gz';
const OFFSET = 177253384;
const DEFAULT_BODY = '<html><body>Tokenomics: 1,000,000 total supply.</body></html>';

/** One CDX line, in the shape the live index returns. */
function cdxLine(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    urlkey: 'com,example)/',
    timestamp: '20260807104456',
    url: 'https://example.com/',
    mime: 'text/html',
    status: '200',
    digest: 'KFMR3RACAHZZH2HGKDPO3FQODMO3XIJ7',
    length: '953',
    offset: String(OFFSET),
    filename: FILE,
    ...over,
  });
}

/**
 * RFC 4648 base32, written out here rather than imported.
 *
 * Deliberately a second implementation: a test that borrowed the family's
 * encoder would confirm whatever that encoder did, including being wrong.
 */
function base32Locally(bytes: Uint8Array): string {
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

/** The digest Common Crawl publishes for a body, computed independently. */
function digestOf(body: string): string {
  return base32Locally(createHash('sha1').update(Buffer.from(body, 'utf8')).digest());
}

interface RecordOptions {
  status?: number;
  body?: string;
  target?: string;
  date?: string;
  digest?: string | null;
  truncated?: string;
  location?: string;
  omitContentLength?: boolean;
}

/**
 * A gzipped WARC record, exactly as a byte-range fetch returns one.
 *
 * The digest is computed rather than written in, because these tests are about
 * the verification path: a hardcoded digest would make every record fail
 * verification and the passing cases would prove nothing.
 */
function warcRecord(options: RecordOptions = {}): Buffer {
  const body = options.body ?? DEFAULT_BODY;
  const payload = Buffer.from(body, 'utf8');
  const digest = options.digest === undefined ? digestOf(body) : options.digest;

  const warcLines = [
    'WARC/1.0',
    'WARC-Type: response',
    `WARC-Date: ${options.date ?? '2026-08-07T10:44:56Z'}`,
    `WARC-Target-URI: ${options.target ?? 'https://example.com/'}`,
  ];
  if (digest) warcLines.push(`WARC-Payload-Digest: sha1:${digest}`);
  if (options.truncated) warcLines.push(`WARC-Truncated: ${options.truncated}`);

  const httpLines = [`HTTP/1.1 ${options.status ?? 200} `, 'content-type: text/html'];
  if (options.location) httpLines.push(`location: ${options.location}`);
  if (!options.omitContentLength) httpLines.push(`Content-Length: ${payload.length}`);

  // The record ends with the terminator the archive writes, which is exactly
  // what must be excluded from the payload.
  const record = `${warcLines.join('\r\n')}\r\n\r\n${httpLines.join('\r\n')}\r\n\r\n${body}\r\n\r\n`;
  return gzipSync(Buffer.from(record, 'utf8'));
}

interface ClaimOverrides {
  filename?: string;
  offset?: number;
  length?: number;
  url?: string | null;
  timestamp?: string | null;
  digest?: string | null;
  status?: string | null;
  truncated?: string | null;
}

/**
 * A capture reference carrying what the index claimed.
 *
 * The claims are the point: a pointer alone can be honoured perfectly by a
 * record of some completely different page.
 */
function refFor(over: ClaimOverrides = {}): string {
  const packed = {
    f: over.filename ?? FILE,
    o: over.offset ?? OFFSET,
    l: over.length ?? 953,
    u: over.url === undefined ? 'https://example.com/' : over.url,
    t: over.timestamp === undefined ? '20260807104456' : over.timestamp,
    d: over.digest === undefined ? digestOf(DEFAULT_BODY) : over.digest,
    s: over.status === undefined ? '200' : over.status,
    x: over.truncated ?? null,
  };
  return Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
}

/**
 * Serves one record and returns a ref that agrees with it about length.
 *
 * They have to agree, because the family refuses a response whose size differs
 * from what the index published -- the check that stops a server quietly
 * sending something other than the record asked for.
 */
function serve(
  record: RecordOptions = {},
  claim: ClaimOverrides = {},
  response: { contentRange?: string; ignoreRange?: boolean } = {},
): string {
  const bytes = warcRecord(record);
  responses = { 'data.commoncrawl.org': { status: 200, bytes, ...response } };
  return refFor({
    length: bytes.byteLength,
    digest: record.digest === undefined ? digestOf(record.body ?? DEFAULT_BODY) : record.digest,
    ...claim,
  });
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerWebHistoryUpstreams();
  registerWebHistoryCapabilities();
  asked.length = 0;
  responses = {};
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('finding what was captured', () => {
  it('reports captures with the date each was taken', async () => {
    responses = {
      'collinfo.json': { status: 200, body: CRAWLS },
      '-index': { status: 200, body: cdxLine() },
    };
    const answer = (await invoke('web.history', { url: 'https://example.com/', crawls: 1 })) as {
      captures: { capturedAt: string; archivedStatus: string; ref: string; readable: boolean }[];
      earliest: string | null;
      crawlsSearched: string[];
    };

    expect(answer.captures).toHaveLength(1);
    // The timestamp is turned into something comparable rather than left as
    // fourteen digits nothing parses.
    expect(answer.captures[0]!.capturedAt).toBe('2026-08-07T10:44:56.000Z');
    expect(answer.captures[0]!.readable).toBe(true);
    expect(answer.earliest).toBe('2026-08-07T10:44:56.000Z');
    expect(answer.crawlsSearched).toEqual(['CC-MAIN-2026-34']);
  });

  it('treats no captures as an answer, not as the page never existing', async () => {
    // Live, the index answers 404 with {"message": "No Captures found for: ..."}
    // That is this crawl holding nothing, which is not the same claim.
    responses = { 'collinfo.json': { status: 200, body: CRAWLS } };
    const answer = (await invoke('web.history', { url: 'https://example.com/nothing', crawls: 1 })) as {
      captures: unknown[];
      crawlsSearched: string[];
      crawlsNotSearched: { crawl: string; why: string }[];
      limitations: string[];
    };

    expect(answer.captures).toEqual([]);
    expect(answer.crawlsSearched).toEqual(['CC-MAIN-2026-34']);
    expect(answer.crawlsNotSearched).toEqual([]);
    expect(answer.limitations.join(' ')).toMatch(/No capture is not evidence that the page did not exist/i);
  });

  it('does not let a 404 from the index cool off a working archive', async () => {
    responses = { 'collinfo.json': { status: 200, body: CRAWLS } };
    await invoke('web.history', { url: 'https://example.com/nothing', crawls: 1 });
    expect(healthOf('web_history.commoncrawl').failures).toBe(0);
  });

  it('separates a crawl that held nothing from a crawl it could not search', async () => {
    // An archive that failed is an absence of evidence; reporting it as "no
    // history" invents a finding about a site.
    responses = {
      'collinfo.json': { status: 200, body: CRAWLS },
      'CC-MAIN-2026-34-index': { status: 500, body: 'upstream is unwell' },
      'CC-MAIN-2026-30-index': { status: 200, body: cdxLine({ timestamp: '20260710120000' }) },
    };
    const answer = (await invoke('web.history', { url: 'https://example.com/', crawls: 2 })) as {
      captures: unknown[];
      crawlsSearched: string[];
      crawlsNotSearched: { crawl: string; why: string }[];
      limitations: string[];
    };

    expect(answer.crawlsNotSearched.map((entry) => entry.crawl)).toEqual(['CC-MAIN-2026-34']);
    expect(answer.crawlsNotSearched[0]!.why).toMatch(/could not be searched/i);
    expect(answer.crawlsSearched).toEqual(['CC-MAIN-2026-30']);
    expect(answer.captures).toHaveLength(1);
    // The incompleteness leads the answer rather than hiding at the end.
    expect(answer.limitations[0]).toMatch(/incomplete view/i);
    expect(answer.limitations[0]).toMatch(/CC-MAIN-2026-34/);
  });

  it('keeps an archived redirect as a fact about then', async () => {
    responses = {
      'collinfo.json': { status: 200, body: CRAWLS },
      '-index': {
        status: 200,
        body: cdxLine({ status: '301', redirect: 'https://example.com/moved', mime: 'text/html' }),
      },
    };
    const answer = (await invoke('web.history', { url: 'https://example.com/', crawls: 1 })) as {
      captures: { archivedStatus: string; archivedRedirect: string | null }[];
      limitations: string[];
    };
    expect(answer.captures[0]!.archivedStatus).toBe('301');
    expect(answer.captures[0]!.archivedRedirect).toBe('https://example.com/moved');
    expect(answer.limitations.join(' ')).toMatch(/has not been followed/i);
  });

  it('says every answer is historical, even a full one', async () => {
    responses = {
      'collinfo.json': { status: 200, body: CRAWLS },
      '-index': { status: 200, body: cdxLine() },
    };
    const answer = (await invoke('web.history', { url: 'https://example.com/', crawls: 1 })) as {
      limitations: string[];
    };
    expect(answer.limitations.join(' ')).toMatch(/not the page now/i);
  });

  it('searches no more crawls than it was asked for', async () => {
    // Every crawl is another request to an endpoint that asks for a sleep
    // between calls, and a day-long block is the penalty for sweeping it.
    responses = {
      'collinfo.json': { status: 200, body: CRAWLS },
      '-index': { status: 200, body: cdxLine() },
    };
    await invoke('web.history', { url: 'https://example.com/', crawls: 2 });
    expect(asked.filter((url) => url.includes('-index'))).toHaveLength(2);
  });

  it('refuses something that is not a URL', async () => {
    await expect(invoke('web.history', { url: 'what did the site say' })).rejects.toThrow();
  });
});

describe('reading an archived page', () => {
  it('returns the content stamped with when it was captured', async () => {
    const ref = serve();
    const answer = (await invoke('web.history_capture', { ref })) as {
      url: string | null;
      asOf: string | null;
      archivedStatus: number | null;
      content: string;
      limitations: string[];
    };

    expect(answer.url).toBe('https://example.com/');
    expect(answer.asOf).toBe('2026-08-07T10:44:56Z');
    expect(answer.archivedStatus).toBe(200);
    expect(answer.content).toMatch(/1,000,000 total supply/);
    // The date travels with the content, so it cannot be quoted as current.
    expect(answer.limitations[0]).toMatch(/as of 2026-08-07T10:44:56Z/);
    expect(answer.limitations[0]).toMatch(/not the page now/i);
  });

  it('asks for exactly the bytes of one record', async () => {
    const ref = serve();
    await invoke('web.history_capture', { ref });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('CC-MAIN-00162.warc.gz');
  });

  it('keeps an archived error as a capture of a real moment', async () => {
    // An archived 404 is a successful capture of a page that was erroring. It
    // is not the same as the URL having no captures at all.
    const ref = serve({ status: 404, body: 'Not Found' }, { status: '404' });
    const answer = (await invoke('web.history_capture', { ref })) as {
      archivedStatus: number | null;
      limitations: string[];
    };
    expect(answer.archivedStatus).toBe(404);
    expect(answer.limitations.join(' ')).toMatch(/fact about then, not an absence of history/i);
  });

  it('refuses a record that expands past the inflated cap', async () => {
    // The fetch cap cannot catch this: the gzip is the archive file's own, so
    // it arrives with no content-encoding and has already satisfied maxBytes at
    // its compressed size. A few kilobytes can become many megabytes.
    const bomb = gzipSync(Buffer.alloc(8_000_000, 0x41));
    responses = { 'data.commoncrawl.org': { status: 200, bytes: bomb } };
    await expect(invoke('web.history_capture', { ref: refFor({ length: bomb.byteLength }) })).rejects.toThrow(
      /expands past/i,
    );
  });

  it('refuses a capture larger than it will fetch, before fetching it', async () => {
    serve();
    await expect(invoke('web.history_capture', { ref: refFor({ length: 50_000_000 }) })).rejects.toThrow(/past the/i);
    // And it did not ask for it.
    expect(asked).toHaveLength(0);
  });

  it('refuses a ref it did not issue', async () => {
    await expect(invoke('web.history_capture', { ref: 'not-a-ref' })).rejects.toThrow(/capture reference/i);
  });

  it('refuses gzip that is not gzip', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    responses = { 'data.commoncrawl.org': { status: 200, bytes: junk } };
    await expect(invoke('web.history_capture', { ref: refFor({ length: junk.byteLength }) })).rejects.toThrow(
      /not readable gzip/i,
    );
  });
});

describe('the record has to prove it is the record that was asked for', () => {
  it('accepts a correct range and verifies the payload against the published digest', async () => {
    const ref = serve();
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: {
        payload: string;
        completeness: string;
        matchesIndex: { url: string; capturedAt: string; digest: string; status: string };
      };
      limitations: string[];
    };

    // Established by probe, not assumed: the payload is exactly Content-Length
    // bytes and excludes the record terminator.
    expect(answer.integrity.payload).toBe('VERIFIED');
    expect(answer.integrity.matchesIndex).toEqual({
      url: 'MATCHED',
      capturedAt: 'MATCHED',
      digest: 'MATCHED',
      status: 'MATCHED',
    });
    expect(answer.integrity.completeness).toBe('COMPLETE');
    // A verified, complete capture carries no doubt-raising caveat.
    expect(answer.limitations.join(' ')).not.toMatch(/not cryptographically confirmed/i);
  });

  it('rejects a 200 rather than parsing the head of a multi-gigabyte file', async () => {
    // A server that ignores Range sends the start of a 905 MB file, and those
    // first bytes parse perfectly well as some other record. Nothing about that
    // looks like a failure, which is exactly why it is checked.
    const ref = serve({}, {}, { ignoreRange: true });
    await expect(invoke('web.history_capture', { ref })).rejects.toThrow(/rather than 206/i);
  });

  it('rejects a range that starts somewhere else', async () => {
    // The end is deliberately correct. With a wrong end too, the end check
    // would catch this and the start check would never be exercised -- which
    // is exactly what the first version of this test did.
    const bytes = warcRecord();
    const end = OFFSET + bytes.byteLength - 1;
    responses = {
      'data.commoncrawl.org': { status: 200, bytes, contentRange: `bytes 999-${end}/905915622` },
    };
    await expect(
      invoke('web.history_capture', { ref: refFor({ length: bytes.byteLength }) }),
    ).rejects.toThrow(/not the indexed bytes/i);
  });

  it('rejects a range that ends somewhere else', async () => {
    // Start correct, end wrong -- the mirror of the case above.
    const ref = serve({}, {}, { contentRange: `bytes ${OFFSET}-177253999/905915622` });
    await expect(invoke('web.history_capture', { ref })).rejects.toThrow(/not the indexed bytes/i);
  });

  it('rejects a 206 with no Content-Range at all', async () => {
    const ref = serve({}, {}, { contentRange: '' });
    await expect(invoke('web.history_capture', { ref })).rejects.toThrow(/without saying which bytes/i);
  });

  it('rejects an unreadable Content-Range', async () => {
    const ref = serve({}, {}, { contentRange: 'pages 1-2/3' });
    await expect(invoke('web.history_capture', { ref })).rejects.toThrow(/unreadable Content-Range/i);
  });

  it('rejects a response shorter than the index said', async () => {
    const bytes = warcRecord();
    responses = { 'data.commoncrawl.org': { status: 200, bytes } };
    await expect(invoke('web.history_capture', { ref: refFor({ length: bytes.byteLength + 50 }) })).rejects.toThrow(
      /where the index said/i,
    );
  });

  it('rejects a response longer than the index said', async () => {
    const bytes = warcRecord();
    responses = { 'data.commoncrawl.org': { status: 200, bytes } };
    await expect(invoke('web.history_capture', { ref: refFor({ length: bytes.byteLength - 10 }) })).rejects.toThrow(
      /where the index said/i,
    );
  });
});

describe('what the record says about itself, against what the index claimed', () => {
  it('reports a record of a completely different page as a mismatch', async () => {
    // The failure this exists for: a pointer honoured by bytes that are some
    // other page entirely. It must never quietly become the page asked about.
    const ref = serve({ target: 'https://elsewhere.example/x' });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { matchesIndex: { url: string }; notes: string[] };
      limitations: string[];
    };
    expect(answer.integrity.matchesIndex.url).toBe('MISMATCH');
    expect(answer.integrity.notes.join(' ')).toMatch(/elsewhere\.example/);
    expect(answer.limitations[0]).toMatch(/disagrees with the index/i);
  });

  it('does not call a scheme or trailing-slash difference a mismatch, but says so', async () => {
    // Over-normalising would invent equality; flagging this would cry wolf on
    // every capture. Both forms are preserved in the note either way.
    const ref = serve({ target: 'http://example.com' });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { matchesIndex: { url: string }; notes: string[] };
    };
    expect(answer.integrity.matchesIndex.url).toBe('MATCHED');
    expect(answer.integrity.notes.join(' ')).toMatch(/differ only in scheme or trailing slash/i);
  });

  it('reports a digest the record does not agree with', async () => {
    const ref = serve({ digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, { digest: digestOf(DEFAULT_BODY) });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { matchesIndex: { digest: string } };
    };
    expect(answer.integrity.matchesIndex.digest).toBe('MISMATCH');
  });

  it('reports bytes that do not hash to the published digest', async () => {
    // The record and the index agree with each other and both are wrong about
    // the bytes. Only hashing catches this.
    const wrong = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ref = serve({ digest: wrong }, { digest: wrong });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { payload: string; payloadDetail: string; matchesIndex: { digest: string } };
      limitations: string[];
    };
    expect(answer.integrity.matchesIndex.digest).toBe('MATCHED');
    expect(answer.integrity.payload).toBe('MISMATCH');
    expect(answer.integrity.payloadDetail).toMatch(/not the indexed bytes/i);
    expect(answer.limitations.join(' ')).toMatch(/not cryptographically confirmed/i);
  });

  it('says NOT_AVAILABLE rather than inventing a disagreement when nothing published a digest', async () => {
    // A field the index did not carry has not disagreed with anything.
    const ref = serve({ digest: null }, { digest: null });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { payload: string; matchesIndex: { digest: string } };
    };
    expect(answer.integrity.matchesIndex.digest).toBe('NOT_AVAILABLE');
    expect(answer.integrity.payload).toBe('NOT_AVAILABLE');
  });

  it('falls back to the record terminator when there is no Content-Length', async () => {
    // Correct uncertainty beats a guess dressed as a guarantee, and here the
    // terminator does bound the payload, so it verifies.
    const ref = serve({ omitContentLength: true });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { payload: string };
    };
    expect(answer.integrity.payload).toBe('VERIFIED');
  });

  it('reports a capture time the record disagrees with', async () => {
    const ref = serve({ date: '2020-01-01T00:00:00Z' });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { matchesIndex: { capturedAt: string } };
    };
    expect(answer.integrity.matchesIndex.capturedAt).toBe('MISMATCH');
  });
});

describe('completeness, said rather than assumed', () => {
  it('reports a crawler-truncated capture as TRUNCATED', async () => {
    const ref = serve({ truncated: 'length' });
    const answer = (await invoke('web.history_capture', { ref })) as {
      integrity: { completeness: string };
      limitations: string[];
    };
    expect(answer.integrity.completeness).toBe('TRUNCATED');
    expect(answer.limitations.join(' ')).toMatch(/longer than what was stored/i);
  });

  it('reports UNKNOWN rather than COMPLETE when the bytes could not be verified', async () => {
    // "A body came back" must never be read as "this is the whole page".
    const wrong = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ref = serve({ digest: wrong }, { digest: wrong });
    const answer = (await invoke('web.history_capture', { ref })) as { integrity: { completeness: string } };
    expect(answer.integrity.completeness).toBe('UNKNOWN');
  });

  it('distinguishes our own clipping from the crawler truncating', async () => {
    const long = 'x'.repeat(150_000);
    const ref = serve({ body: long });
    const answer = (await invoke('web.history_capture', { ref })) as {
      clipped: boolean;
      integrity: { completeness: string };
    };
    // We clipped it for the prompt; the crawler did not truncate it. Two
    // different facts that must not share a word.
    expect(answer.clipped).toBe(true);
    expect(answer.integrity.completeness).toBe('COMPLETE');
  });
});

describe('an archived redirect', () => {
  it('is reported with where it pointed, and is not followed', async () => {
    const ref = serve({ status: 301, location: 'https://example.com/moved', body: '' }, { status: '301' });
    const answer = (await invoke('web.history_capture', { ref })) as {
      archivedStatus: number | null;
      archivedRedirect: string | null;
      limitations: string[];
    };
    expect(answer.archivedStatus).toBe(301);
    expect(answer.archivedRedirect).toBe('https://example.com/moved');
    expect(answer.limitations.join(' ')).toMatch(/has not been followed/i);
    // And nothing was fetched from the destination.
    expect(asked.filter((url) => url.includes('moved'))).toHaveLength(0);
  });
});

describe('provenance keeps the two hosts apart', () => {
  it('names the index host and the content host separately', async () => {
    const ref = serve();
    const answer = (await invoke('web.history_capture', { ref })) as {
      indexSource: string;
      contentSource: string;
      provenance: { host: string };
    };
    expect(answer.indexSource).toBe('index.commoncrawl.org');
    expect(answer.contentSource).toBe('data.commoncrawl.org');
    expect(answer.provenance.host).toBe('data.commoncrawl.org');
  });
});

describe('the base32 the digest depends on', () => {
  /**
   * Pinned against RFC 4648's own vectors rather than against itself.
   *
   * A SHA-1 is exactly thirty-two five-bit groups, so the trailing-partial-group
   * path never runs for a real digest -- meaning a bug in it would sit there
   * unexercised until some other caller hit it. These vectors do exercise it.
   */
  it('matches RFC 4648 for every alignment', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [input, expected] of vectors) {
      expect(base32(new TextEncoder().encode(input))).toBe(expected);
    }
  });

  it('agrees with the independent implementation these tests use', () => {
    // Two implementations that disagree would mean every digest assertion here
    // was proving nothing.
    for (const sample of ['', 'a', 'abc', 'the quick brown fox', ' ÿþ']) {
      const bytes = new TextEncoder().encode(sample);
      expect(base32(bytes)).toBe(base32Locally(bytes));
    }
  });
});

describe('the two capabilities compose', () => {
  it('carries the index claims through the ref it issued, so the record can be checked', async () => {
    // A model does exactly this: find captures, take a ref, read one. If the
    // ref drops what the index claimed, every check silently degrades to
    // NOT_AVAILABLE and the verification is theatre. Nothing else in this file
    // exercises the real encoder, because the other tests build refs
    // themselves -- so this is the only thing standing between the two halves.
    const bytes = warcRecord();
    responses = {
      'collinfo.json': { status: 200, body: CRAWLS },
      '-index': { status: 200, body: cdxLine({ length: String(bytes.byteLength), digest: digestOf(DEFAULT_BODY) }) },
      'data.commoncrawl.org': { status: 200, bytes },
    };

    const found = (await invoke('web.history', { url: 'https://example.com/', crawls: 1 })) as {
      captures: { ref: string }[];
    };
    expect(found.captures).toHaveLength(1);

    const page = (await invoke('web.history_capture', { ref: found.captures[0]!.ref })) as {
      integrity: { payload: string; matchesIndex: { url: string; capturedAt: string; digest: string; status: string } };
    };

    expect(page.integrity.matchesIndex).toEqual({
      url: 'MATCHED',
      capturedAt: 'MATCHED',
      digest: 'MATCHED',
      status: 'MATCHED',
    });
    expect(page.integrity.payload).toBe('VERIFIED');
  });
});
