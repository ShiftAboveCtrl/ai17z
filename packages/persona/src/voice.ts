import type { VoiceDimension, VoiceFingerprint, VoiceMatch } from '@xbam/shared/contracts';
import { emptyFingerprint } from '@xbam/shared/contracts';

/**
 * Measuring how somebody writes, and how closely a draft matches.
 *
 * This is the part that makes identity provider-independent. "Tone: dry" is a
 * label each model interprets differently and differently again next month;
 * "median reply 54 characters, questions 8%, fragments common" is a target that
 * can be measured against and does not move when the model behind it changes.
 *
 * Everything is arithmetic. No model call, no embedding, nothing that could
 * return a different answer for the same input.
 */

const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const CONTRACTION = /\b\w+'(s|t|re|ve|ll|d|m)\b/i;
const FIRST_PERSON = /\b(i|i'm|my|me|we|our|us)\b/i;
/** A finite verb somewhere is what separates a sentence from a fragment. */
const FINITE_VERB =
  /\b(is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|can|could|should|may|might|must|am|get|gets|got|make|makes|think|thinks|know|knows|see|sees|want|wants|need|needs|say|says|go|goes|come|comes|take|takes|look|looks|seem|seems|work|works|keep|keeps|\w+ed|\w+s)\b/i;

/** Words too common to say anything about a particular voice. */
const STOPWORDS = new Set(
  ('the a an and or but if then than that this these those of to in on at for with from by as is are was were be been ' +
    'being have has had do does did will would can could should may might must not no yes it its i you he she they we ' +
    'me him her them us my your his their our so up out about into over after before more most some any all just now ' +
    'only very too also there here what which who whom when where why how')
    .split(' ')
    .filter(Boolean),
);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** No finite verb and short: "Fair point." "Not surprising." */
function isFragment(sentence: string): boolean {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;
  return !FINITE_VERB.test(sentence);
}

/** The first two or three words, which is where a voice announces itself. */
function opener(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ')
    .replace(/[.,!?;:]+$/, '')
    .toLowerCase();
}

/**
 * Derives a fingerprint from samples of the agent's own writing.
 *
 * Rates are proportions of samples rather than of sentences, because "uses
 * questions" is a habit of replies, not of clauses.
 */
export function deriveFingerprint(samples: string[], sources: string[] = []): VoiceFingerprint {
  const texts = samples.map((s) => s.trim()).filter((s) => s.length > 0);
  if (texts.length === 0) return emptyFingerprint();

  const chars = texts.map((t) => t.length);
  const sentenceCounts: number[] = [];
  const wordsPerSentence: number[] = [];
  const openers = new Map<string, number>();
  const wordCounts = new Map<string, number>();

  let questions = 0;
  let exclamations = 0;
  let emoji = 0;
  let hashtags = 0;
  let links = 0;
  let fragments = 0;
  let contractions = 0;
  let firstPerson = 0;
  let capitalised = 0;
  let ellipsis = 0;
  let dashes = 0;
  let multiLine = 0;

  for (const text of texts) {
    const sentences = sentencesOf(text);
    sentenceCounts.push(Math.max(1, sentences.length));
    for (const sentence of sentences) {
      wordsPerSentence.push(sentence.split(/\s+/).filter(Boolean).length);
    }

    if (/\?/.test(text)) questions += 1;
    if (/!/.test(text)) exclamations += 1;
    if (EMOJI.test(text)) emoji += 1;
    if (/#\w/.test(text)) hashtags += 1;
    if (/https?:\/\//.test(text)) links += 1;
    if (sentences.some(isFragment)) fragments += 1;
    if (CONTRACTION.test(text)) contractions += 1;
    if (FIRST_PERSON.test(text)) firstPerson += 1;
    if (/^[A-Z]/.test(text)) capitalised += 1;
    if (/\.\.\.|…/.test(text)) ellipsis += 1;
    if (/[—–]| - /.test(text)) dashes += 1;
    if (/\n/.test(text)) multiLine += 1;

    const key = opener(text);
    if (key) openers.set(key, (openers.get(key) ?? 0) + 1);

    for (const word of text.toLowerCase().match(/\b[a-z][a-z'-]{2,}\b/g) ?? []) {
      if (STOPWORDS.has(word)) continue;
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  const n = texts.length;
  const rate = (count: number) => Number((count / n).toFixed(3));

  return {
    sampleCount: n,
    medianChars: Math.round(median(chars)),
    p90Chars: Math.round(percentile(chars, 90)),
    medianSentences: Number(median(sentenceCounts).toFixed(1)),
    medianWordsPerSentence: Number(median(wordsPerSentence).toFixed(1)),
    questionRate: rate(questions),
    exclamationRate: rate(exclamations),
    emojiRate: rate(emoji),
    hashtagRate: rate(hashtags),
    linkRate: rate(links),
    fragmentRate: rate(fragments),
    contractionRate: rate(contractions),
    firstPersonRate: rate(firstPerson),
    capitalisedRate: rate(capitalised),
    ellipsisRate: rate(ellipsis),
    dashRate: rate(dashes),
    multiLineRate: rate(multiLine),
    // A word used in at least a fifth of samples is a habit rather than a topic.
    characteristicWords: [...wordCounts.entries()]
      .filter(([, count]) => count >= Math.max(2, n * 0.2))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([word]) => word),
    typicalOpeners: [...openers.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([phrase]) => phrase),
    derivedAt: new Date().toISOString(),
    sources,
  };
}

/** Distance on a rate, as a 0–100 score. */
function rateScore(actual: boolean, expected: number, tolerance = 0.25): number {
  // A habit the agent has in 8% of replies should not be penalised heavily for
  // appearing or not appearing in any single one. Only strong expectations —
  // near-never or near-always — are scored firmly.
  if (expected <= tolerance) return actual ? Math.round(100 - (tolerance - expected) * 200) : 100;
  if (expected >= 1 - tolerance) return actual ? 100 : Math.round(100 - (expected - (1 - tolerance)) * 200);
  return 100;
}

/**
 * How closely a draft matches the fingerprint.
 *
 * Not a measurement of anything real, and the report says so. It is a
 * consistency heuristic: useful for catching a reply four times longer than
 * this agent ever writes, not for ranking prose.
 */
export function scoreVoice(text: string, fingerprint: VoiceFingerprint): VoiceMatch {
  const dimensions: VoiceDimension[] = [];
  const lowConfidence = fingerprint.sampleCount < 20;

  if (fingerprint.sampleCount === 0) {
    return { score: 100, dimensions: [], lowConfidence: true };
  }

  const draft = text.trim();
  const sentences = sentencesOf(draft);

  // ── Length, the dimension that catches the most ─────────────────────────
  const ceiling = Math.max(fingerprint.p90Chars, fingerprint.medianChars * 2, 40);
  const floor = Math.max(10, fingerprint.medianChars * 0.25);
  let lengthScore = 100;
  let lengthDetail = 'about the usual length';
  if (draft.length > ceiling) {
    lengthScore = Math.max(0, Math.round(100 - ((draft.length - ceiling) / ceiling) * 100));
    lengthDetail = `${draft.length} characters, and this agent rarely passes ${ceiling}`;
  } else if (draft.length < floor) {
    lengthScore = Math.max(30, Math.round(100 - ((floor - draft.length) / Math.max(floor, 1)) * 60));
    lengthDetail = `${draft.length} characters, shorter than this agent usually writes`;
  }
  dimensions.push({ name: 'length', score: lengthScore, detail: lengthDetail });

  // ── Structure ───────────────────────────────────────────────────────────
  const expectedSentences = Math.max(1, fingerprint.medianSentences);
  const sentenceScore =
    sentences.length > expectedSentences * 2.5
      ? Math.max(20, Math.round(100 - (sentences.length - expectedSentences * 2.5) * 15))
      : 100;
  dimensions.push({
    name: 'structure',
    score: sentenceScore,
    detail:
      sentenceScore === 100
        ? `${sentences.length} sentence${sentences.length === 1 ? '' : 's'}, in keeping`
        : `${sentences.length} sentences, where this agent usually writes about ${expectedSentences}`,
  });

  // ── Punctuation habits ──────────────────────────────────────────────────
  const punctuation = [
    { name: 'emoji', actual: EMOJI.test(draft), expected: fingerprint.emojiRate },
    { name: 'hashtags', actual: /#\w/.test(draft), expected: fingerprint.hashtagRate },
    { name: 'exclamations', actual: /!/.test(draft), expected: fingerprint.exclamationRate },
  ];
  const punctuationScore = Math.round(
    punctuation.reduce((sum, p) => sum + rateScore(p.actual, p.expected), 0) / punctuation.length,
  );
  const offending = punctuation.find((p) => rateScore(p.actual, p.expected) < 70);
  dimensions.push({
    name: 'punctuation',
    score: punctuationScore,
    detail: offending
      ? `uses ${offending.name}, which this agent almost never does`
      : 'punctuation habits match',
  });

  // ── Vocabulary ──────────────────────────────────────────────────────────
  const words = new Set(draft.toLowerCase().match(/\b[a-z][a-z'-]{2,}\b/g) ?? []);
  const shared = fingerprint.characteristicWords.filter((word) => words.has(word)).length;
  const vocabularyScore =
    fingerprint.characteristicWords.length === 0
      ? 100
      : Math.min(100, 60 + shared * 20);
  dimensions.push({
    name: 'vocabulary',
    score: vocabularyScore,
    detail: shared > 0 ? `${shared} characteristic word${shared === 1 ? '' : 's'}` : 'none of its usual vocabulary',
  });

  // ── Opening form ────────────────────────────────────────────────────────
  const draftOpener = opener(draft);
  const openerScore =
    fingerprint.typicalOpeners.length === 0 || fingerprint.typicalOpeners.includes(draftOpener) ? 100 : 85;
  dimensions.push({
    name: 'opening',
    score: openerScore,
    detail: openerScore === 100 ? 'opens in a familiar way' : 'opens unlike its usual replies',
  });

  // Length carries the most weight because it catches the most: a model that
  // writes three paragraphs where the agent writes a line is the failure people
  // actually notice.
  const weights: Record<string, number> = {
    length: 3,
    structure: 2,
    punctuation: 2,
    vocabulary: 1,
    opening: 1,
  };
  const total = dimensions.reduce((sum, d) => sum + d.score * (weights[d.name] ?? 1), 0);
  const divisor = dimensions.reduce((sum, d) => sum + (weights[d.name] ?? 1), 0);

  return { score: Math.round(total / divisor), dimensions, lowConfidence };
}
