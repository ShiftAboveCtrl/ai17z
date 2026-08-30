import { describe, expect, it } from 'vitest';
import { renderResearch, research, whatToResearch, type Finding } from '@xbam/runtime';

/**
 * Knowing when to go and look.
 *
 * "Hey, what is this about?" under a post from an hour ago cannot be answered
 * from a training set, and a model asked it anyway invents something. But an
 * agent that searches the web before every reply is slow, expensive, and no
 * better at answering "nice one" — so most of this file is about the cases
 * where it should do nothing.
 */

describe('the ordinary reply needs nothing looked up', () => {
  const quiet = [
    'nice one',
    'agree completely',
    'haha',
    '@agent good morning',
    'this is a well written piece and I enjoyed reading all of it thank you',
  ];

  for (const text of quiet) {
    it(`looks nothing up for "${text.slice(0, 30)}"`, () => {
      expect(whatToResearch({ incoming: text })).toEqual([]);
    });
  }
});

describe('being asked about something', () => {
  it('searches for the subject, not for the question', () => {
    // "what is this about" is a useless query. The parent is the subject.
    const lookups = whatToResearch({
      incoming: '@agent what is this post about?',
      parent: 'Protocol X paused withdrawals this morning pending a security review.',
    });
    const search = lookups.find((l) => l.kind === 'search');
    expect(search).toBeDefined();
    expect(search!.query).toContain('paused withdrawals');
    expect(search!.query).not.toContain('what is this post about');
  });

  it('strips handles and links out of the query', () => {
    const lookups = whatToResearch({
      incoming: '@agent whats going on here',
      parent: '@someone @someoneelse look at this https://example.com/thing big news today',
    });
    const search = lookups.find((l) => l.kind === 'search')!;
    expect(search.query).not.toContain('@someone');
    expect(search.query).not.toContain('https://');
  });

  it('falls back to the mention itself when there is no parent', () => {
    const lookups = whatToResearch({ incoming: '@agent what happened with the Foo Protocol exploit' });
    expect(lookups.some((l) => l.kind === 'search' && l.query.includes('Foo Protocol'))).toBe(true);
  });

  it('does not search when the question has no subject to search for', () => {
    // Three words of nothing is not a query.
    expect(whatToResearch({ incoming: '@agent what?' })).toEqual([]);
  });

  it('carries the reason, so the trace says why it went looking', () => {
    const lookups = whatToResearch({
      incoming: '@agent what is this about?',
      parent: 'The upgrade shipped and immediately broke withdrawals.',
    });
    expect(lookups[0]!.reason.length).toBeGreaterThan(10);
  });
});

describe('things that change by the day', () => {
  it('looks up a time-sensitive subject even without a direct question', () => {
    const lookups = whatToResearch({
      incoming: '@agent thoughts',
      parent: 'Breaking: the exchange halted trading this morning.',
    });
    expect(lookups.some((l) => l.kind === 'search')).toBe(true);
  });
});

describe('contract addresses and tickers', () => {
  it('finds an EVM address', () => {
    const lookups = whatToResearch({
      incoming: '@agent is 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 legit?',
    });
    const token = lookups.find((l) => l.kind === 'token');
    expect(token?.query).toBe('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984');
  });

  it('finds a ticker', () => {
    const lookups = whatToResearch({ incoming: '@agent what do you make of $WIF' });
    expect(lookups.some((l) => l.kind === 'token' && l.query === 'WIF')).toBe(true);
  });

  it('looks a token up whatever else the message says', () => {
    // Unambiguous and cheap, so it does not wait for a question to be asked.
    const lookups = whatToResearch({ incoming: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' });
    expect(lookups.some((l) => l.kind === 'token')).toBe(true);
  });

  it('does not mistake a status id for a Solana address', () => {
    const lookups = whatToResearch({ incoming: 'have a look at 2093935765298303455 please' });
    expect(lookups.some((l) => l.kind === 'token')).toBe(false);
  });

  it('never asks for more than the cap', () => {
    const many = '$AAA $BBB $CCC $DDD $EEE $FFF what is going on with all of these today';
    expect(whatToResearch({ incoming: many }).length).toBeLessThanOrEqual(3);
  });
});

describe('links they asked about', () => {
  it('reads a link when the question is about it', () => {
    const lookups = whatToResearch({
      incoming: '@agent what is this about?',
      parent: 'worth a read',
      links: ['https://example.com/article'],
    });
    expect(lookups.some((l) => l.kind === 'link' && l.query === 'https://example.com/article')).toBe(true);
  });

  it('leaves links alone when nobody asked', () => {
    const lookups = whatToResearch({ incoming: 'nice', parent: 'a post', links: ['https://example.com/x'] });
    expect(lookups.some((l) => l.kind === 'link')).toBe(false);
  });
});

describe('running the lookups', () => {
  it('reports a gap rather than silently skipping it when there is no browser', async () => {
    const result = await research([{ kind: 'search', query: 'anything', reason: 'because' }]);
    expect(result.findings).toEqual([]);
    expect(result.failed[0]!.reason).toContain('No browser');
    expect(result.note).toContain('could not');
  });

  it('uses the search function it was given', async () => {
    const finding: Finding = {
      kind: 'search',
      query: 'q',
      source: 'Web search',
      title: 'A result',
      summary: 'Something happened.',
      url: 'https://example.com',
      retrievedAt: new Date().toISOString(),
    };
    const result = await research([{ kind: 'search', query: 'q', reason: 'because' }], {
      search: async () => [finding],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.note).toContain('Looked up 1');
  });

  it('turns a thrown search into a recorded failure', async () => {
    const result = await research([{ kind: 'search', query: 'q', reason: 'because' }], {
      search: async () => {
        throw new Error('the browser went away');
      },
    });
    expect(result.findings).toEqual([]);
    expect(result.failed[0]!.reason).toContain('browser went away');
  });
});

describe('how findings are put to the model', () => {
  const finding: Finding = {
    kind: 'search',
    query: 'q',
    source: 'Web search',
    title: 'Exchange halts withdrawals',
    summary: 'Withdrawals were paused at 09:00 pending a review.',
    url: 'https://example.com/news',
    retrievedAt: new Date().toISOString(),
  };

  it('attributes every finding to where it came from', () => {
    const rendered = renderResearch({ findings: [finding], failed: [], note: '' });
    expect(rendered).toContain('Web search');
    expect(rendered).toContain('Exchange halts withdrawals');
    expect(rendered).toContain('https://example.com/news');
  });

  it('says this was looked up rather than known', () => {
    // An agent that launders a search result into its own voice states a wrong
    // one exactly as confidently as a right one.
    const rendered = renderResearch({ findings: [finding], failed: [], note: '' });
    expect(rendered).toContain('not something you knew');
    expect(rendered).toContain('do not repeat any of it as your own knowledge');
  });

  it('tells the model to admit a gap rather than fill it', () => {
    const rendered = renderResearch({
      findings: [],
      failed: [{ query: 'the thing', reason: 'no results' }],
      note: '',
    });
    expect(rendered).toContain('Say you do not know rather than guessing');
  });

  it('renders nothing at all when nothing was looked up', () => {
    expect(renderResearch({ findings: [], failed: [], note: '' })).toBe('');
  });
});
