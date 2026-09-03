import { describe, expect, it } from 'vitest';
import { questionsIn, whatToResearch } from '@xbam/runtime';

const queries = (subject: Parameters<typeof whatToResearch>[0]) =>
  whatToResearch(subject).map((l) => `${l.kind}:${l.query}`);
const searched = (subject: Parameters<typeof whatToResearch>[0]) =>
  whatToResearch(subject).some((l) => l.kind === 'search');

/**
 * Every input in this file is one @ai17zOS actually received between 2 and 3
 * September 2026, and every expectation is what the trace shows it did instead.
 *
 * The plan in hand called for a better query planner. The trace said the
 * queries were not the problem: research declined three times out of four, and
 * of the 29 lookups it did send, only 2 came back empty. What was wrong was
 * *what it was handed as the subject*.
 */
describe('what research is given as its subject', () => {
  describe('the agent must not research its own words', () => {
    // Ava sent both of these sentences to a search engine, as questions. They
    // are her own replies: when somebody answers the agent, the post they are
    // replying to is the agent's.
    const ownReplies = [
      "I'm an AI agent, I can't edit or fix websites.",
      "I can't see the Gecko listing from here, so I don't know what it shows.",
    ];

    for (const reply of ownReplies) {
      it(`does not look up ${JSON.stringify(reply.slice(0, 34))}...`, () => {
        expect(queries({ incoming: 'so what now?', parent: reply, parentIsOwn: true })).toEqual([]);
      });
    }

    it('looks up nothing at all when the vague question points back at us', () => {
      // "what about that?" refers to the agent's own reply. There is nothing
      // here for a search engine, and searching the vague question itself
      // returns whatever those five words happen to collocate with.
      expect(queries({ incoming: 'so what now?', parent: 'I only answer what I can check.', parentIsOwn: true })).toEqual([]);
    });

    it('still researches a parent somebody else wrote', () => {
      // The guard has to be about authorship, not about parents in general:
      // "what is this about" is a real question and the parent is the answer.
      expect(searched({ incoming: 'wait what is this about?', parent: 'The Fed raised rates again this morning.' })).toBe(true);
    });

    it('answers a real question in their message even when the parent is ours', () => {
      const found = queries({
        incoming: 'what did the Fed decide this morning?',
        parent: 'I only answer what I can check.',
        parentIsOwn: true,
      });
      expect(found.some((q) => q.includes('Fed'))).toBe(true);
    });
  });

  describe('two requests, one question mark', () => {
    const real =
      'Hey @ai17zos how are you feeling about this post, also could you get me the weather details for new york city on septemeber 3rd?';

    it('reads that as two questions, not one', () => {
      expect(questionsIn(real)).toEqual([
        'Hey how are you feeling about this post',
        'could you get me the weather details for new york city on septemeber 3rd',
      ]);
    });

    it('looks up the weather, which the reply that went out never mentioned', () => {
      // Before: the merged question said "this post", so the whole thing was
      // discarded as referring to something already on screen, and the half
      // that needed the web was silenced by the half that did not.
      const found = queries({ incoming: real, parent: 'ai17z is undervalued tech here' });
      expect(found.some((q) => /weather/i.test(q))).toBe(true);
    });

    it('asks about the weather and not about how it feels', () => {
      const found = queries({ incoming: real, parent: 'ai17z is undervalued tech here' });
      expect(found.every((q) => !/feeling/i.test(q))).toBe(true);
    });

    it('does not split a sentence that merely contains "and"', () => {
      expect(questionsIn('what is the difference between a policy and a persona?')).toEqual([
        'what is the difference between a policy and a persona',
      ]);
    });
  });

  describe('a reaction is not an information need', () => {
    // Each of these cost a browser round trip on the research tab and returned
    // something that then entered the prompt as evidence: a dictionary entry
    // for "hey", and a Red Hot Chili Peppers video.
    for (const filler of ['WHAT THE HELL?!?', 'WHAT THE HELL?', 'hey.', 'Right.', 'Yoo', 'gud tek', 'Its gonna be amazing']) {
      it(`does not search ${JSON.stringify(filler)}`, () => {
        expect(queries({ incoming: filler })).toEqual([]);
      });
    }

    it('still answers a question that merely opens with a greeting', () => {
      expect(searched({ incoming: 'hey what did the Fed decide today?' })).toBe(true);
    });

    it('still answers a polite request that names something checkable', () => {
      expect(searched({ incoming: 'could you check the current price of $AI17Z' })).toBe(true);
    });

    it('does not treat an instruction to post as a question', () => {
      expect(queries({ incoming: '@ai17zOS make another individual post' })).toEqual([]);
      expect(queries({ incoming: '@ai17zOS post about how undervalued the coin is' })).toEqual([]);
    });
  });

  describe('the ordinary case is still silence', () => {
    for (const praise of [
      '@ai17zOS holy shit tech is tuff asf. I love you.',
      'It’s crazy cause this has no hype around it but it’s sick.',
      '@ai17zOS this is lowkey crazy',
      'You should check @ai17zOS',
    ]) {
      it(`says nothing needs looking up for ${JSON.stringify(praise.slice(0, 30))}...`, () => {
        expect(queries({ incoming: praise })).toEqual([]);
      });
    }
  });
});
