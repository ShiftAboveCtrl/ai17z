import { describe, expect, it } from 'vitest';
import { readNarratives, termsIn, type NarrativePost } from '@xbam/runtime';

/**
 * Detecting what a lot of people have started talking about.
 *
 * Any bag of text produces a ranked list of words, and a ranked list of words
 * looks exactly like an insight. These tests pin the three refusals that keep
 * this from being one: one account repeating itself is not a narrative, a
 * bigger read is not a rising narrative, and a rise needs something to have
 * risen from.
 */

const now = new Date('2026-09-09T12:00:00.000Z');
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();

/** n posts, each from a different account, saying the same thing. */
const chorus = (text: string, n: number, ago: number, prefix = 'acct'): NarrativePost[] =>
  Array.from({ length: n }, (_, i) => ({
    statusId: `${prefix}-${ago}-${i}`,
    handle: `${prefix}${i}`,
    text,
    postedAt: hoursAgo(ago),
  }));

describe('the subjects in a post', () => {
  it('keeps a cashtag whole and distinct from the bare word', () => {
    // "$eth" and "eth" are different claims, and collapsing them loses which
    // was written.
    expect(termsIn('watching $ETH here')).toContain('$eth');
    expect(termsIn('watching $ETH here')).not.toContain('eth');
  });

  it('drops handles, links and the words that carry no subject', () => {
    const terms = termsIn('thanks @alice for this https://example.com/a rollups are the thing');
    expect(terms).not.toContain('alice');
    expect(terms).not.toContain('thanks');
    expect(terms).not.toContain('https');
    expect(terms).toContain('rollups');
  });

  it('counts a word once per post however often it was written', () => {
    // Rewarding repetition rewards spam.
    expect(termsIn('rollups rollups rollups').filter((t) => t === 'rollups')).toHaveLength(1);
  });
});

describe('reading narratives', () => {
  it('will not call one account repeating itself a narrative', () => {
    const posts: NarrativePost[] = Array.from({ length: 14 }, (_, i) => ({
      statusId: `s${i}`,
      handle: 'loudaccount',
      text: 'restaking is the only thing that matters',
      postedAt: hoursAgo(1),
    }));
    const { narratives } = readNarratives(posts, { now });
    expect(narratives.find((n) => n.term === 'restaking')).toBeUndefined();
  });

  it('reports a subject several accounts are using', () => {
    const { narratives } = readNarratives(
      [...chorus('restaking yields are compressing', 14, 1)],
      { now },
    );
    const found = narratives.find((n) => n.term === 'restaking');
    expect(found).toBeDefined();
    expect(found!.authors).toBe(14);
    expect(found!.examples.length).toBeGreaterThan(0);
  });

  it('says nothing at all from too few posts', () => {
    const { narratives, gaps } = readNarratives(chorus('restaking again', 4, 1), { now });
    expect(narratives).toHaveLength(0);
    expect(gaps.join(' ')).toMatch(/fewest worth drawing/);
  });

  it('says these are present, not rising, when nothing older was read', () => {
    const { narratives, gaps } = readNarratives(chorus('restaking yields are compressing', 14, 1), { now });
    expect(gaps.join(' ')).toMatch(/present rather than/);
    expect(narratives[0]!.lift).toBeUndefined();
    expect(narratives[0]!.detail).toMatch(/accounts mentioned/);
  });

  it('measures share rather than count, so a bigger read is not a rising narrative', () => {
    // Twice as many posts means twice as many mentions of everything. The
    // share is unchanged and so is the verdict.
    const small = readNarratives(
      [...chorus('restaking yields compressing', 7, 1), ...chorus('unrelated musings about coffee beans', 7, 1, 'other')],
      { now },
    );
    const big = readNarratives(
      [
        ...chorus('restaking yields compressing', 14, 1),
        ...chorus('unrelated musings about coffee beans', 14, 1, 'other'),
      ],
      { now },
    );
    expect(small.narratives.find((n) => n.term === 'restaking')!.share).toBeCloseTo(
      big.narratives.find((n) => n.term === 'restaking')!.share,
      3,
    );
  });

  it('calls something that was not there before what it is', () => {
    const { narratives } = readNarratives(
      [
        ...chorus('sequencer downtime again', 14, 1),
        ...chorus('quiet morning reading the docs', 14, 8, 'earlier'),
      ],
      { now },
    );
    const found = narratives.find((n) => n.term === 'sequencer');
    // A flag rather than an infinite ratio: `Infinity` serialises to `null`,
    // which by the time it reaches a screen is indistinguishable from a lift
    // nobody computed.
    expect(found!.newlySeen).toBe(true);
    expect(found!.lift).toBeUndefined();
    expect(found!.detail).toMatch(/was not mentioned in the previous/);
  });

  it('puts what is rising above what is merely large', () => {
    const { narratives } = readNarratives(
      [
        // Steady: same share before and after.
        ...chorus('rollups are interesting today', 14, 1),
        ...chorus('rollups are interesting today', 14, 8, 'earlier'),
        // New: only in the recent window.
        ...chorus('sequencer downtime again', 12, 2, 'newish'),
      ],
      { now },
    );
    // Rollups is in more posts and by more accounts. Sequencer is the one that
    // was not being said this morning, which is the whole question.
    const rank = (term: string) => narratives.findIndex((n) => n.term === term);
    expect(rank('sequencer')).toBeGreaterThanOrEqual(0);
    expect(rank('sequencer')).toBeLessThan(rank('rollups'));
  });

  it('says how many posts it could not place', () => {
    const { gaps } = readNarratives(
      [...chorus('restaking yields compressing', 14, 1), { statusId: 'x', handle: 'a', text: 'no timestamp here' }],
      { now },
    );
    expect(gaps.join(' ')).toMatch(/had no timestamp/);
  });
});

describe('counting voices rather than names', () => {
  /*
    The radar reads X's own data now, so a discovered post carries its author's
    immutable id. Counting by handle made one person two the moment they
    renamed themselves -- and "several accounts are saying this" is the only
    thing that separates a narrative from a loud account, so the inflation
    lands precisely where it does harm.
  */
  const withIds = (n: number, text: string): NarrativePost[] =>
    Array.from({ length: n }, (_, i) => ({
      statusId: `id-${i}`,
      handle: `acct${i}`,
      authorId: `${900 + i}`,
      text,
      postedAt: hoursAgo(1),
    }));

  it('names the examples by handle, never by the identity it counted with', () => {
    /*
      The examples line is written as `@name`, and what it was given was the
      identity key: the numeric id wherever there was one. So an account whose
      id was known rendered as `@900` on a screen that reads "326 accounts,
      including ...".

      Identity and display are different questions. Counting has to prefer the
      id, because a handle changes and the same person then counts twice.
      Naming has to prefer the handle, because that is the only half a person
      recognises.
    */
    const posts = withIds(13, 'restaking yields are compressing');
    const found = readNarratives(posts, { now }).narratives.find((n) => n.term === 'restaking');
    expect(found).toBeDefined();
    expect(found!.examples.length).toBeGreaterThan(0);
    for (const example of found!.examples) {
      expect(example).toMatch(/^acct\d+$/);
      expect(example).not.toMatch(/^\d+$/);
    }
  });

  it('does not turn an author it could not identify into an account', () => {
    /*
      Seen on ai17z-test: "326 accounts, including @_anika_7, @, @nathanoyler".

      That bare `@` is a post carrying neither an id nor a handle. It became an
      empty string, the empty string went into the set that answers "how many
      accounts", and it was then rendered as somebody's name. Absent is not an
      account here for the same reason absent is never zero anywhere else in
      this codebase.
    */
    const posts = chorus('restaking yields are compressing', 13, 1);
    posts.push({
      statusId: 'nameless',
      handle: '',
      text: 'restaking yields are compressing',
      postedAt: hoursAgo(1),
    });

    const found = readNarratives(posts, { now }).narratives.find((n) => n.term === 'restaking');
    expect(found).toBeDefined();
    // Fourteen posts, thirteen accounts anybody could name.
    expect(found!.mentions).toBe(14);
    expect(found!.authors).toBe(13);
    expect(found!.examples).not.toContain('');
  });

  it('counts somebody who renamed themselves mid-window once', () => {
    const posts = withIds(13, 'restaking yields are compressing');
    // The fourteenth post is the first author again, under a new handle.
    posts.push({
      statusId: 'renamed',
      handle: 'acct0_eth',
      authorId: '900',
      text: 'restaking yields are compressing',
      postedAt: hoursAgo(1),
    });

    const found = readNarratives(posts, { now }).narratives.find((n) => n.term === 'restaking');
    expect(found).toBeDefined();
    // Thirteen people, fourteen posts, fourteen handles.
    expect(found!.authors).toBe(13);
    expect(found!.mentions).toBe(14);
  });

  it('still counts by handle for a post that carries no id', () => {
    // Anything discovered before the radar read X's own data, or read off a
    // rendered page, has no id. Its author must still be counted.
    const found = readNarratives(chorus('restaking yields are compressing', 14, 1), { now }).narratives.find(
      (n) => n.term === 'restaking',
    );
    expect(found!.authors).toBe(14);
  });
});
