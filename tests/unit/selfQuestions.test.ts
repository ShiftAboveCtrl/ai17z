import { describe, expect, it } from 'vitest';
import { asksAboutTheAgent, whatToResearch, worthPlanning } from '@xbam/runtime';

/**
 * A question about the agent is answered from the agent.
 *
 * Every text in the self cohort of the response benchmark went to the web and
 * then to the planner: "right now" and "this week" read as current, and a
 * question naming nothing fell through to searching its own words. The answer
 * to "what are you working on?" is in the agent's memory and persona, and a
 * search engine can only return somebody else's.
 */

const lookups = (incoming: string, parent: string | null = null) =>
  whatToResearch({ incoming, parent, hasUnreadMedia: false });

describe('a question about the agent itself', () => {
  it.each([
    '@agent what are you working on right now?',
    '@agent what did you learn this week?',
    '@agent what are you curious about?',
    '@agent what have you been thinking about lately?',
    '@agent what do you care about most?',
  ])('is not looked up: %s', (text) => {
    expect(lookups(text)).toEqual([]);
  });

  it('asks the planner nothing either', () => {
    const incoming = '@agent what are you working on right now?';
    expect(
      worthPlanning({ incoming, parent: null, hasMedia: false, links: [], deterministic: lookups(incoming) }),
    ).toBe(false);
  });

  it.each([
    '@agent what is the price of ETH right now?',
    '@agent what happened in crypto news today?',
    '@agent what is your take on the ETH price today?',
  ])('does not stop a current question being looked up: %s', (text) => {
    expect(lookups(text).length).toBeGreaterThan(0);
  });

  it('only counts a question that names nothing outside the agent', () => {
    expect(asksAboutTheAgent('what are you curious about?')).toBe(true);
    expect(asksAboutTheAgent('what do you think of Uniswap v4?')).toBe(false);
    expect(asksAboutTheAgent('what is the weather today?')).toBe(false);
    // "your" inside a word is not the agent.
    expect(asksAboutTheAgent('what is the yourtown population?')).toBe(false);
  });
});
