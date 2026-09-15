/**
 * What somebody's recent posts say about them, and how much of it is worth
 * claiming.
 *
 * The X intelligence layer answers "here are two hundred posts". This is the
 * step that turns that into something an owner can read in ten seconds --
 * what they write about, how often, how much of it is conversation -- without
 * any of it becoming a claim the evidence does not support.
 *
 * ### Pure, and channel-agnostic on purpose
 *
 * Nothing here knows what X looks like. It takes a shape any timeline can be
 * mapped into, so the judgements can be tested against fixtures rather than
 * against a browser, and so a second channel would not need a second copy of
 * "what does this person post about".
 *
 * ### Every number carries what it rests on
 *
 * `docs/ENGINEERING.md`: a score without its reasons is not shippable. The
 * failure this prevents is specific and easy: four posts are enough to produce
 * a confident sentence about somebody's interests, and somebody will act on it.
 * So `sampleSize` travels with every reading and `confident` is false below a
 * floor -- the screen says "from 6 posts" rather than saying it quietly.
 *
 * ### Absent is never zero
 *
 * A reader that could not see engagement counts reports none, and this reports
 * none in turn. An account whose posts nobody has counted and an account whose
 * posts nobody liked must not look the same.
 */

/** One post, as this reader needs to see it. Deliberately not `XPostRecord`. */
export interface ReadPost {
  id: string;
  text: string;
  /** ISO. Absent means the reader could not see when it was written. */
  createdAt?: string | null;
  url?: string | null;
  /** Written as an answer to somebody. */
  reply?: boolean;
  /** A remark attached to somebody else's post. */
  quote?: boolean;
  /** Only what was actually counted. An absent count was not observed. */
  likes?: number | null;
  replies?: number | null;
  views?: number | null;
}

export interface TopicCount {
  /** As written, so a screen shows "#solana" rather than "solana". */
  term: string;
  count: number;
}

export interface AccountReading {
  /** How many posts everything below rests on. */
  sampleSize: number;
  /**
   * Whether the sample is big enough to say any of this out loud.
   *
   * Not a confidence score. A boolean, because the only useful thing a screen
   * can do with "we read six posts" is say so.
   */
  confident: boolean;
  /** What keeps coming up, most frequent first. */
  topics: TopicCount[];
  /** Hashtags, kept separate: somebody choosing a tag is a stronger signal. */
  hashtags: TopicCount[];
  /** Accounts they keep talking to or about. */
  mentions: TopicCount[];
  /** How much of what they write is conversation rather than announcement. */
  mix: { posts: number; replies: number; quotes: number };
  /** Posts per day across the window actually observed, or null if undatable. */
  postsPerDay: number | null;
  /** The span the sample covers. Null when nothing carried a date. */
  earliest: string | null;
  latest: string | null;
  /**
   * The middle of what their posts get, from the ones that carried counts.
   *
   * Median rather than mean, for the same reason market data is: one post that
   * went unusually far moves a mean and tells you nothing about the others.
   * Null when no post in the sample carried a count.
   */
  typicalLikes: number | null;
  typicalReplies: number | null;
  /** How many posts the engagement figures rest on, which is rarely all of them. */
  engagementSampleSize: number;
  /** A few of their posts, as evidence for everything above. */
  examples: { id: string; text: string; createdAt: string | null; url: string | null }[];
  /** What this reading could not establish, in words. */
  gaps: string[];
}

/**
 * Below this, a summary of somebody's interests is a guess about somebody.
 *
 * Chosen against what the topic counter can do rather than picked round: a term
 * has to appear three times to be counted at all, so under about twenty posts
 * the only terms that clear it are ones the person used in half of everything
 * they wrote -- which is a sample artefact, not a topic.
 */
export const CONFIDENT_SAMPLE = 20;

/** A term has to recur to be a topic. Once is a word, not an interest. */
const MIN_TOPIC_USES = 3;

/** How many of each list is worth showing. Past this it is a word cloud. */
const TOP_N = 10;

const EXAMPLES = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Words too common to mean anything, in the places this counts them.
 *
 * Deliberately short. A long stop list starts deciding what somebody is allowed
 * to be interested in, and the recurrence floor already removes most of this.
 */
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'any', 'are', 'because', 'been', 'before', 'being',
  'but', 'can', 'could', 'did', 'does', 'doing', 'dont', 'down', 'each', 'even', 'ever', 'every',
  'for', 'from', 'get', 'gets', 'got', 'had', 'has', 'have', 'here', 'how', 'into', 'its', 'just',
  'like', 'made', 'make', 'many', 'more', 'most', 'much', 'never', 'new', 'not', 'now', 'off',
  'one', 'only', 'other', 'our', 'out', 'over', 'own', 'really', 'same', 'see', 'should',
  'since', 'some', 'still', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'thing', 'things', 'think', 'this', 'those', 'through', 'time', 'too', 'two',
  'use', 'very', 'want', 'was', 'way', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'rt', 'https', 'http',
]);

function rank(counts: Map<string, { term: string; count: number }>, floor: number): TopicCount[] {
  return [...counts.values()]
    .filter((entry) => entry.count >= floor)
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, TOP_N);
}

function bump(counts: Map<string, { term: string; count: number }>, term: string): void {
  const key = term.toLowerCase();
  const entry = counts.get(key);
  if (entry) entry.count += 1;
  else counts.set(key, { term, count: 1 });
}

/** The middle value, or null when there is nothing to take the middle of. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function readAccount(posts: ReadPost[]): AccountReading {
  const words = new Map<string, { term: string; count: number }>();
  const hashtags = new Map<string, { term: string; count: number }>();
  const mentions = new Map<string, { term: string; count: number }>();
  const mix = { posts: 0, replies: 0, quotes: 0 };
  const dates: number[] = [];
  const likes: number[] = [];
  const replies: number[] = [];
  let counted = 0;

  for (const post of posts) {
    if (post.reply) mix.replies += 1;
    else if (post.quote) mix.quotes += 1;
    else mix.posts += 1;

    if (post.createdAt) {
      const at = new Date(post.createdAt).getTime();
      if (Number.isFinite(at)) dates.push(at);
    }

    // Only posts that actually carried a count contribute to the middle of
    // what their posts get. Treating an unread count as zero would drag every
    // figure towards nothing and make a busy account look ignored.
    let hadCount = false;
    if (typeof post.likes === 'number') {
      likes.push(post.likes);
      hadCount = true;
    }
    if (typeof post.replies === 'number') {
      replies.push(post.replies);
      hadCount = true;
    }
    if (hadCount) counted += 1;

    for (const tag of post.text.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)) bump(hashtags, `#${tag[1]}`);
    for (const at of post.text.matchAll(/@([A-Za-z0-9_]{1,15})/g)) bump(mentions, `@${at[1]}`);

    // Links and the markup around them are not what somebody writes about.
    const prose = post.text
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[@#][\p{L}\p{N}_]+/gu, ' ');
    for (const match of prose.matchAll(/[\p{L}][\p{L}\p{N}'’-]{2,}/gu)) {
      const word = match[0]!;
      if (STOP_WORDS.has(word.toLowerCase())) continue;
      bump(words, word);
    }
  }

  const earliest = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
  const latest = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;

  // Over the window the sample actually covers, not over "recently". An
  // account read across two years and one read across two days both produce a
  // rate, and only one of them is a rate about now -- so the span travels with
  // it and the screen can say which.
  let postsPerDay: number | null = null;
  if (dates.length >= 2) {
    const spanDays = (Math.max(...dates) - Math.min(...dates)) / DAY_MS;
    postsPerDay = spanDays >= 0.5 ? Math.round((dates.length / spanDays) * 10) / 10 : dates.length;
  }

  const gaps: string[] = [];
  if (posts.length === 0) gaps.push('Nothing of theirs could be read.');
  if (dates.length < posts.length) {
    gaps.push(`${posts.length - dates.length} of the posts read did not say when they were written.`);
  }
  if (counted === 0 && posts.length > 0) {
    gaps.push('The reader could not see engagement counts, so how their posts do is not known.');
  }
  if (posts.length > 0 && posts.length < CONFIDENT_SAMPLE) {
    gaps.push(`This rests on ${posts.length} post${posts.length === 1 ? '' : 's'}, which is a small sample.`);
  }

  return {
    sampleSize: posts.length,
    confident: posts.length >= CONFIDENT_SAMPLE,
    topics: rank(words, MIN_TOPIC_USES),
    // A hashtag is a deliberate label rather than a word that happened to
    // recur, so one use of it counts where one use of a word does not.
    hashtags: rank(hashtags, 1),
    mentions: rank(mentions, 2),
    mix,
    postsPerDay,
    earliest,
    latest,
    typicalLikes: median(likes),
    typicalReplies: median(replies),
    engagementSampleSize: counted,
    examples: posts.slice(0, EXAMPLES).map((post) => ({
      id: post.id,
      text: post.text,
      createdAt: post.createdAt ?? null,
      url: post.url ?? null,
    })),
    gaps,
  };
}
