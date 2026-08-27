import type { NormalizedItem } from './normalize';
import { analyse, stripLeadingMentions } from './normalize';

export interface ItemScores {
  /** How much this says about *how* the person writes. */
  style: number;
  /** How much this says about who they are. */
  persona: number;
  /** How much this states a durable position. */
  belief: number;
  /** How much factual reference value it carries. */
  knowledge: number;
  /** How likely it is to be boilerplate, promotion, or automation. */
  noise: number;
  /** Why it scored this way, shown to the owner. */
  reasons: string[];
}

export interface ClassifiedItem extends ItemScores {
  classification: 'voice' | 'opinion' | 'reference' | 'promotional' | 'automated' | 'low_signal';
  excluded: boolean;
  exclusionReason: string | null;
}

/** Markers of material that says nothing about a person. */
const PROMOTIONAL = [
  'giveaway', 'airdrop', 'retweet to enter', 'rt to enter', 'follow and retweet',
  'use my code', 'referral', 'sign up now', 'limited time', 'don t miss out',
  'link in bio', 'sponsored', 'promo code',
];

const AUTOMATED = ['i just posted', 'new video', 'now live on', 'automatically posted', 'via @'];

/** First-person or evaluative language, which is where voice actually lives. */
const OPINION_MARKERS =
  /\b(i think|i believe|in my (?:view|opinion)|the problem with|people (?:often|always|never)|the truth is|matters more|matters less|overrated|underrated|never|always|should|shouldn t|prefer)\b/i;

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Scores one corpus item for persona usefulness.
 *
 * Deliberately transparent arithmetic rather than a model call: the owner can be
 * shown exactly why something was kept or dropped, and re-scoring 4,000 items
 * costs nothing. Length is never used on its own to exclude anything.
 */
export function scoreItem(rawText: string, analysed?: NormalizedItem): ItemScores {
  const item = analysed ?? analyse(rawText);
  const body = stripLeadingMentions(item.normalized).replace(/https?:\/\/\S+/g, '').trim();
  const lower = body.toLowerCase();
  const reasons: string[] = [];

  let noise = 0;
  const promo = PROMOTIONAL.filter((p) => lower.includes(p));
  if (promo.length > 0) {
    noise += 0.55 + 0.1 * (promo.length - 1);
    reasons.push(`promotional language: ${promo.slice(0, 2).join(', ')}`);
  }
  if (AUTOMATED.some((p) => lower.includes(p))) {
    noise += 0.4;
    reasons.push('looks automatically posted');
  }
  if (item.hasLink && item.wordCount <= 3) {
    noise += 0.5;
    reasons.push('a link with no commentary');
  }
  if (item.hashtagCount >= 4) {
    noise += 0.3;
    reasons.push('hashtag stuffing');
  }
  if (item.mentionCount >= 5 && item.wordCount <= 6) {
    noise += 0.4;
    reasons.push('mostly mentions');
  }
  if (item.isAllCaps) {
    noise += 0.2;
    reasons.push('all caps');
  }
  if (item.wordCount === 0) {
    noise = 1;
    reasons.push('no words after links and mentions were removed');
  }
  noise = clamp(noise);

  // Voice: distinctive phrasing, first person, punctuation habits. A short
  // remark can be the strongest signal there is, so brevity is not penalised.
  let style = 0.45;
  if (item.wordCount >= 3) style += 0.15;
  if (item.wordCount >= 12) style += 0.1;
  if (/[;:—–]|\.\.\./.test(body)) style += 0.08;
  if (OPINION_MARKERS.test(body)) style += 0.15;
  if (/\b(i|my|me|we|our)\b/i.test(body)) style += 0.12;
  if (body.split(/[.!?]/).filter((s) => s.trim()).length >= 2) style += 0.05;
  style = clamp(style - noise * 0.9);

  let persona = clamp(style * 0.7 + (/\b(i|my|me)\b/i.test(body) ? 0.25 : 0) - noise * 0.8);

  let belief = 0.2;
  if (OPINION_MARKERS.test(body)) belief += 0.45;
  if (/\b(because|therefore|which is why|the reason)\b/i.test(body)) belief += 0.15;
  if (item.wordCount >= 8) belief += 0.1;
  belief = clamp(belief - noise * 0.9);

  let knowledge = 0.1;
  if (item.wordCount >= 20) knowledge += 0.25;
  if (/\b\d{2,}\b|%|\$/.test(body)) knowledge += 0.15;
  if (item.hasLink && item.wordCount >= 10) knowledge += 0.15;
  knowledge = clamp(knowledge - noise * 0.7);

  if (style > 0.7) reasons.push('characteristic phrasing');
  if (belief > 0.6) reasons.push('states a position');

  return { style, persona, belief, knowledge, noise, reasons };
}

/** Turns scores into a decision, with the reason recorded either way. */
export function classifyItem(rawText: string, analysed?: NormalizedItem): ClassifiedItem {
  const item = analysed ?? analyse(rawText);
  const scores = scoreItem(rawText, item);
  const body = stripLeadingMentions(item.normalized).replace(/https?:\/\/\S+/g, '').trim();

  if (scores.noise >= 0.6) {
    const classification = scores.noise >= 0.8 && item.wordCount <= 3 ? 'automated' : 'promotional';
    return {
      ...scores,
      classification,
      excluded: true,
      exclusionReason: scores.reasons[0] ?? 'looks like boilerplate rather than voice',
    };
  }
  if (item.wordCount === 0) {
    return { ...scores, classification: 'low_signal', excluded: true, exclusionReason: 'no words to learn from' };
  }
  if (scores.style < 0.35 && scores.belief < 0.35 && scores.knowledge < 0.35) {
    return {
      ...scores,
      classification: 'low_signal',
      excluded: true,
      exclusionReason: 'nothing distinctive enough to learn from',
    };
  }

  // Reference material is long, factual and impersonal. Voice is anything that
  // sounds like a particular person, which first-person language is the clearest
  // signal of. Comparing the two scores directly is not enough, because a
  // well-formed factual paragraph also scores respectably on style.
  const firstPerson = /\b(i|my|me|we|our)\b/i.test(body);
  const isReference = scores.knowledge >= 0.45 && !firstPerson && item.wordCount >= 18;

  const classification = scores.belief >= 0.6 ? 'opinion' : isReference ? 'reference' : 'voice';
  return { ...scores, classification, excluded: false, exclusionReason: null };
}
