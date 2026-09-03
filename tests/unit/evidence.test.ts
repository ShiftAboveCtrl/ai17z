import { describe, expect, it } from 'vitest';
import {
  domainOf,
  keywordsOf,
  publishedAtFrom,
  rankAuthority,
  rankEvidence,
  relevanceOf,
  toEvidence,
  worthOpening,
  type Evidence,
} from '@xbam/runtime';

const base = { source: 'Web search', question: 'what did project Q announce about distribution today' };

describe('where evidence came from', () => {
  it('reads the domain, ignoring www', () => {
    expect(domainOf('https://www.Reuters.com/article/x')).toBe('reuters.com');
    expect(domainOf('not a url')).toBeNull();
    expect(domainOf(null)).toBeNull();
  });

  it('treats a site the owner named as official above everything else', () => {
    const { authority, why } = rankAuthority('https://projectq.io/blog/migration', ['projectq.io']);
    expect(authority).toBe('OFFICIAL');
    expect(why).toContain('official');
  });

  it('covers subdomains of an official domain', () => {
    expect(rankAuthority('https://docs.projectq.io/x', ['projectq.io']).authority).toBe('OFFICIAL');
  });

  it('does not mistake a lookalike domain for the official one', () => {
    // projectq.io.evil.com ends with "evil.com", not with ".projectq.io".
    expect(rankAuthority('https://projectq.io.evil.com/x', ['projectq.io']).authority).not.toBe('OFFICIAL');
  });

  it('recognises established publications without being told', () => {
    expect(rankAuthority('https://www.reuters.com/x').authority).toBe('REPUTABLE');
    expect(rankAuthority('https://en.wikipedia.org/wiki/X').authority).toBe('REPUTABLE');
  });

  it('treats documentation and announcements as primary', () => {
    expect(rankAuthority('https://somewhere.dev/docs/install').authority).toBe('PRIMARY');
    expect(rankAuthority('https://somewhere.dev/blog/we-shipped').authority).toBe('PRIMARY');
  });

  it('falls to secondary rather than to nothing', () => {
    expect(rankAuthority('https://someblog.example/post').authority).toBe('SECONDARY');
  });
});

describe('dates are read, never guessed', () => {
  it('reads the forms search results actually carry', () => {
    expect(publishedAtFrom('Published 2026-09-01 by someone')).toBe('2026-09-01');
    expect(publishedAtFrom('September 1, 2026 — the announcement')).toBe('2026-09-01');
    expect(publishedAtFrom('1 September 2026, updated later')).toBe('2026-09-01');
  });

  it('returns null when the source gave no date', () => {
    // A made-up date is worse than none: it makes stale information look fresh.
    expect(publishedAtFrom('Everything you need to know about Project Q')).toBeNull();
    expect(publishedAtFrom('Updated recently')).toBeNull();
  });
});

describe('how well a result answers the question', () => {
  it('scores overlap with the question, not with the post', () => {
    const high = relevanceOf(base.question, 'Project Q announced a change to token distribution today');
    const low = relevanceOf(base.question, 'Ten breakfast recipes for a busy morning');
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(0.4);
  });

  it('ignores the words every sentence has', () => {
    expect(keywordsOf('what is the latest on the thing')).not.toContain('the');
    expect(keywordsOf('$AI17Z distribution')).toContain('$ai17z');
  });
});

describe('normalising one result', () => {
  it('keeps the source, the time it was read, and what it is about', () => {
    const evidence = toEvidence({
      ...base,
      title: 'Project Q migration announced',
      snippet: 'On September 1, 2026 the team described a new distribution schedule.',
      url: 'https://projectq.io/blog/migration',
      entity: 'Project Q',
      officialDomains: ['projectq.io'],
    });

    expect(evidence.authority).toBe('OFFICIAL');
    expect(evidence.domain).toBe('projectq.io');
    expect(evidence.publishedAt).toBe('2026-09-01');
    expect(evidence.entity).toBe('Project Q');
    expect(Date.parse(evidence.retrievedAt)).not.toBeNaN();
    expect(evidence.why).toContain('official');
  });

  it('leaves the date null when the result did not carry one', () => {
    const evidence = toEvidence({ ...base, title: 'A page', snippet: 'No date here.', url: 'https://x.example/a' });
    expect(evidence.publishedAt).toBeNull();
  });
});

const ev = (over: Partial<Evidence>): Evidence => ({
  source: 'Web search',
  title: 't',
  snippet: 's',
  url: 'https://example.com/a',
  domain: 'example.com',
  publishedAt: null,
  retrievedAt: new Date().toISOString(),
  authority: 'SECONDARY',
  entity: null,
  relevance: 0.5,
  why: '',
  ...over,
});

describe('ranking', () => {
  it('puts the project\'s own announcement above a summary of it', () => {
    const ranked = rankEvidence([
      ev({ title: 'What the migration means', authority: 'SECONDARY', relevance: 0.9, url: 'https://blog.example/a' }),
      ev({ title: 'Migration', authority: 'OFFICIAL', relevance: 0.6, url: 'https://projectq.io/b' }),
    ]);
    expect(ranked[0]!.title).toBe('Migration');
  });

  it('uses relevance to separate sources of equal standing', () => {
    const ranked = rankEvidence([
      ev({ title: 'barely', authority: 'REPUTABLE', relevance: 0.2, url: 'https://a.example/1' }),
      ev({ title: 'closely', authority: 'REPUTABLE', relevance: 0.9, url: 'https://b.example/2' }),
    ]);
    expect(ranked[0]!.title).toBe('closely');
  });

  it('prefers the newer of two equally good dated sources', () => {
    const ranked = rankEvidence([
      ev({ title: 'older', authority: 'REPUTABLE', relevance: 0.8, publishedAt: '2026-01-01', url: 'https://a.example/1' }),
      ev({ title: 'newer', authority: 'REPUTABLE', relevance: 0.8, publishedAt: '2026-09-01', url: 'https://b.example/2' }),
    ]);
    expect(ranked[0]!.title).toBe('newer');
  });

  it('does not sink an undated result beneath a worse dated one', () => {
    // Most search results carry no date. Treating undated as old would leave
    // only the minority of pages that happen to print one.
    const ranked = rankEvidence([
      ev({ title: 'dated but weak', authority: 'SECONDARY', relevance: 0.2, publishedAt: '2026-09-01', url: 'https://a.example/1' }),
      ev({ title: 'undated and strong', authority: 'OFFICIAL', relevance: 0.9, url: 'https://b.example/2' }),
    ]);
    expect(ranked[0]!.title).toBe('undated and strong');
  });

  it('collapses the same page arriving from two queries', () => {
    const ranked = rankEvidence([
      ev({ url: 'https://projectq.io/a', title: 'one' }),
      ev({ url: 'https://projectq.io/a', title: 'one again' }),
    ]);
    expect(ranked).toHaveLength(1);
  });

  it('caps what reaches the prompt', () => {
    const many = Array.from({ length: 20 }, (_, i) => ev({ url: `https://e.example/${i}`, title: `t${i}` }));
    expect(rankEvidence(many, 4)).toHaveLength(4);
  });
});

describe('deciding to open the page itself', () => {
  it('opens a thin authoritative result', () => {
    expect(worthOpening(ev({ authority: 'OFFICIAL', relevance: 0.8, snippet: 'Short blurb.' }))).toBe(true);
  });

  it('does not spend a page load on a secondary source', () => {
    expect(worthOpening(ev({ authority: 'SECONDARY', relevance: 0.9, snippet: 'Short.' }))).toBe(false);
  });

  it('does not reopen something already quoted at length', () => {
    expect(worthOpening(ev({ authority: 'OFFICIAL', relevance: 0.9, snippet: 'x'.repeat(500) }))).toBe(false);
  });

  it('needs somewhere to go', () => {
    expect(worthOpening(ev({ authority: 'OFFICIAL', relevance: 0.9, url: null }))).toBe(false);
  });
});
