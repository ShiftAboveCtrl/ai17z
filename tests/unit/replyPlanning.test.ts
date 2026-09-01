import { describe, expect, it } from 'vitest';
import { refersToSomethingElse, textStandsAlone } from '@xbam/shared';
import { parsePlan, questionsIn, whatToResearch, worthPlanning } from '@xbam/runtime';

/**
 * Deciding what to look at before replying.
 *
 * Written from a reply that failed in public. Somebody replied to a screenshot
 * of a trade with:
 *
 *   "@agent what did he roundtrip on? also whats the weather like in Chicago today"
 *
 * Four things went wrong at once, and each one has its own case below:
 *
 *  1. The message was thirteen words, so it "stood alone", so nothing looked at
 *     the image the first question was about.
 *  2. Only one lookup was ever produced, from the *parent post's text* rather
 *     than from either question.
 *  3. That lookup was "What is the latest on: Nothing as waking up on a 30k
 *     roundtrip during sleep GM", which returned three articles about waking up
 *     at 3am.
 *  4. The weather -- the one thing genuinely worth looking up -- was never
 *     asked about at all.
 */

const REAL_CASE = {
  incoming: '@youraccount what did he roundtrip on? also whats the weather like in Chicago today',
  parent: 'Nothing as waking up on a 30k roundtrip during sleep GM',
  hasUnreadMedia: true,
};

describe('the reply that flopped', () => {
  it('looks up the weather and nothing else', () => {
    const lookups = whatToResearch(REAL_CASE);

    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.kind).toBe('search');
    expect(lookups[0]!.query.toLowerCase()).toContain('weather');
    expect(lookups[0]!.query.toLowerCase()).toContain('chicago');
  });

  it('never searches the web for what is in the picture', () => {
    const queries = whatToResearch(REAL_CASE).map((l) => l.query.toLowerCase());
    expect(queries.some((q) => q.includes('roundtrip'))).toBe(false);
  });

  it('never pastes the parent post at an answer engine', () => {
    // The actual query that ran, and the reason the agent came back talking
    // about sleep hygiene.
    const queries = whatToResearch(REAL_CASE).map((l) => l.query.toLowerCase());
    expect(queries.some((q) => q.includes('waking up'))).toBe(false);
    expect(queries.some((q) => q.startsWith('what is the latest on: nothing'))).toBe(false);
  });

  it('knows the message did not stand on its own', () => {
    // Thirteen words, and every one of them useless without the screenshot.
    // The old rule counted to eight and stopped.
    expect(textStandsAlone(REAL_CASE.incoming)).toBe(false);
  });
});

describe('reading two questions as two questions', () => {
  it('separates them', () => {
    expect(questionsIn(REAL_CASE.incoming)).toEqual([
      'what did he roundtrip on',
      'whats the weather like in Chicago today',
    ]);
  });

  it('drops the word that joins them', () => {
    expect(questionsIn('@a is it live? and how much did it raise?')[1]).toBe('how much did it raise');
  });

  it('finds a request with no question mark', () => {
    expect(questionsIn('@a explain the fee change')).toEqual(['explain the fee change']);
  });

  it('finds nothing in a message that asks nothing', () => {
    expect(questionsIn('@a completely agree with this')).toEqual([]);
  });

  it('looks up both when both are answerable', () => {
    const lookups = whatToResearch({
      incoming: '@a whats the price of SOL today? and who founded Solana?',
      parent: null,
    });
    expect(lookups.map((l) => l.query.toLowerCase())).toEqual([
      'whats the price of sol today?',
      'who founded solana?',
    ]);
  });
});

describe('pointing outside the message', () => {
  const outward = [
    'what did he roundtrip on',
    'what is this about',
    'what does the chart show',
    'is that real',
    'what does this mean',
    'who are they',
    'what is shown above',
  ];
  for (const text of outward) {
    it(`"${text}" needs what it points at`, () => {
      expect(refersToSomethingElse(text)).toBe(true);
    });
  }

  const selfContained = [
    'whats the weather like in Chicago today',
    'what is happening with fees this week',
    'how much did Solana raise in its seed round',
    'the fee model assumes every pair has depth, which is plainly untrue',
  ];
  for (const text of selfContained) {
    it(`"${text.slice(0, 40)}" does not`, () => {
      expect(refersToSomethingElse(text)).toBe(false);
    });
  }
});

describe('when nothing needs looking up', () => {
  it('says nothing to an ordinary reply', () => {
    expect(whatToResearch({ incoming: '@a nice one', parent: 'A view about fees.' })).toEqual([]);
    expect(whatToResearch({ incoming: '@a totally agree', parent: 'A view about fees.' })).toEqual([]);
  });

  it('does not search a social question', () => {
    // The point of the whole decision: a question mark is not a reason to
    // search. "You around?" has no answer on the internet.
    expect(whatToResearch({ incoming: '@a you around?', parent: null })).toEqual([]);
  });

  it('leaves a question about the picture to the picture', () => {
    expect(whatToResearch({ incoming: '@a what does this chart show?', parent: 'chart', hasUnreadMedia: true })).toEqual(
      [],
    );
  });

  it('still uses the post above when the question has no subject', () => {
    // "What is this about" is the one case where searching the parent is right,
    // because "this" IS the parent.
    const lookups = whatToResearch({
      incoming: '@a what is this about?',
      parent: 'Ethereum core devs scheduled the next upgrade for spring.',
    });
    expect(lookups[0]!.query).toContain('Ethereum');
  });
});

describe('asking a model to plan, only where it pays', () => {
  it('does not plan an ordinary reply', () => {
    // No question, no media, no link, nothing the rules wanted. Spending a
    // model call to be told "nothing" is how a reply gets slow for no reason.
    expect(
      worthPlanning({ incoming: 'nice one', parent: 'something', hasMedia: false, links: [], deterministic: [] }),
    ).toBe(false);
  });

  it('plans when there is a picture, or a question, or a link', () => {
    const base = { incoming: 'ok', parent: null, hasMedia: false, links: [], deterministic: [] };
    expect(worthPlanning({ ...base, hasMedia: true })).toBe(true);
    expect(worthPlanning({ ...base, incoming: 'what is this?' })).toBe(true);
    expect(worthPlanning({ ...base, links: ['https://example.com'] })).toBe(true);
  });
});

describe('reading the plan a model returns', () => {
  it('takes a well-formed answer', () => {
    const plan = parsePlan(
      '{"needsImage": true, "lookups": [{"kind": "search", "query": "weather in Chicago today", "reason": "it changes"}]}',
    );
    expect(plan!.needsImage).toBe(true);
    expect(plan!.lookups).toHaveLength(1);
    expect(plan!.lookups[0]!.query).toBe('weather in Chicago today');
  });

  it('digs the object out of whatever the model wrapped it in', () => {
    const plan = parsePlan('Sure!\n```json\n{"needsImage": false, "lookups": []}\n```\nHope that helps.');
    expect(plan).not.toBeNull();
    expect(plan!.lookups).toEqual([]);
  });

  it('refuses anything that is not the agreed shape', () => {
    // Every one of these has to end in falling back to the rules, not in a
    // half-applied plan.
    expect(parsePlan('no json here')).toBeNull();
    expect(parsePlan('{"lookups": "search the web"}')).toBeNull();
    expect(parsePlan('{ broken')).toBeNull();
  });

  it('drops entries it cannot use rather than the whole plan', () => {
    const plan = parsePlan(
      '{"needsImage": false, "lookups": [{"kind": "telepathy", "query": "x"}, {"kind": "search", "query": "who won the game last night"}]}',
    );
    expect(plan!.lookups).toHaveLength(1);
    expect(plan!.lookups[0]!.kind).toBe('search');
  });

  it('never accepts more than three', () => {
    const many = Array.from({ length: 8 }, (_, i) => `{"kind":"search","query":"question number ${i}"}`).join(',');
    expect(parsePlan(`{"lookups":[${many}]}`)!.lookups).toHaveLength(3);
  });
});
