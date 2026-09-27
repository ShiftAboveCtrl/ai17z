import type { RepetitionScore } from '@xbam/shared/contracts';

/**
 * Noticing when the agent is repeating itself.
 *
 * An agent that reuses the same opening, the same analogy, or the same punchline
 * stops reading as a person and starts reading as a template. This measures
 * similarity against what it has recently said, so that can be caught before it
 * is published rather than noticed by somebody else afterwards.
 *
 * Deliberately several kinds of similarity rather than one number: reusing an
 * opening and reusing a whole sentence are different problems, and a person
 * looking at the result wants to know which.
 */

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[a-z0-9_]{1,15}/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return normalise(text).split(' ').filter(Boolean);
}

/** Overlapping runs of three words, which is where reuse actually shows. */
function trigrams(text: string): Set<string> {
  const list = words(text);
  const grams = new Set<string>();
  for (let i = 0; i + 2 < list.length; i += 1) {
    grams.add(`${list[i]} ${list[i + 1]} ${list[i + 2]}`);
  }
  return grams;
}

/** Proportion of the candidate's phrasing that also appears in the other text. */
function trigramOverlap(candidate: string, other: string): number {
  const a = trigrams(candidate);
  if (a.size === 0) return 0;
  const b = trigrams(other);
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / a.size;
}

/** The longest run of words the two texts share verbatim. */
function longestSharedRun(candidate: string, other: string): number {
  const a = words(candidate);
  const b = words(other);
  if (a.length === 0 || b.length === 0) return 0;

  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1]! + 1;
        if (current[j]! > best) best = current[j]!;
      }
    }
    previous = current;
  }
  return best;
}

/**
 * The first few words, as this file compares them.
 *
 * Exported so the Response Lab counts openings the way the guard does. It was
 * splitting raw text, so "I don't" and "I don’t" were two different openings
 * and seven identical ones were reported as four and three. An instrument an
 * owner reads to judge repetition must measure what the product enforces.
 */
export function opener(text: string, count = 4): string {
  return words(text).slice(0, count).join(' ');
}

/** Words too common for a run of them to be anybody's habit. */
const FUNCTION_WORDS = new Set([
  'i','me','my','you','your','it','its','the','a','an','and','or','but','to','of','in','on','at','for','with','is','are',
  'was','be','been','that','this','so','not','do','does','did','if','as','by','from','we','they','he','she','them','im',
  'dont','s','t','m','re','ll','d','ve',
  // What normalising leaves of a contraction: "don't" is "don t".
  'don','won','can','isn','doesn','didn','wasn','aren','couldn','wouldn','shouldn','haven','hasn','ain',
]);

/** How many recent outputs a phrase must appear in before it is a habit. */
export const HABIT_MIN_POSTS = 3;

/**
 * Phrases this agent keeps coming back to, across many things it said.
 *
 * The per-post comparison below cannot see this: "self hosted chrome runtime"
 * in five different replies is a small overlap with each one and a tic across
 * all of them. Measured on a live agent's published history, the same
 * three-word runs recurred in five and six replies each, and nothing had ever
 * flagged them.
 *
 * A run of three words counts only when at least one of them is not a function
 * word, so "i don t" and "it is the" are never anybody's habit. Overlapping runs
 * are reported once, as the more frequent of them.
 */
export function habitualPhrases(recent: readonly string[], minPosts = HABIT_MIN_POSTS, max = 5): { phrase: string; posts: number }[] {
  const counts = new Map<string, number>();
  for (const text of recent) {
    for (const gram of trigrams(text)) {
      if (gram.split(' ').every((w) => FUNCTION_WORDS.has(w))) continue;
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  const frequent = new Set([...counts.entries()].filter(([, n]) => n >= minPosts).map(([gram]) => gram));

  // Chain overlapping runs into the phrase they are pieces of: "the self
  // hosted", "self hosted chrome" and "hosted chrome runtime" are one habit.
  const phrases = new Set<string>();
  for (const gram of frequent) {
    let wordsOf = gram.split(' ');
    for (let grown = true; grown; ) {
      grown = false;
      const tail = wordsOf.slice(-2).join(' ');
      const head = wordsOf.slice(0, 2).join(' ');
      for (const other of frequent) {
        const o = other.split(' ');
        if (wordsOf.length < 8 && `${o[0]} ${o[1]}` === tail && !wordsOf.includes(o[2]!)) {
          wordsOf = [...wordsOf, o[2]!];
          grown = true;
          break;
        }
        if (wordsOf.length < 8 && `${o[1]} ${o[2]}` === head && !wordsOf.includes(o[0]!)) {
          wordsOf = [o[0]!, ...wordsOf];
          grown = true;
          break;
        }
      }
    }
    phrases.add(wordsOf.join(' '));
  }

  // A chained phrase is only a habit if it really recurs whole; otherwise the
  // longest piece that does is reported.
  const normalised = recent.map((text) => ` ${words(text).join(' ')} `);
  const postsWith = (phrase: string) => normalised.filter((text) => text.includes(` ${phrase} `)).length;
  const measured = [...phrases]
    .map((phrase) => ({ phrase, posts: postsWith(phrase) }))
    .map((entry) => (entry.posts >= minPosts ? entry : null))
    .filter((entry): entry is { phrase: string; posts: number } => entry !== null);
  for (const gram of frequent) {
    if (![...measured].some((m) => ` ${m.phrase} `.includes(` ${gram} `))) measured.push({ phrase: gram, posts: counts.get(gram)! });
  }

  const ranked = measured
    .filter((entry, _, all) => !all.some((other) => other !== entry && other.phrase.length > entry.phrase.length && ` ${other.phrase} `.includes(` ${entry.phrase} `)))
    .sort((a, b) => b.posts - a.posts || b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));
  const unique = ranked.filter((entry, index) => ranked.findIndex((other) => other.phrase === entry.phrase) === index);
  return unique.slice(0, max);
}

export interface RecentPost {
  text: string;
  at: string;
  /** Set when this was said to the same person, which makes reuse worse. */
  sameRecipient?: boolean;
}

export interface RepetitionOptions {
  /** Phrases the agent is allowed to repeat deliberately. */
  signaturePhrases?: readonly string[];
  /** How long a signature phrase must rest before reuse stops being fine. */
  signatureRestHours?: number;
  now?: Date;
  /**
   * Whether an identical opening is decisive on its own.
   *
   * True for an original post, false for a reply, and the difference is not a
   * matter of degree. A reply opening the same way to two different people is
   * mildly repetitive and nobody sees both. A post opening the same way twice
   * goes to one timeline, where the two sit above each other and the agent
   * reads as a loop.
   *
   * Measured on ai17z-main, which is why this exists. Two original posts four
   * days apart shared a byte-identical opening sentence and a byte-identical
   * closing sentence, with one clause changed in the middle. The overlap rule
   * fired first at 78 and the rewrite threshold was 80, so nothing was asked
   * for. The `sameOpener` branch below would have recognised it, and never got
   * the chance, because it sits in an else-if behind the overlap it was
   * competing with.
   */
  openerIsDecisive?: boolean;
}

/**
 * What an identical opening scores on a post.
 *
 * Above the default rewrite threshold of 80 on purpose: the point is that the
 * rewriter is asked, every time, rather than only when the rest of the phrasing
 * happens to overlap as well. Below the 95 ceiling the run rule can reach, so a
 * whole sentence lifted wholesale still ranks worse than a shared opening.
 */
const OPENER_ON_A_POST = 90;

/**
 * Scores how much a candidate repeats what the agent recently said.
 *
 * Higher is worse. The single worst match decides the score: one sentence
 * lifted wholesale from yesterday is a problem whether or not the rest is new.
 */
export function scoreRepetition(
  candidate: string,
  recent: RecentPost[],
  options: RepetitionOptions = {},
): RepetitionScore {
  const draft = candidate.trim();
  if (!draft || recent.length === 0) return { score: 0, reason: null, matched: null, matchedAt: null };

  const now = options.now ?? new Date();
  const restMs = (options.signatureRestHours ?? 48) * 3_600_000;
  const signatures = (options.signaturePhrases ?? []).map((p) => normalise(p)).filter((p) => p.length >= 3);

  let worst: RepetitionScore = { score: 0, reason: null, matched: null, matchedAt: null };

  for (const post of recent) {
    const overlap = trigramOverlap(draft, post.text);
    const run = longestSharedRun(draft, post.text);
    const sameOpener = opener(draft).length > 0 && opener(draft) === opener(post.text);
    const ageMs = now.getTime() - new Date(post.at).getTime();

    let score = 0;
    let reason: string | null = null;

    /*
      On a post, an identical opening is decided first rather than last.

      The branches below are ordered by how strong each signal is on its own,
      and that ordering is right for a reply. For a post it buried the signal
      that matters most: the opening is the part a timeline shows twice.
    */
    if (options.openerIsDecisive && sameOpener) {
      score = OPENER_ON_A_POST;
      reason = 'opens exactly like something this agent already posted';
    } else if (overlap >= 0.5) {
      score = Math.round(overlap * 100);
      reason = `${Math.round(overlap * 100)}% of the phrasing appeared in a recent reply`;
    } else if (run >= 7) {
      // Seven words in a row is a reused sentence, not a coincidence.
      score = Math.min(95, 55 + run * 4);
      reason = `${run} words in a row match something already said`;
    } else if (sameOpener) {
      score = 62;
      reason = 'opens exactly like a recent reply';
    } else if (overlap >= 0.3) {
      score = Math.round(overlap * 100);
      reason = 'noticeably similar phrasing to a recent reply';
    }

    if (score === 0) continue;

    // A signature phrase is allowed to recur, but only after it has rested.
    // Otherwise the thing that makes an agent recognisable becomes a tic.
    const normalisedDraft = normalise(draft);
    const isSignature = signatures.some((phrase) => normalisedDraft.includes(phrase) && normalise(post.text).includes(phrase));
    if (isSignature && ageMs >= restMs) continue;
    if (isSignature) {
      score = Math.max(score, 70);
      reason = 'reuses a signature phrase again too soon';
    }

    // Saying the same thing to the same person is worse than saying it to
    // somebody who has not heard it.
    if (post.sameRecipient) score = Math.min(100, score + 12);
    // And what was said an hour ago matters more than what was said last week.
    if (ageMs < 6 * 3_600_000) score = Math.min(100, score + 8);
    else if (ageMs > 14 * 86_400_000) score = Math.round(score * 0.7);

    if (score > worst.score) {
      worst = {
        score: Math.min(100, score),
        reason,
        matched: post.text.slice(0, 200),
        matchedAt: post.at,
      };
    }
  }

  /*
    A phrase the agent keeps returning to, across posts rather than within one.
    Three recent outputs asks nothing on its own; four is over the default
    rewrite threshold of 80, because by then it is a tic somebody following
    the account will have noticed. A signature phrase is exempt: recurring is
    what it is for, and its own rest period above governs it.
  */
  const draftGrams = trigrams(draft);
  for (const habit of habitualPhrases(recent.map((post) => post.text))) {
    // Any three words of the habit in a row, since "the" or a trailing word
    // may differ while the tic is the same.
    const piece = [...trigrams(habit.phrase)].find((gram) => draftGrams.has(gram) && !gram.split(' ').every((w) => FUNCTION_WORDS.has(w)));
    if (!piece) continue;
    if (signatures.some((phrase) => phrase.includes(habit.phrase) || habit.phrase.includes(phrase))) continue;
    const score = Math.min(95, 52 + 8 * habit.posts);
    if (score > worst.score) {
      worst = {
        score,
        reason: `leans on "${habit.phrase}", already in ${habit.posts} recent replies`,
        matched: habit.phrase,
        matchedAt: null,
      };
    }
  }

  return worst;
}
