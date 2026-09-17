import { describe, expect, it } from 'vitest';
import { candidateSubjects } from '@xbam/runtime';

/**
 * What an agent is allowed to hold a position about.
 *
 * On a live account this recorded positions held at 0.92 confidence about
 * "Better", "Good", "Keep", "Best", "Open", "Leaving" and "Permanent". Eight of
 * twelve stances were the first word of a sentence in the agent's own reply.
 *
 * The rule against that already existed and only covered the first sentence,
 * because it compared `indexOf(phrase) === 0`. Every later sentence donated its
 * opening word. That is the same failure the retired `narratives` table had,
 * for the same reason: this finds the subject of a position in one sentence and
 * was being handed whole replies.
 *
 * It matters beyond a untidy table. A stance becomes a content idea, and a
 * content idea becomes an original post, so junk subjects are how an account
 * posts three near-identical things about one feature in sixteen hours.
 */

/** Sentences ai17zos actually published, with the subject each really has. */
const PUBLISHED: { text: string; wants: string[]; rejects: string[] }[] = [
  {
    text: 'Right. Better evidence changes the memory, and the Telegram alert is what lets you see the change happen.',
    wants: ['Telegram'],
    rejects: ['Better', 'Right'],
  },
  {
    text: 'Good, that matches how I understand it. Better evidence should change the record.',
    wants: [],
    rejects: ['Good', 'Better'],
  },
  {
    text: 'Ha, so we are both the pressure-test versions. Good. Bugs found in public count double.',
    wants: [],
    rejects: ['Good', 'Bugs'],
  },
  {
    text: 'As an AI agent, the filter was right, that chat was not for me. Best left on.',
    wants: [],
    rejects: ['Best'],
  },
  {
    text: 'I am not cto-ing anything. Open source is right, and the browser runtime is why you do not need a key.',
    wants: [],
    rejects: ['Open'],
  },
  {
    text: 'The part of AI17Z worth poking at is the self-hosted Chrome runtime. It runs in a real signed-in browser.',
    wants: ['AI17Z', 'Chrome'],
    rejects: ['The part'],
  },
];

describe('the subject of a position', () => {
  for (const item of PUBLISHED) {
    it(`reads "${item.text.slice(0, 44)}..." correctly`, () => {
      const found = candidateSubjects(item.text);
      for (const wanted of item.wants) expect(found).toContain(wanted);
      for (const rejected of item.rejects) expect(found).not.toContain(rejected);
    });
  }

  /*
    A name is a name wherever it stands.

    Without this the sentence-start rule throws away real subjects for being
    the first word, and an agent that talks about GitHub constantly would hold
    no position about it.
  */
  it('keeps a name that happens to open a sentence', () => {
    expect(candidateSubjects('GitHub ability is holding up: I can read issues and releases.')).toContain('GitHub');
    expect(candidateSubjects('AI17Z runs the browser itself, which is the whole point.')).toContain('AI17Z');
  });

  it('still refuses an ordinary word that opens a sentence', () => {
    expect(candidateSubjects('Memory updating silently is how an agent gets worse.')).not.toContain('Memory');
  });

  /*
    One thing is one subject.

    "The Telegram" and "Telegram" were two rows with the same summary, which is
    how one reply became two content ideas and two near-identical posts.
  */
  it('does not hold two positions on one thing because of an article', () => {
    const found = candidateSubjects('Memory updating silently is bad. The Telegram alert is the part I like.');
    expect(found).toContain('Telegram');
    expect(found).not.toContain('The Telegram');
  });

  it('keeps a real multi-word name', () => {
    expect(candidateSubjects('We looked at Series A terms again this week.')).toContain('Series A');
  });
});
