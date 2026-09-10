/**
 * What a lot of people have started talking about, and how confident that is.
 *
 * Not the same thing as `arcs.ts`, which follows one conversation the agent is
 * in. This looks across everything the agent read -- a timeline, a search, a
 * list -- and asks whether some subject is rising. Nothing here is per-thread
 * and nothing here is about the agent.
 *
 * The failure mode is obvious and worth naming: any bag of text will produce a
 * ranked list of words, and a ranked list of words looks exactly like an
 * insight. Three refusals keep it from being one.
 *
 * - **One account repeating itself is not a narrative.** A term needs several
 *   distinct authors before it is reported, because otherwise the top result is
 *   whoever posted most this morning.
 * - **Share, not count.** Reading twice as many posts produces twice as many
 *   mentions of everything, which reads as everything rising.
 * - **A rise needs a before.** With nothing older to compare against, a term is
 *   reported as present rather than as rising, and the difference is stated.
 */

/** A post as this reader needs it. */
export interface NarrativePost {
  statusId: string;
  handle: string;
  text: string;
  /** ISO. A post without one cannot be placed in a window and is skipped. */
  postedAt?: string;
}

export interface Narrative {
  term: string;
  /** Distinct accounts that used it in the recent window. */
  authors: number;
  mentions: number;
  /** Share of recent posts that mention it, 0 to 1. */
  share: number;
  /** Share in the window before, where there was one. */
  priorShare?: number;
  /**
   * How much the share moved. Absent when there was nothing to compare with.
   *
   * Always a finite number. A term that was not said at all before has no
   * meaningful ratio, and putting `Infinity` here would serialise to `null` --
   * indistinguishable from "not computed" by the time it reached a screen.
   * That case is `newlySeen` instead.
   */
  lift?: number;
  /** True when the term was in the earlier window not at all. */
  newlySeen?: boolean;
  /** A few of the accounts saying it, so an owner can go and look. */
  examples: string[];
  detail: string;
}

export interface NarrativeReading {
  narratives: Narrative[];
  gaps: string[];
  /** How many posts could be placed in a window at all. */
  considered: number;
}

/** Fewer accounts than this and it is somebody's hobby horse, not a narrative. */
const MIN_AUTHORS = 3;

/** Below this many posts in the recent window, no claim is worth making. */
const MIN_RECENT_POSTS = 12;

/** How much the share has to move before "rising" is the right word. */
const RISING_LIFT = 1.5;

/**
 * Words that carry no subject.
 *
 * Deliberately short and general. A long hand-tuned list is a way of deciding
 * the answer in advance, and every term removed here is a narrative that can
 * never be detected. X's own furniture is included -- "rt", "via" -- because
 * those are about the platform rather than about anything.
 */
const STOP_WORDS = new Set(
  `a about after all also am an and any are as at be been before being but by can cant could did do does doing dont down each else for from get got had has have he her here hers him his how i if in into is it its just like me more most much my no nor not now of off on once one only or other our out over own re rt said same she should so some still such than that the their them then there these they this those through to too under until up us very via was we were what when where which while who whom why will with would you your yours yeah yes ok okay im ive its lol thanks thank please really new`
    .split(/\s+/)
    .filter(Boolean),
);

/** The shortest word this will treat as a subject. */
const MIN_TERM_LENGTH = 3;

/**
 * The subjects in one post.
 *
 * Cashtags and hashtags are kept whole and with their sign, because `$eth` and
 * the word "eth" are different claims and collapsing them loses which was
 * written. Everything else is lower-cased words with the punctuation removed.
 * Handles are dropped: who was mentioned is a relationship fact, not a subject,
 * and leaving them in makes every popular account look like a narrative.
 */
export function termsIn(text: string): string[] {
  const terms = new Set<string>();
  const cleaned = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]{1,15}/g, ' ');
  for (const match of cleaned.matchAll(/[$#]?[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    const raw = match[0]!;
    const tagged = /^[$#]/.test(raw);
    const term = tagged ? raw.toLowerCase() : raw.toLowerCase().replace(/['’]s$/, '');
    const bare = term.replace(/^[$#]/, '');
    if (bare.length < MIN_TERM_LENGTH) continue;
    if (!tagged && STOP_WORDS.has(bare)) continue;
    if (/^\d+$/.test(bare)) continue;
    terms.add(term);
  }
  return [...terms];
}

interface Bucket {
  posts: number;
  byTerm: Map<string, { mentions: number; authors: Set<string> }>;
}

function bucketOf(posts: NarrativePost[]): Bucket {
  const bucket: Bucket = { posts: 0, byTerm: new Map() };
  for (const post of posts) {
    bucket.posts += 1;
    const handle = post.handle.replace(/^@+/, '').toLowerCase();
    // Counted once per post: a post that says "restaking" four times is one
    // account saying it, and rewarding repetition rewards spam.
    for (const term of termsIn(post.text)) {
      const entry = bucket.byTerm.get(term) ?? { mentions: 0, authors: new Set<string>() };
      entry.mentions += 1;
      entry.authors.add(handle);
      bucket.byTerm.set(term, entry);
    }
  }
  return bucket;
}

export function readNarratives(
  posts: NarrativePost[],
  options: { now?: Date; windowHours?: number; limit?: number } = {},
): NarrativeReading {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? 6;
  const limit = options.limit ?? 8;
  const gaps: string[] = [];

  const recent: NarrativePost[] = [];
  const prior: NarrativePost[] = [];
  let undated = 0;
  for (const post of posts) {
    if (!post.postedAt) {
      undated += 1;
      continue;
    }
    const ageHours = (now.getTime() - new Date(post.postedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours < 0) {
      undated += 1;
      continue;
    }
    if (ageHours <= windowHours) recent.push(post);
    else if (ageHours <= windowHours * 2) prior.push(post);
  }
  if (undated > 0) {
    gaps.push(`${undated} post${undated === 1 ? '' : 's'} had no timestamp and could not be placed in a window.`);
  }

  if (recent.length < MIN_RECENT_POSTS) {
    gaps.push(
      `Only ${recent.length} post${recent.length === 1 ? '' : 's'} in the last ${windowHours} hours; ${MIN_RECENT_POSTS} is the fewest worth drawing anything from.`,
    );
    return { narratives: [], gaps, considered: recent.length + prior.length };
  }

  const recentBucket = bucketOf(recent);
  const priorBucket = prior.length > 0 ? bucketOf(prior) : null;
  if (!priorBucket) {
    gaps.push('Nothing older was read, so these are subjects that are present rather than subjects that are rising.');
  }

  const narratives: Narrative[] = [];
  for (const [term, entry] of recentBucket.byTerm) {
    if (entry.authors.size < MIN_AUTHORS) continue;
    const share = entry.mentions / recentBucket.posts;
    const priorEntry = priorBucket?.byTerm.get(term);
    const priorShare = priorBucket ? (priorEntry?.mentions ?? 0) / priorBucket.posts : undefined;
    const newlySeen = priorShare !== undefined && priorShare === 0;
    const lift =
      priorShare === undefined || newlySeen ? undefined : Number((share / priorShare).toFixed(2));

    const rising = lift !== undefined && lift >= RISING_LIFT;
    const examples = [...entry.authors].slice(0, 3);
    narratives.push({
      term,
      authors: entry.authors.size,
      mentions: entry.mentions,
      share: Number(share.toFixed(3)),
      ...(priorShare === undefined ? {} : { priorShare: Number(priorShare.toFixed(3)) }),
      ...(lift === undefined ? {} : { lift }),
      ...(newlySeen ? { newlySeen: true } : {}),
      examples,
      detail: newlySeen
        ? `"${term}" was not mentioned in the previous ${windowHours} hours and is now in ${entry.mentions} of ${recentBucket.posts} posts, from ${entry.authors.size} accounts.`
        : lift === undefined
          ? `${entry.authors.size} accounts mentioned "${term}" in ${entry.mentions} of ${recentBucket.posts} posts.`
          : rising
            ? `"${term}" is in ${Math.round(share * 100)}% of posts, up from ${Math.round((priorShare ?? 0) * 100)}%, from ${entry.authors.size} accounts.`
            : `"${term}" is in ${Math.round(share * 100)}% of posts, against ${Math.round((priorShare ?? 0) * 100)}% before.`,
    });
  }

  // Newly said first, then rising, then how widely held. A term one account
  // repeated is already excluded; among the rest, more accounts is a stronger
  // claim than more posts.
  narratives.sort((a, b) => {
    if (Boolean(a.newlySeen) !== Boolean(b.newlySeen)) return a.newlySeen ? -1 : 1;
    const liftA = a.lift ?? 1;
    const liftB = b.lift ?? 1;
    if (liftA !== liftB) return liftB - liftA;
    return b.authors - a.authors || b.share - a.share || a.term.localeCompare(b.term);
  });

  return { narratives: narratives.slice(0, limit), gaps, considered: recent.length + prior.length };
}
