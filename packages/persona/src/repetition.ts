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

function opener(text: string, count = 4): string {
  return words(text).slice(0, count).join(' ');
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
}

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

    if (overlap >= 0.5) {
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

  return worst;
}
