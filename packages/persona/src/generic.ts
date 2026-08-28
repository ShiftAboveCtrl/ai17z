import type { AvoidedRegister, GenericScore } from '@xbam/shared/contracts';

/**
 * Detecting prose that reads as generic assistant output.
 *
 * Two kinds of signal, because a blacklist alone does not work. Phrases catch
 * the obvious openings; structural patterns catch the shape — the balanced
 * caveat, the essay conclusion, the customer-service register — which survives
 * any amount of word substitution.
 *
 * This is a style metric, not a detector of machine authorship. It says how much
 * something reads like a generic assistant, which is a question about register
 * rather than about origin, and nothing here should ever be presented as proof
 * that text was generated.
 */

interface Pattern {
  test: RegExp;
  weight: number;
  reason: string;
  register?: AvoidedRegister;
}

const PHRASES: Pattern[] = [
  { test: /^(great|good|excellent|interesting) (question|point)\b/i, weight: 22, reason: 'opens by praising the question', register: 'chatbot' },
  { test: /^(absolutely|certainly|of course|sure thing)[,!]/i, weight: 18, reason: 'opens with an agreeable filler', register: 'chatbot' },
  { test: /\bi'?m happy to (help|assist)\b/i, weight: 25, reason: 'offers to help, like a support desk', register: 'customer_support' },
  { test: /\b(let me know if|feel free to) (you|reach out|ask)/i, weight: 20, reason: 'closes with an invitation to follow up', register: 'customer_support' },
  { test: /\bit'?s (important|worth) (to note|noting|remembering)\b/i, weight: 20, reason: 'flags its own point as important', register: 'essay' },
  { test: /\bin (today'?s|the) (fast-paced|ever-changing|modern) \w+/i, weight: 28, reason: 'stock scene-setting opener', register: 'marketing' },
  { test: /\bdelve into\b|\bdive deep\b|\bunlock the (power|potential)\b/i, weight: 24, reason: 'stock content-marketing phrasing', register: 'marketing' },
  { test: /\bat the end of the day\b|\bwhen it comes to\b/i, weight: 12, reason: 'filler transition' },
  { test: /\bi (understand|hear) (that )?(you|your)\b/i, weight: 22, reason: 'reflects the feeling back, like a therapist', register: 'therapy' },
  { test: /\bthat'?s a valid (concern|point|feeling)\b/i, weight: 22, reason: 'validates before answering', register: 'therapy' },
  { test: /\bleverage\b|\bsynerg(y|ies)\b|\bstakeholders?\b|\bbest practices?\b/i, weight: 18, reason: 'corporate vocabulary', register: 'corporate' },
  { test: /\bi (cannot|can'?t) (provide|assist with)\b|\bas an ai\b/i, weight: 30, reason: 'assistant boilerplate', register: 'chatbot' },
  { test: /\bhope (this|that) helps\b/i, weight: 22, reason: 'signs off like a help article', register: 'customer_support' },
];

/**
 * The shape of generic prose, which survives word substitution.
 *
 * These take a whole draft rather than a regex match, because the giveaway is
 * usually a proportion or a structure rather than a phrase.
 */
const STRUCTURES: { name: string; weight: number; reason: string; register?: AvoidedRegister; detect: (text: string) => boolean }[] = [
  {
    name: 'balanced_caveat',
    weight: 20,
    reason: 'presents both sides and commits to neither',
    register: 'essay',
    detect: (text) => {
      const hedges = (text.match(/\b(however|although|that said|on the other hand|while it|it depends|both)\b/gi) ?? []).length;
      return hedges >= 2 && text.length > 180;
    },
  },
  {
    name: 'essay_conclusion',
    weight: 22,
    reason: 'ends with a summarising conclusion',
    register: 'essay',
    detect: (text) => /\b(in (conclusion|summary)|to summari[sz]e|overall,|ultimately,)/i.test(text),
  },
  {
    name: 'over_explaining',
    weight: 18,
    reason: 'explains at length what was asked briefly',
    register: 'essay',
    detect: (text) => {
      const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
      return sentences.length >= 5 && text.length > 500;
    },
  },
  {
    name: 'listicle',
    weight: 16,
    reason: 'answers a conversational message with a numbered list',
    register: 'essay',
    detect: (text) => (text.match(/^\s*(\d+\.|[-*•])\s/gm) ?? []).length >= 3,
  },
  {
    name: 'transition_stack',
    weight: 14,
    reason: 'strings together transition words',
    register: 'essay',
    detect: (text) => (text.match(/\b(additionally|furthermore|moreover|consequently|therefore|in addition)\b/gi) ?? []).length >= 2,
  },
  {
    name: 'restates_question',
    weight: 16,
    reason: 'restates the question before answering it',
    register: 'chatbot',
    detect: (text) => /^(you'?re asking|so,? you want to know|to answer your question)/i.test(text.trim()),
  },
];

/**
 * Scores how much a draft reads as generic assistant prose.
 *
 * `avoid` narrows it to the registers this persona cares about: an agent that
 * is meant to sound corporate should not be penalised for sounding corporate.
 */
export function scoreGeneric(
  text: string,
  options: { avoid?: readonly AvoidedRegister[]; avoidPhrases?: readonly string[] } = {},
): GenericScore {
  const draft = text.trim();
  if (!draft) return { score: 0, reasons: [] };

  const avoid = options.avoid ?? ['corporate', 'customer_support', 'essay', 'chatbot'];
  const wanted = (register?: AvoidedRegister) => !register || avoid.includes(register);

  let score = 0;
  const reasons: string[] = [];

  for (const pattern of PHRASES) {
    if (!wanted(pattern.register)) continue;
    if (pattern.test.test(draft)) {
      score += pattern.weight;
      reasons.push(pattern.reason);
    }
  }

  for (const structure of STRUCTURES) {
    if (!wanted(structure.register)) continue;
    if (structure.detect(draft)) {
      score += structure.weight;
      reasons.push(structure.reason);
    }
  }

  // The owner's own list. Nothing weighs more than a phrase somebody is
  // actively tired of seeing.
  for (const phrase of options.avoidPhrases ?? []) {
    const trimmed = phrase.trim();
    if (trimmed.length >= 3 && draft.toLowerCase().includes(trimmed.toLowerCase())) {
      score += 30;
      reasons.push(`uses "${trimmed}", which you asked it to avoid`);
    }
  }

  return { score: Math.min(100, score), reasons: [...new Set(reasons)].slice(0, 8) };
}
