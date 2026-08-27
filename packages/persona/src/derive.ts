import { keywords } from '@xbam/shared';
import { analyse, stripLeadingMentions } from './normalize';

export interface CorpusItem {
  id: string;
  text: string;
  styleScore: number;
  beliefScore: number;
  classification: string;
}

export interface DerivedTrait {
  kind: 'style' | 'belief' | 'topic' | 'example' | 'language';
  content: string;
  confidence: number;
  /** Item ids this was derived from. A trait without evidence is an assertion. */
  evidence: string[];
}

export interface DerivedProfile {
  traits: DerivedTrait[];
  /** Compact summary suitable for the persona editor. */
  summary: {
    medianWords: number;
    shortFormShare: number;
    questionShare: number;
    emojiShare: number;
    hashtagShare: number;
    topics: string[];
    examples: string[];
  };
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
};

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Derives a compact persona profile from selected corpus items.
 *
 * The output is a handful of statements plus a few examples, not four thousand
 * posts. Injecting a raw corpus into every prompt is what made the legacy
 * persona noisy and expensive; a distilled profile plus a small example set
 * carries the voice at a fraction of the size.
 *
 * Every trait carries the ids it came from, so the owner can ask why.
 */
export function deriveProfile(items: CorpusItem[]): DerivedProfile {
  const usable = items.filter((i) => i.text.trim().length > 0);
  const traits: DerivedTrait[] = [];

  if (usable.length === 0) {
    return {
      traits,
      summary: {
        medianWords: 0, shortFormShare: 0, questionShare: 0,
        emojiShare: 0, hashtagShare: 0, topics: [], examples: [],
      },
    };
  }

  const analysed = usable.map((item) => ({ item, meta: analyse(item.text) }));
  const words = analysed.map((a) => a.meta.wordCount);
  const medianWords = median(words);

  const shortForm = analysed.filter((a) => a.meta.wordCount <= 12);
  const questions = analysed.filter((a) => /\?\s*$/.test(a.item.text.trim()));
  const withEmoji = analysed.filter((a) => EMOJI.test(a.item.text));
  const withHashtag = analysed.filter((a) => a.meta.hashtagCount > 0);

  const share = (n: number) => Number((n / analysed.length).toFixed(2));

  // ── Style ────────────────────────────────────────────────────────────────
  const lengthTrait =
    medianWords <= 12
      ? 'Writes short. A typical post is one or two sentences.'
      : medianWords <= 30
        ? 'Writes in short paragraphs, usually two to four sentences.'
        : 'Writes at length, often several paragraphs.';
  traits.push({
    kind: 'style',
    content: lengthTrait,
    confidence: 0.85,
    evidence: shortForm.slice(0, 5).map((a) => a.item.id),
  });

  if (share(shortForm.length) >= 0.6) {
    traits.push({
      kind: 'style',
      content: 'Favours terse, declarative statements over explanation.',
      confidence: 0.75,
      evidence: shortForm.slice(0, 5).map((a) => a.item.id),
    });
  }
  if (share(withEmoji.length) <= 0.05) {
    traits.push({ kind: 'style', content: 'Rarely uses emoji.', confidence: 0.7, evidence: [] });
  } else if (share(withEmoji.length) >= 0.4) {
    traits.push({
      kind: 'style',
      content: 'Uses emoji regularly.',
      confidence: 0.7,
      evidence: withEmoji.slice(0, 4).map((a) => a.item.id),
    });
  }
  if (share(withHashtag.length) <= 0.05) {
    traits.push({ kind: 'style', content: 'Almost never uses hashtags.', confidence: 0.7, evidence: [] });
  }
  if (share(questions.length) >= 0.2) {
    traits.push({
      kind: 'style',
      content: 'Often answers with a question.',
      confidence: 0.65,
      evidence: questions.slice(0, 4).map((a) => a.item.id),
    });
  }

  // ── Topics ───────────────────────────────────────────────────────────────
  const counts = new Map<string, { n: number; ids: string[] }>();
  for (const { item } of analysed) {
    for (const term of keywords(stripLeadingMentions(item.text), 8)) {
      const entry = counts.get(term) ?? { n: 0, ids: [] };
      entry.n += 1;
      if (entry.ids.length < 5) entry.ids.push(item.id);
      counts.set(term, entry);
    }
  }
  const topics = [...counts.entries()]
    .filter(([term, e]) => term.length >= 3 && e.n >= Math.max(2, Math.ceil(analysed.length * 0.03)))
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12);

  for (const [term, entry] of topics.slice(0, 6)) {
    traits.push({
      kind: 'topic',
      content: term,
      confidence: Math.min(0.95, 0.4 + entry.n / analysed.length),
      evidence: entry.ids,
    });
  }

  // ── Beliefs ──────────────────────────────────────────────────────────────
  // Recurring stated positions, taken verbatim rather than paraphrased, so the
  // owner sees the actual sentence the trait rests on.
  const opinions = usable
    .filter((i) => i.classification === 'opinion')
    .sort((a, b) => b.beliefScore - a.beliefScore)
    .slice(0, 5);
  for (const opinion of opinions) {
    traits.push({
      kind: 'belief',
      content: opinion.text.trim().slice(0, 240),
      confidence: Math.min(0.9, opinion.beliefScore),
      evidence: [opinion.id],
    });
  }

  // ── Examples ─────────────────────────────────────────────────────────────
  // Highest style score, but deduplicated by opening words so the set shows
  // range rather than five variations of one sentence.
  const seenOpeners = new Set<string>();
  const examples: CorpusItem[] = [];
  for (const item of [...usable].sort((a, b) => b.styleScore - a.styleScore)) {
    const opener = stripLeadingMentions(item.text).toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    if (seenOpeners.has(opener)) continue;
    seenOpeners.add(opener);
    examples.push(item);
    if (examples.length >= 12) break;
  }
  for (const example of examples) {
    traits.push({
      kind: 'example',
      content: example.text.trim().slice(0, 400),
      confidence: example.styleScore,
      evidence: [example.id],
    });
  }

  return {
    traits,
    summary: {
      medianWords,
      shortFormShare: share(shortForm.length),
      questionShare: share(questions.length),
      emojiShare: share(withEmoji.length),
      hashtagShare: share(withHashtag.length),
      topics: topics.map(([term]) => term),
      examples: examples.slice(0, 8).map((e) => e.text.trim()),
    },
  };
}
