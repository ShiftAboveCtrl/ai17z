import { describe, expect, it } from 'vitest';
import { isSelfPromotion, judgePost, whyNotLearnable } from '@xbam/runtime';

const SELF = ['ai17z', 'ai17zOS', 'AI17Z'];

/*
  Shapes of what ai17z-main actually posted, rewritten: feature announcements
  on repeat, a reply echoed back as a post, and the same post twice.
*/
describe('whether an original post is worth posting', () => {
  it('lets a real thought through', () => {
    const verdict = judgePost({
      draft: 'Half the "autonomous" agents on here stop working the moment their operator goes to sleep, which says more about the operators than the agents.',
      source: 'reflection on agents going quiet overnight',
      recentPosts: ['gas was weirdly cheap on L2 this morning and nobody noticed'],
      selfNames: SELF,
    });
    expect(verdict.post).toBe(true);
  });

  it('refuses another feature announcement when the last few were too', () => {
    const recent = [
      'The part of AI17Z worth poking at is the self-hosted Chrome runtime on your own machine.',
      'AI17Z memory updates show up as a Telegram alert, so you can audit the runtime.',
    ];
    const verdict = judgePost({
      draft: 'AI17Z runs in a real signed-in browser on your own machine, no API key needed. That runtime is the feature.',
      source: 'x',
      recentPosts: recent,
      selfNames: SELF,
    });
    expect(verdict.post).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/about the product itself/);
  });

  it('refuses a post that repeats a recent one', () => {
    const verdict = judgePost({
      draft: 'Silent memory edits are how an agent quietly drifts from what actually happened.',
      source: 'x',
      recentPosts: ['Silent memory edits are how an agent quietly drifts from what actually happened, so log them.'],
      selfNames: SELF,
    });
    expect(verdict.post).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/too close/);
  });

  it('refuses an echo of what it was written from', () => {
    const source = 'Right. Better evidence changes the memory, and the alert is what lets you see the change instead of it happening silently.';
    const verdict = judgePost({ draft: source, source, recentPosts: [], selfNames: SELF });
    expect(verdict.post).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/repeats what it was written from/);
  });

  it('refuses engagement bait', () => {
    const verdict = judgePost({ draft: 'Agents are going to change everything on this app. What do you think?', source: 'x', recentPosts: [], selfNames: SELF });
    expect(verdict.post).toBe(false);
  });

  it('allows one mention of what it runs on', () => {
    expect(isSelfPromotion('Spent the morning watching people argue about agent memory. I run on AI17Z and still found it funny.', SELF)).toBe(false);
  });
});

describe('re-judging what was learned', () => {
  it('retires sentence openers, handles and positions about itself, and keeps real subjects', () => {
    expect(whyNotLearnable('Better', ['Right. Better evidence changes the memory.'], SELF)).toMatch(/opened a sentence/);
    expect(whyNotLearnable('KoreanApeSKHNX', ['@KoreanApeSKHNX ha, good vibes all round.'], SELF)).toMatch(/person/);
    expect(whyNotLearnable('AI17Z', ['The part of AI17Z worth poking at is the runtime.'], SELF)).toMatch(/itself/);
    expect(whyNotLearnable('Commander Vrax', ['Commander Vrax as a cat is the correct outcome.'], SELF)).toBeNull();
  });
});
