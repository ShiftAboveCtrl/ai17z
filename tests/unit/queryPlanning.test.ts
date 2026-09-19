import { describe, expect, it } from 'vitest';
import { namedSubjects, whatToResearch } from '@xbam/runtime';

const queries = (subject: Parameters<typeof whatToResearch>[0]) =>
  whatToResearch(subject).filter((l) => l.kind === 'search').map((l) => l.query);
const all = (subject: Parameters<typeof whatToResearch>[0]) =>
  whatToResearch(subject).map((l) => `${l.kind}:${l.query}`);

/**
 * The query must represent what is being asked, never the words the post
 * happened to open with.
 *
 * The old fallback pasted the first sentence behind "What is the latest on: ",
 * which is how a search engine was asked about "Absolutely WILD piece of tech
 * here." and "Windows is complete." and, twice, about the agent's own previous
 * reply. Every string below is one the live agent actually sent.
 */
describe('the query is about the subject, not the sentence', () => {
  it('never wraps a whole post as a query again', () => {
    for (const parent of [
      'Absolutely WILD piece of tech here.',
      'Normies still sleeping on this at 30k, tell them',
      'I see you are having fun using it, you should go check out what the system actually does',
    ]) {
      for (const query of queries({ incoming: 'what is this?', parent })) {
        expect(query, query).not.toContain('What is the latest on:');
        // A query that is most of the post is a paste, not a question.
        expect(query.length, query).toBeLessThan(parent.length);
      }
    }
  });

  it('asks about the thing the post names', () => {
    const found = queries({
      incoming: 'what is this about?',
      parent: 'Project Q announced a migration today, moving distribution to a new schedule.',
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Project Q');
  });

  it('looks nothing up when the post names nothing', () => {
    // The honest outcome. A statement with no subject has no query, and
    // searching it returns whatever those words collocate with.
    expect(queries({ incoming: 'what is this?', parent: 'Absolutely WILD piece of tech here.' })).toEqual([]);
    expect(queries({ incoming: 'whats going on?', parent: 'It is finally happening.' })).toEqual([]);
  });
});

describe('finding the subject of a statement', () => {
  it('takes a name that opens the sentence', () => {
    expect(namedSubjects('Solana and Base both had outages')).toEqual(['Solana', 'Base']);
    expect(namedSubjects('Project Q announced a migration')).toEqual(['Project Q']);
  });

  it('does not take an adverb that opens the sentence', () => {
    expect(namedSubjects('Absolutely WILD piece of tech here.')).toEqual([]);
    expect(namedSubjects('Honestly this is incredible')).toEqual([]);
  });

  it('treats shouting as shouting', () => {
    expect(namedSubjects('WHAT THE HELL')).toEqual([]);
    expect(namedSubjects('THIS IS HUGE')).toEqual([]);
  });

  it('takes tickers, quoted phrases and sites', () => {
    expect(namedSubjects('is $AI17Z listed yet')).toContain('$AI17Z');
    expect(namedSubjects('they called it "the great migration" apparently')).toContain('the great migration');
    expect(namedSubjects('check ai17z.com for details')).toContain('ai17z.com');
  });
});

describe('the shapes a question arrives in', () => {
  it('multi-sentence: each question judged separately', () => {
    const found = all({
      incoming: 'Nice work. What did the Fed decide today? Also is $AI17Z listed anywhere yet?',
    });
    expect(found.some((q) => /Fed/i.test(q))).toBe(true);
    expect(found.some((q) => q.startsWith('token:AI17Z'))).toBe(true);
  });

  it('parent context: the subject comes from the post above', () => {
    expect(queries({ incoming: 'wait what is this about?', parent: 'The Fed raised rates again this morning.' })).toEqual([
      'The Fed latest news',
    ]);
  });

  it('quoted context: a quoted post is a parent for this purpose', () => {
    // A quote is the thing being talked about, exactly as a parent is.
    expect(
      queries({ incoming: 'is this real?', parent: 'Chainlink announced a partnership with Swift today.' }).join(' '),
    ).toContain('Chainlink');
  });

  it('follow-up: a vague question about our own last reply is not researched', () => {
    expect(all({ incoming: 'and after that?', parent: 'I only answer what I can check.', parentIsOwn: true })).toEqual([]);
  });

  it('multiple entities: bounded, and about the entities', () => {
    const found = queries({ incoming: 'what happened?', parent: 'Solana and Base and Arbitrum all had outages today.' });
    expect(found).toHaveLength(1);
    // Bounded at three names so one query does not become a list of everything.
    expect(found[0]!.split(' ').length).toBeLessThanOrEqual(6);
  });

  it('time-sensitive: says so in the query', () => {
    expect(queries({ incoming: 'any news?', parent: 'Project Q had an outage this morning.' })[0]).toContain('latest news');
  });

  it('needs no search: praise, greetings, instructions', () => {
    for (const text of ['holy shit tech is tuff asf', 'gm', 'Yoo', '@ai17zOS make another post', 'this is lowkey crazy']) {
      expect(all({ incoming: text }), text).toEqual([]);
    }
  });

  it('ambiguous: a bare ticker resolves as a token, not as a web search', () => {
    // Which is the DexScreener path, where disambiguation belongs.
    const found = all({ incoming: 'hows $DOG looking' });
    expect(found.some((q) => q === 'token:DOG')).toBe(true);
  });

  it('never sends more than three lookups whatever the message contains', () => {
    const busy =
      'what about $AAA and $BBB and $CCC and $DDD, also what did the Fed decide today, and is Solana down, and what is Project Q?';
    expect(whatToResearch({ incoming: busy }).length).toBeLessThanOrEqual(3);
  });
});
