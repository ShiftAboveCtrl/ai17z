import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Scholarly literature, and the six readings that would be wrong.
 *
 *   a paper exists           is not  its claim is true
 *   a preprint               is not  a peer-reviewed article
 *   published                is not  replicated
 *   highly cited             is not  correct
 *   the abstract says X      is not  the paper proves X
 *   no retraction on record  is not  validated
 *
 * The last is the one a clean-looking answer produces by accident, because an
 * absence of data looks exactly like good news.
 */

let responses: Record<string, { status: number; body?: string }> = {};
const asked: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    asked.push(url);
    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: '{}' };
    return new Response(answer.body ?? '', {
      status: answer.status,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const {
  canonicalDoi,
  parseArxivId,
  registerScholarUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
  healthOf,
  familyMembers,
} = await import('@xbam/upstream');
const { registerScholarCapabilities, sameWork } = await import('@xbam/runtime');
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
  return capability.run(capability.input.parse(input) as never, context()) as Promise<Record<string, never>>;
}

/** A Crossref single-record response. */
function crossrefWork(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    message: {
      DOI: '10.1016/j.physletb.2012.08.020',
      type: 'journal-article',
      title: ['Observation of a new particle'],
      'container-title': ['Physics Letters B'],
      publisher: 'Elsevier BV',
      issued: { 'date-parts': [[2012, 9]] },
      author: [{ given: 'Ada', family: 'Lovelace', ORCID: 'https://orcid.org/0000-0002-1825-0097' }],
      'is-referenced-by-count': 6819,
      subject: ['Nuclear and High Energy Physics'],
      ...over,
    },
  });
}

/** An arXiv Atom entry. */
function arxivFeed(over: { id?: string; doi?: string; journalRef?: string; title?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/${over.id ?? '1207.7214v2'}</id>
    <title>${over.title ?? 'Observation of a new particle'}</title>
    <summary>We report the observation of a new particle.</summary>
    <published>2012-07-31T11:59:59Z</published>
    <updated>2012-08-31T19:29:54Z</updated>
    <author><name>ATLAS Collaboration</name></author>
    <category term="hep-ex"/>
    ${over.doi === undefined ? '<arxiv:doi>10.1016/j.physletb.2012.08.020</arxiv:doi>' : over.doi ? `<arxiv:doi>${over.doi}</arxiv:doi>` : ''}
    ${over.journalRef ? `<arxiv:journal_ref>${over.journalRef}</arxiv:journal_ref>` : ''}
  </entry>
</feed>`;
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerScholarUpstreams();
  registerScholarCapabilities();
  asked.length = 0;
  responses = {};
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('a DOI is one identifier however it was written', () => {
  it('normalises every usual form to the same thing', () => {
    const forms = [
      '10.1016/J.PhysletB.2012.08.020',
      'https://doi.org/10.1016/j.physletb.2012.08.020',
      'http://dx.doi.org/10.1016/j.physletb.2012.08.020',
      'doi:10.1016/j.physletb.2012.08.020',
      '  10.1016/j.physletb.2012.08.020  ',
    ];
    // Four papers rather than one is what comparing these as strings produces.
    const canonical = forms.map((form) => canonicalDoi(form));
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('10.1016/j.physletb.2012.08.020');
  });

  it('refuses something that is not a DOI, without asking anybody', () => {
    expect(canonicalDoi('not a doi')).toBeNull();
    expect(canonicalDoi('11.1234/x')).toBeNull();
    expect(canonicalDoi('10.abc/x')).toBeNull();
    expect(canonicalDoi('10.1234')).toBeNull();
  });

  it('spends no request on an identifier that cannot be one', async () => {
    const answer = await invoke('research.paper_lookup', { identifier: 'the one about transformers' });
    expect(answer.resolvedAs).toBe('UNRECOGNISED');
    // Asking two services to confirm a non-identifier spends their budget to
    // learn nothing.
    expect(asked).toHaveLength(0);
  });
});

describe('an arXiv id keeps its version without being defined by it', () => {
  it('separates the work from the version that was read', () => {
    expect(parseArxivId('2401.12345v3')).toEqual({ id: '2401.12345', version: 3 });
    expect(parseArxivId('2401.12345')).toEqual({ id: '2401.12345', version: null });
    expect(parseArxivId('arXiv:2401.12345v1')).toEqual({ id: '2401.12345', version: 1 });
    expect(parseArxivId('https://arxiv.org/abs/2401.12345v2')).toEqual({ id: '2401.12345', version: 2 });
  });

  it('treats v1 and v3 as one work', () => {
    // They are the same paper. A later version may say something materially
    // different, which is why the version survives -- but not as identity.
    expect(parseArxivId('2401.12345v1')!.id).toBe(parseArxivId('2401.12345v3')!.id);
    expect(parseArxivId('2401.12345v1')!.version).not.toBe(parseArxivId('2401.12345v3')!.version);
  });

  it('reads the pre-2007 identifier scheme too', () => {
    expect(parseArxivId('hep-ex/0123456')).toEqual({ id: 'hep-ex/0123456', version: null });
  });

  it('reports the version it actually read', async () => {
    responses = { 'export.arxiv.org': { status: 200, body: arxivFeed({ id: '1207.7214v2' }) } };
    const answer = await invoke('research.paper_lookup', { identifier: '1207.7214' });
    const record = (answer.records as unknown as Record<string, unknown>[])[0]!;
    expect(record.arxivId).toBe('1207.7214');
    expect(record.arxivVersion).toBe(2);
  });
});

describe('a preprint is not a peer-reviewed article', () => {
  it('never labels an arXiv record as published, even with a journal reference', async () => {
    // A journal reference means it was also published elsewhere. It does not
    // turn this record into the peer-reviewed article.
    responses = {
      'export.arxiv.org': { status: 200, body: arxivFeed({ journalRef: 'Phys.Lett. B716 (2012) 1-29' }) },
      'api.crossref.org': { status: 200, body: crossrefWork() },
    };
    const answer = await invoke('research.paper_lookup', { identifier: '1207.7214' });
    const records = answer.records as unknown as Record<string, unknown>[];
    const preprint = records.find((record) => record.source === 'arxiv')!;
    expect(preprint.kind).toBe('PREPRINT');
    expect(preprint.journalReference).toMatch(/Phys.Lett/);
    expect((answer.limitations as unknown as string[]).join(' ')).toMatch(/has not been through peer review/i);
  });

  it('keeps Crossref posted-content as a preprint rather than an article', async () => {
    responses = { 'api.crossref.org': { status: 200, body: crossrefWork({ type: 'posted-content' }) } };
    const answer = await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' });
    expect((answer.records as unknown as Record<string, unknown>[])[0]!.kind).toBe('PREPRINT');
  });
});

describe('integrity, and the difference between no record and a clean record', () => {
  it('surfaces a retraction with who recorded it', async () => {
    responses = {
      'api.crossref.org': {
        status: 200,
        body: crossrefWork({
          'updated-by': [
            {
              DOI: '10.1016/s0140-6736(10)60175-4',
              type: 'retraction',
              label: 'Retraction',
              source: 'retraction-watch',
              updated: { 'date-parts': [[2010, 2, 6]] },
            },
          ],
        }),
      },
    };
    const answer = await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' });
    const record = (answer.records as unknown as Record<string, unknown>[])[0]!;
    expect(record.integrity).toBe('RETRACTED');
    const notices = record.notices as Record<string, unknown>[];
    expect(notices[0]!.source).toBe('retraction-watch');
    expect(notices[0]!.noticeDoi).toBe('10.1016/s0140-6736(10)60175-4');
    // And it leads the answer rather than sitting at the bottom of a list.
    expect((answer.limitations as unknown as string[])[0]).toMatch(/retraction on record/i);
  });

  it('reports the worst notice when a work has several', async () => {
    responses = {
      'api.crossref.org': {
        status: 200,
        body: crossrefWork({
          'updated-by': [
            { DOI: '10.1/c', type: 'correction', label: 'Correction', source: 'publisher', updated: { 'date-parts': [[2004, 3, 6]] } },
            { DOI: '10.1/r', type: 'retraction', label: 'Retraction', source: 'retraction-watch', updated: { 'date-parts': [[2010, 2, 6]] } },
          ],
        }),
      },
    };
    const record = (
      (await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' }))
        .records as unknown as Record<string, unknown>[]
    )[0]!;
    expect(record.integrity).toBe('RETRACTED');
    // Both survive: a correction is its own fact, not noise beneath the worst.
    expect((record.notices as unknown[]).length).toBe(2);
  });

  it('calls an absence of records NO_KNOWN_UPDATE and says what that is not', async () => {
    responses = { 'api.crossref.org': { status: 200, body: crossrefWork() } };
    const answer = await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' });
    const record = (answer.records as unknown as Record<string, unknown>[])[0]!;
    expect(record.integrity).toBe('NO_KNOWN_UPDATE');
    // Never CLEAN, VALID or VERIFIED. The sources hold no such record; that is
    // all anyone can say.
    expect((answer.limitations as unknown as string[]).join(' ')).toMatch(/not a finding that the work is sound/i);
  });

  it('leaves arXiv integrity unknown rather than claiming nothing is wrong', async () => {
    // arXiv publishes withdrawals as a version comment, not as structured
    // metadata, so this source cannot establish integrity either way.
    responses = { 'export.arxiv.org': { status: 200, body: arxivFeed({ doi: '' }) } };
    const record = (
      (await invoke('research.paper_lookup', { identifier: '2401.12345' })).records as unknown as Record<string, unknown>[]
    )[0]!;
    expect(record.integrity).toBe('UNKNOWN');
  });
});

describe('two records are one work only on strong evidence', () => {
  const base = { doi: null, arxivId: null, title: null } as never;

  it('joins on a shared DOI', () => {
    expect(sameWork({ ...base, doi: '10.1/x' }, { ...base, doi: '10.1/x' })).toBe(true);
  });

  it('joins on a shared arXiv id', () => {
    expect(sameWork({ ...base, arxivId: '2401.1' }, { ...base, arxivId: '2401.1' })).toBe(true);
  });

  it('does not join on title, however similar', () => {
    // "Attention Is All You Need" and "Is Attention All You Need?" are
    // different papers. So are a paper and its own erratum.
    const a = { ...base, title: 'Attention Is All You Need' };
    const b = { ...base, title: 'Attention Is All You Need' };
    expect(sameWork(a, b)).toBe(false);
  });

  it('links a preprint to its published record through the DOI the preprint declared', async () => {
    responses = {
      'export.arxiv.org': { status: 200, body: arxivFeed() },
      'api.crossref.org': { status: 200, body: crossrefWork() },
    };
    const answer = await invoke('research.paper_lookup', { identifier: 'arXiv:1207.7214' });
    const records = answer.records as unknown as Record<string, unknown>[];
    expect(answer.linked).toBe(true);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.source).sort()).toEqual(['arxiv', 'crossref']);
    // Two records of one work, each keeping its own nature.
    expect(records.find((record) => record.source === 'arxiv')!.kind).toBe('PREPRINT');
    expect(records.find((record) => record.source === 'crossref')!.kind).toBe('JOURNAL_ARTICLE');
  });

  it('keeps a preprint with no DOI as a work in its own right', async () => {
    responses = { 'export.arxiv.org': { status: 200, body: arxivFeed({ doi: '' }) } };
    const answer = await invoke('research.paper_lookup', { identifier: '2401.12345' });
    const record = (answer.records as unknown as Record<string, unknown>[])[0]!;
    expect(record.doi).toBeNull();
    expect(record.arxivId).toBe('1207.7214');
    expect(answer.linked).toBe(false);
  });
});

describe('citation counts belong to whoever counted them', () => {
  it('never reports a bare number', async () => {
    responses = { 'api.crossref.org': { status: 200, body: crossrefWork() } };
    const record = (
      (await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' }))
        .records as unknown as Record<string, unknown>[]
    )[0]!;
    const citations = record.citations as Record<string, unknown>;
    expect(citations.count).toBe(6819);
    // Indexes cover different literature; a count without its index is a
    // number nobody can check.
    expect(citations.source).toBe('crossref');
    expect(citations.observedAt).toBeTruthy();
  });

  it('reports no count rather than zero when a source does not count', async () => {
    // Zero would read as "never cited", which is a claim arXiv never made.
    responses = { 'export.arxiv.org': { status: 200, body: arxivFeed({ doi: '' }) } };
    const record = (
      (await invoke('research.paper_lookup', { identifier: '2401.12345' })).records as unknown as Record<string, unknown>[]
    )[0]!;
    expect(record.citations).toBeNull();
  });
});

describe('the published limits are the ones that are used', () => {
  it('counts Crossref singleton and search requests against separate budgets', () => {
    // Since December 2025 Crossref rates them differently -- 5/s for a single
    // record, 1/s for a search -- and names which pool served each response.
    // Applying the singleton budget to a search is five times their rate.
    const crossref = familyMembers('paper_index')[0]!;
    const single = crossref.limit.windows.find((window) => window.capacity === 5)!;
    const array = crossref.limit.windows.find((window) => window.capacity === 1)!;

    expect(single.per!({ kind: 'doi', doi: '10.1/x' })).toBe('single');
    expect(single.per!({ kind: 'search', query: 'x', limit: 3 })).toBeNull();
    expect(array.per!({ kind: 'search', query: 'x', limit: 3 })).toBe('array');
    expect(array.per!({ kind: 'doi', doi: '10.1/x' })).toBeNull();
    expect(single.source).toBe('PUBLISHED');
    expect(crossref.limit.concurrentPerProcess).toBe(1);
  });

  it('holds arXiv to one request every three seconds, machine-wide', () => {
    // Their terms: the limits "apply to all of the machines under your control
    // as a whole". A process-local counter would breach a published term the
    // moment a second AI17Z ran on the same host.
    const arxiv = familyMembers('preprint_archive')[0]!;
    expect(arxiv.limit.concurrentPerProcess).toBe(1);
    expect(arxiv.limit.windows).toHaveLength(1);
    expect(arxiv.limit.windows[0]!.capacity).toBe(1);
    expect(arxiv.limit.windows[0]!.intervalMs).toBe(3_000);
    expect(arxiv.limit.windows[0]!.scope).toBe('MACHINE');
    expect(arxiv.limit.windows[0]!.source).toBe('PUBLISHED');
  });
});

describe('when a source cannot answer', () => {
  it('carries on with the other one and says which is missing', async () => {
    responses = { 'export.arxiv.org': { status: 200, body: arxivFeed({ doi: '' }) } };
    // Crossref is unreachable in this fixture: a 404 for its URL.
    const answer = await invoke('research.paper_search', { query: 'quantum error correction', limit: 3 });
    expect((answer.results as unknown[]).length).toBeGreaterThan(0);
    expect((answer.notSearched as unknown as { source: string }[]).map((entry) => entry.source)).toContain('crossref');
    expect((answer.limitations as unknown as string[])[0]).toMatch(/partial view/i);
  });

  it('treats an unregistered DOI as an answer, not as the registry failing', async () => {
    responses = {};
    const answer = await invoke('research.paper_lookup', { identifier: '10.9999/does-not-exist' });
    expect(answer.records).toEqual([]);
    expect((answer.limitations as unknown as string[]).join(' ')).toMatch(/not evidence the work does not exist/i);
    expect(healthOf('paper_index.crossref').failures).toBe(0);
  });
});

describe('what every answer says', () => {
  it('states that existence is not truth, on a perfectly ordinary result', async () => {
    responses = { 'api.crossref.org': { status: 200, body: crossrefWork() } };
    const answer = await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' });
    expect((answer.limitations as unknown as string[]).join(' ')).toMatch(/do not establish that its claims are correct/i);
  });

  it('points at the primary source rather than a summary of it', async () => {
    responses = { 'api.crossref.org': { status: 200, body: crossrefWork() } };
    const record = (
      (await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' }))
        .records as unknown as Record<string, unknown>[]
    )[0]!;
    expect(record.url).toBe('https://doi.org/10.1016/j.physletb.2012.08.020');
  });

  it('reports the real author count when the list was truncated', async () => {
    const many = Array.from({ length: 2932 }, (_, index) => ({ given: 'A', family: `Author${index}` }));
    responses = { 'api.crossref.org': { status: 200, body: crossrefWork({ author: many }) } };
    const record = (
      (await invoke('research.paper_lookup', { identifier: '10.1016/j.physletb.2012.08.020' }))
        .records as unknown as Record<string, unknown>[]
    )[0]!;
    expect((record.authors as unknown[]).length).toBeLessThanOrEqual(25);
    // The list is trimmed; the fact is not.
    expect(record.authorCount).toBe(2932);
  });
});
