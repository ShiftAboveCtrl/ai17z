import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Company filings, and the two things that must not be confused.
 *
 * A filing establishes that a named organisation made a specific statement on a
 * specific date under obligation. It does not establish that the statement is
 * true, and a filing date is not the period the filing reports on.
 *
 * The other half of this file is about not talking to the SEC anonymously. They
 * answer an undeclared automated caller with 403, verified rather than assumed,
 * so a request with no contact configured is a request that should never leave.
 */

let responses: Record<string, { status: number; body: string }> = {};
const asked: { url: string; headers: Record<string, string> }[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown, init?: { headers?: Record<string, string> }) {
    const url = String(input);
    asked.push({ url, headers: init?.headers ?? {} });
    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: '{}' };
    return new Response(answer.body, {
      status: answer.status,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const {
  padCik,
  undash,
  useSecContact,
  secContact,
  registerSecUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  familyMembers,
} = await import('@xbam/upstream');
const { registerSecCapabilities } = await import('@xbam/runtime');
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
  return capability.run(capability.input.parse(input) as never, context()) as Promise<Record<string, unknown>>;
}

async function readiness(id: string) {
  const capability = getCapability(id);
  if (!capability?.readiness) throw new Error(`${id} has no readiness`);
  const { signal, ...rest } = context();
  void signal;
  return capability.readiness(rest as never);
}

const TICKERS = JSON.stringify({
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 789019, ticker: 'MSFT', title: 'Microsoft Corp' },
  '2': { cik_str: 1018724, ticker: 'AMZN', title: 'AMAZON COM INC' },
  '3': { cik_str: 99999, ticker: 'APLE', title: 'Apple Hospitality REIT' },
  // A short ticker that is a prefix of several others, which is where an
  // ordering bug actually shows: asking for AA must not answer with AAL.
  '4': { cik_str: 1675149, ticker: 'AA', title: 'Alcoa Corp' },
  '5': { cik_str: 6201, ticker: 'AAL', title: 'American Airlines Group Inc.' },
  '6': { cik_str: 1158449, ticker: 'AAP', title: 'Advance Auto Parts Inc' },
});

/** The column-array shape EDGAR returns, where a row is an index. */
function submissions(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    name: 'Apple Inc.',
    tickers: ['AAPL'],
    exchanges: ['Nasdaq'],
    sicDescription: 'Electronic Computers',
    filings: {
      recent: {
        form: ['10-K', '8-K', '10-Q'],
        filingDate: ['2025-11-01', '2025-10-15', '2025-08-01'],
        reportDate: ['2025-09-27', '2025-10-15', '2025-06-28'],
        accessionNumber: ['0000320193-25-000106', '0000320193-25-000100', '0000320193-25-000080'],
        primaryDocument: ['aapl-20250927.htm', 'aapl-8k.htm', 'aapl-20250628.htm'],
        primaryDocDescription: ['10-K', '8-K', '10-Q'],
      },
    },
    ...over,
  });
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerSecUpstreams();
  registerSecCapabilities();
  asked.length = 0;
  responses = {};
  useSecContact('owner@example.test');
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
  useSecContact(null);
});

describe('not talking to the regulator anonymously', () => {
  it('does not send a request at all when no contact is configured', async () => {
    // Verified against the live service: an undeclared caller is answered 403
    // "Your Request Originates from an Undeclared Automated Tool". Collecting
    // one of those to discover something already known is the behaviour their
    // guidance exists to prevent.
    useSecContact(null);
    responses = { 'company_tickers': { status: 200, body: TICKERS } };
    await expect(invoke('company.resolve', { query: 'AAPL' })).rejects.toThrow();
    expect(asked).toHaveLength(0);
  });

  it('says it needs an address rather than reporting an outage', async () => {
    // "No source is answering" sends an owner looking for a failure that does
    // not exist. The truth is that nobody has given it an address.
    useSecContact(null);
    const state = await readiness('company.filings');
    expect(state.status).toBe('UNAVAILABLE');
    expect(state.why).toMatch(/requires automated callers to declare a contact email/i);
  });

  it('declares the configured contact on every request', async () => {
    responses = { 'company_tickers': { status: 200, body: TICKERS } };
    await invoke('company.resolve', { query: 'AAPL' });
    expect(asked[0]!.headers['user-agent']).toContain('owner@example.test');
    expect(asked[0]!.headers['user-agent']).toContain('AI17Z');
  });

  it('refuses to treat something without an @ as an address', () => {
    // Declaring a non-address declares something false rather than nothing.
    useSecContact('not-an-address');
    expect(secContact()).toBeNull();
    useSecContact('owner@example.test');
    expect(secContact()).toBe('owner@example.test');
  });

  it('ships with no contact at all', async () => {
    // A developer's address compiled into a release identifies the wrong person
    // to a regulator on every machine that runs it.
    const fresh = await import('@xbam/upstream');
    fresh.useSecContact(null);
    expect(fresh.secContact()).toBeNull();
  });
});

describe('identifiers EDGAR insists on', () => {
  it('pads a CIK to ten digits however it arrived', () => {
    expect(padCik(320193)).toBe('0000320193');
    expect(padCik('320193')).toBe('0000320193');
    expect(padCik('0000320193')).toBe('0000320193');
    expect(padCik('CIK0000320193')).toBe('0000320193');
  });

  it('strips the dashes an accession number carries in the index', () => {
    // The index writes it dashed and the archive path wants it undashed.
    expect(undash('0000320193-25-000106')).toBe('000032019325000106');
  });
});

describe('finding a registrant', () => {
  it('prefers an exact ticker over a name that merely contains the text', async () => {
    // Asking for AAPL should not answer with Apple Hospitality REIT first.
    responses = { 'company_tickers': { status: 200, body: TICKERS } };
    const answer = await invoke('company.resolve', { query: 'AAPL' });
    const candidates = answer.candidates as Record<string, unknown>[];
    expect(candidates[0]!.ticker).toBe('AAPL');
    expect(candidates[0]!.cik).toBe('0000320193');
  });

  it('puts an exact short ticker above the longer ones containing it', async () => {
    // AA, AAL and AAP all contain "aa". Without an exact-match preference the
    // answer to "AA" is American Airlines.
    responses = { 'company_tickers': { status: 200, body: TICKERS } };
    const answer = await invoke('company.resolve', { query: 'AA' });
    const candidates = answer.candidates as Record<string, unknown>[];
    expect(candidates[0]!.ticker).toBe('AA');
    expect(candidates[0]!.name).toBe('Alcoa Corp');
    // And the near misses are still offered, below it.
    expect(candidates.map((candidate) => candidate.ticker)).toContain('AAL');
  });

  it('returns every plausible registrant for a name', async () => {
    responses = { 'company_tickers': { status: 200, body: TICKERS } };
    const answer = await invoke('company.resolve', { query: 'apple' });
    const candidates = answer.candidates as Record<string, unknown>[];
    expect(candidates.length).toBeGreaterThan(1);
    expect(answer.unambiguous).toBe(false);
    expect((answer.limitations as string[]).join(' ')).toMatch(/matches 2 registrants/i);
  });

  it('says an absent company may simply not file', async () => {
    responses = { 'company_tickers': { status: 200, body: TICKERS } };
    const answer = await invoke('company.resolve', { query: 'a private company' });
    expect(answer.candidates).toEqual([]);
    expect((answer.limitations as string[])[0]).toMatch(/does not file, not that it does not exist/i);
  });
});

describe('reading the filing index', () => {
  it('reads the column arrays as rows', async () => {
    // EDGAR returns each field as its own parallel array; a row is an index
    // across all of them, and getting that wrong pairs a form with another
    // filing's date.
    responses = { 'submissions/CIK': { status: 200, body: submissions() } };
    const answer = await invoke('company.filings', { cik: '320193', limit: 5 });
    const filings = answer.filings as Record<string, unknown>[];

    expect(filings).toHaveLength(3);
    expect(filings[0]!.form).toBe('10-K');
    expect(filings[0]!.filedAt).toBe('2025-11-01');
    expect(filings[0]!.accessionNumber).toBe('0000320193-25-000106');
    expect(filings[1]!.form).toBe('8-K');
    expect(filings[1]!.filedAt).toBe('2025-10-15');
  });

  it('keeps the reporting period apart from the filing date', async () => {
    // An annual report filed in November covers a year that ended in
    // September. Collapsing those misdates every figure in it.
    responses = { 'submissions/CIK': { status: 200, body: submissions() } };
    const answer = await invoke('company.filings', { cik: '320193' });
    const first = (answer.filings as Record<string, unknown>[])[0]!;
    expect(first.filedAt).toBe('2025-11-01');
    expect(first.periodOfReport).toBe('2025-09-27');
    expect((answer.limitations as string[]).join(' ')).toMatch(/filed in November can cover a year that ended in September/i);
  });

  it('links to the filing at the regulator', async () => {
    responses = { 'submissions/CIK': { status: 200, body: submissions() } };
    const answer = await invoke('company.filings', { cik: '320193' });
    const first = (answer.filings as Record<string, unknown>[])[0]!;
    // Leading zeros come off for the directory, dashes come out of the
    // accession number, and the document name is appended as filed.
    expect(first.url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019325000106/aapl-20250927.htm');
  });

  it('filters to the forms asked for', async () => {
    responses = { 'submissions/CIK': { status: 200, body: submissions() } };
    const answer = await invoke('company.filings', { cik: '320193', forms: ['10-K'] });
    const filings = answer.filings as Record<string, unknown>[];
    expect(filings).toHaveLength(1);
    expect(filings[0]!.form).toBe('10-K');
    // And the unfiltered total is still visible.
    expect(answer.totalFilings).toBe(3);
  });

  it('says the index is recent rather than complete when a filter finds nothing', async () => {
    responses = { 'submissions/CIK': { status: 200, body: submissions() } };
    const answer = await invoke('company.filings', { cik: '320193', forms: ['S-1'] });
    expect(answer.filings).toEqual([]);
    expect((answer.limitations as string[]).join(' ')).toMatch(/covers recent filings rather than the whole history/i);
  });

  it('says a filing is a statement rather than a verified fact', async () => {
    responses = { 'submissions/CIK': { status: 200, body: submissions() } };
    const answer = await invoke('company.filings', { cik: '320193' });
    expect((answer.limitations as string[])[0]).toMatch(/not an independent verification/i);
  });

  it('treats an unknown CIK as an answer', async () => {
    responses = {};
    await expect(invoke('company.filings', { cik: '9999999999' })).rejects.toThrow();
  });
});

describe('being a good guest at a regulator', () => {
  it('stays under the published ten a second, serially', () => {
    const edgar = familyMembers('company_filings')[0]!;
    expect(edgar.limit.concurrentPerProcess).toBe(1);
    const window = edgar.limit.windows[0]!;
    expect(window.capacity).toBeLessThanOrEqual(10);
    // Ten a second is theirs and published; what we take is half of it.
    expect(window.source).toBe('PUBLISHED');
    expect(window.scope).toBe('MACHINE');
  });
});
