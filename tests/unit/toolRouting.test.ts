import { describe, expect, it } from 'vitest';
import { whatToResearch } from '@xbam/runtime';

const route = (incoming: string, parent: string | null = null) =>
  whatToResearch({ incoming, parent, parentIsOwn: false });

const kinds = (incoming: string, parent: string | null = null) => route(incoming, parent).map((l) => l.kind);

/**
 * The four cases the brief names, run through the real router.
 *
 * This exists to verify rather than to build: the routing was implemented in
 * the query-planner work, and the requirement showing up again is a reason to
 * check it against its own examples, not a reason to write it twice. Every case
 * below is the brief's, worded as somebody would actually type it.
 */
describe('what a question actually needs looked up', () => {
  it('does not go to the web for something the documentation answers', () => {
    // "How do I install AI17Z?" -- a question about the project. Nothing here
    // changes by the day, and searching the web for it is slower and worse than
    // the documentation the agent has been given.
    expect(kinds('How do I install AI17Z?')).not.toContain('search');
  });

  it('looks up something that changes by the day', () => {
    expect(kinds('What did OpenAI announce today?')).toContain('search');
  });

  it('goes to market data for a contract address', () => {
    const asked = 'What is the liquidity on 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984?';
    expect(kinds(asked)).toContain('token');
  });

  it('goes to market data for a ticker', () => {
    expect(kinds('how is $AI17Z doing?')).toContain('token');
  });

  it('uses both when the question spans both', () => {
    // "Why did this token's volume spike after today's announcement?" needs the
    // market data and the news, and answering with either alone is a guess.
    const asked = 'why did $UNI volume spike after the announcement today?';
    expect(kinds(asked)).toContain('token');
    expect(kinds(asked)).toContain('search');
  });

  it('does nothing at all for an ordinary reply', () => {
    // The requirement's own emphasis: searching before every message is slow,
    // expensive, and no better at answering "nice one".
    expect(route('nice one')).toEqual([]);
    expect(route('haha true')).toEqual([]);
    expect(route('gm')).toEqual([]);
  });

  it('stays within its budget however much a message mentions', () => {
    const busy = 'thoughts on $AAA $BBB $CCC $DDD $EEE and what happened today?';
    expect(route(busy).length).toBeLessThanOrEqual(3);
  });

  it('says why each lookup is worth doing', () => {
    // A plan and a pattern match look identical once both are a list of
    // queries, so each carries the reason it exists.
    for (const lookup of route('how is $AI17Z doing today?')) {
      expect(lookup.reason.length).toBeGreaterThan(5);
    }
  });
});
