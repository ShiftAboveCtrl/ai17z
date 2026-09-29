import { habitualPhrases } from './repetition';
import { stripLeadingMentions } from './normalize';

/**
 * How somebody writes, measured across everything they wrote, with the posts
 * each measurement rests on.
 *
 * The fingerprint in voice.ts is what the voice compiler scores drafts against:
 * a handful of rates. This is the fuller reading a person reviewing a persona
 * needs, and the thing an Agent Foundry proposal is built from: how posts and
 * replies differ, whether the length changes with the subject, how they open,
 * how they end, how they hedge and how they disagree.
 *
 * Arithmetic only. Every statement names its sample and cites examples, and a
 * statement that rests on too little is not made rather than made weakly.
 */

export interface VoiceItem {
  id: string;
  text: string;
  kind: 'post' | 'reply' | 'quote';
  /** The platform's language tag, when it gave one. */
  lang?: string | null;
  createdAt?: string | null;
}

export interface Spread {
  n: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

export interface VoiceStatement {
  /** What the owner reads. */
  text: string;
  /** What the voice compiler or style guidelines can use. */
  guideline: string;
  area: 'LENGTH' | 'REGISTER' | 'PUNCTUATION' | 'CASE' | 'EMOJI' | 'HASHTAGS' | 'SLANG' | 'HEDGING' | 'DISAGREEMENT' | 'HUMOUR' | 'GREETING' | 'ENDING' | 'QUESTIONS' | 'LANGUAGE' | 'PHRASE';
  /** Share of the relevant sample it describes, 0 to 1. */
  share: number;
  sample: number;
  evidence: string[];
  confidence: number;
}

export interface VoiceProfile {
  sample: { items: number; posts: number; replies: number; quotes: number; from: string | null; to: string | null };
  chars: { all: Spread; posts: Spread; replies: Spread };
  words: { all: Spread; casual: Spread; technical: Spread };
  technicalShare: number;
  languages: { lang: string; share: number }[];
  topEmoji: { emoji: string; items: number }[];
  statements: VoiceStatement[];
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const HASHTAG = /#\p{L}[\p{L}\p{N}_]*/u;
const HEDGE = /\b(i think|i guess|maybe|probably|not sure|might be|could be|imo|imho|i feel like|seems like|kinda|sort of)\b/i;
const DISAGREE = /^(?:nah|no[,.! ]|nope|not really|wrong|disagree|that'?s not|hard disagree|i don'?t think)/i;
const HUMOUR = /\b(lol|lmao|lmfao|haha+|hehe|rofl)\b|😂|🤣|💀/iu;
const GREETING = /^(gm|gn|gm gm|good morning|good night|hey|hi|hello|yo|sup)\b/i;
const SLANG_TERMS = ['ngl', 'fr', 'tbh', 'rn', 'imo', 'idk', 'wagmi', 'ngmi', 'lfg', 'gm', 'gn', 'ser', 'fren', 'anon', 'based', 'bullish', 'bearish', 'cope', 'wen', 'u', 'ur', 'bc', 'w/', 'smth', 'lowkey', 'highkey', 'bro', 'fam'];
/**
 * What makes a message technical, as surface signals rather than a topic list:
 * numbers with units, addresses, versions, code, and the vocabulary of systems.
 * A persona who is short by default and long when technical is the most common
 * register switch there is, and it cannot be seen without this.
 */
const TECHNICAL =
  /\b0x[0-9a-f]{6,}|\bv\d+(?:\.\d+)*\b|\b\d+(?:\.\d+)?\s?(?:%|bps|ms|gwei|eth|sol|usd|k|m|b)\b|`[^`]+`|\b(?:contract|liquidity|protocol|api|sdk|deploy(?:ed|ment)?|audit(?:ed)?|oracle|bridge|onchain|on-chain|gas|fee(?:s)?|router|pool|swap|mint|burn|token(?:s|omics)?|launchpad|smart contract|repo|commit|mainnet|testnet|validator|node|latency|throughput|architecture|backend|frontend|database|migration|endpoint|rpc|mev|slippage|tvl|apr|apy|vesting|supply)\b/i;

function spread(values: number[]): Spread {
  if (values.length === 0) return { n: 0, p25: 0, median: 0, p75: 0, p90: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, p25: at(0.25), median: at(0.5), p75: at(0.75), p90: at(0.9) };
}

function body(text: string): string {
  return stripLeadingMentions(text).replace(/https?:\/\/\S+/g, '').trim();
}

function wordsIn(text: string): number {
  return body(text).split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w)).length;
}

/** A script when the platform gave no language: good enough to see a switch. */
function scriptOf(text: string): string {
  if (/[一-鿿]/u.test(text)) return 'zh';
  if (/[぀-ヿ]/u.test(text)) return 'ja';
  if (/[가-힯]/u.test(text)) return 'ko';
  if (/[Ѐ-ӿ]/u.test(text)) return 'ru';
  if (/[؀-ۿ]/u.test(text)) return 'ar';
  return 'en';
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

export function voiceProfile(items: VoiceItem[]): VoiceProfile {
  const usable = items.filter((i) => body(i.text).length > 0);
  const posts = usable.filter((i) => i.kind === 'post');
  const replies = usable.filter((i) => i.kind === 'reply');
  const quotes = usable.filter((i) => i.kind === 'quote');
  const dates = usable.map((i) => i.createdAt).filter((d): d is string => Boolean(d)).sort();
  const technical = usable.filter((i) => TECHNICAL.test(i.text));
  const casual = usable.filter((i) => !TECHNICAL.test(i.text));

  const statements: VoiceStatement[] = [];
  const n = usable.length;
  const state = (s: Omit<VoiceStatement, 'confidence'> & { confidence?: number }) => {
    if (s.sample < 8) return;
    statements.push({ ...s, evidence: s.evidence.slice(0, 5), confidence: s.confidence ?? Math.min(0.9, 0.45 + s.sample / 400) });
  };
  const having = (list: VoiceItem[], test: (i: VoiceItem) => boolean) => list.filter(test);

  const chars = {
    all: spread(usable.map((i) => body(i.text).length)),
    posts: spread(posts.map((i) => body(i.text).length)),
    replies: spread(replies.map((i) => body(i.text).length)),
  };
  const words = {
    all: spread(usable.map((i) => wordsIn(i.text))),
    casual: spread(casual.map((i) => wordsIn(i.text))),
    technical: spread(technical.map((i) => wordsIn(i.text))),
  };

  // ── length and register ────────────────────────────────────────────────
  const shortest = [...usable].sort((a, b) => body(a.text).length - body(b.text).length);
  if (replies.length >= 8) {
    state({
      area: 'LENGTH',
      text: `Replies are usually short: half are under ${chars.replies.median} characters, and nine in ten under ${chars.replies.p90}.`,
      guideline: `Keep replies around ${chars.replies.median} characters; go past ${chars.replies.p90} only when the subject needs it.`,
      share: 0.5,
      sample: replies.length,
      evidence: shortest.filter((i) => i.kind === 'reply').slice(Math.floor(replies.length / 2) - 2, Math.floor(replies.length / 2) + 3).map((i) => i.id),
    });
  }
  if (posts.length >= 8 && replies.length >= 8 && chars.posts.median > chars.replies.median * 1.4) {
    state({
      area: 'LENGTH',
      text: `Their own posts run longer than their replies: a median of ${chars.posts.median} characters against ${chars.replies.median}.`,
      guideline: 'Original posts may be fuller than replies.',
      share: posts.length / n,
      sample: posts.length,
      evidence: [...posts].sort((a, b) => body(b.text).length - body(a.text).length).slice(0, 5).map((i) => i.id),
    });
  }
  if (technical.length >= 5 && casual.length >= 5 && words.technical.median >= words.casual.median * 1.6) {
    state({
      area: 'REGISTER',
      text: `Short by default, longer when technical: a median of ${words.casual.median} words on everyday subjects and ${words.technical.median} when the subject is technical (${technical.length} of ${n} messages).`,
      guideline: 'Default to short, casual replies. When the question is technical, answer fully and precisely, then return to the short register.',
      share: technical.length / n,
      sample: n,
      evidence: [...technical].sort((a, b) => wordsIn(b.text) - wordsIn(a.text)).slice(0, 5).map((i) => i.id),
      confidence: Math.min(0.9, 0.5 + technical.length / 100),
    });
  }

  // ── case and punctuation ──────────────────────────────────────────────
  const lower = having(usable, (i) => /^\p{Ll}/u.test(body(i.text)));
  if (lower.length / n >= 0.5) {
    state({
      area: 'CASE',
      text: `Usually starts in lowercase (${pct(lower.length / n)} of messages).`,
      guideline: 'Starting a message in lowercase is fine and in character.',
      share: lower.length / n,
      sample: n,
      evidence: lower.map((i) => i.id),
    });
  }
  const noFullStop = having(usable, (i) => !/[.!?…]["')\]]?$/u.test(body(i.text).replace(EMOJI, '').trim()));
  if (noFullStop.length / n >= 0.6) {
    state({
      area: 'PUNCTUATION',
      text: `Rarely ends with a full stop (${pct(noFullStop.length / n)} of messages have no closing punctuation).`,
      guideline: 'Leave off the closing full stop on short messages.',
      share: noFullStop.length / n,
      sample: n,
      evidence: noFullStop.map((i) => i.id),
    });
  }
  const exclaim = having(usable, (i) => /!/.test(i.text));
  if (exclaim.length / n <= 0.05 && n >= 20) {
    state({
      area: 'PUNCTUATION',
      text: `Almost never uses exclamation marks (${exclaim.length} of ${n}).`,
      guideline: 'Avoid exclamation marks.',
      share: 1 - exclaim.length / n,
      sample: n,
      evidence: [],
    });
  }
  const questions = having(usable, (i) => /\?/.test(i.text));
  if (questions.length / n >= 0.2) {
    state({
      area: 'QUESTIONS',
      text: `Asks questions often (${pct(questions.length / n)} of messages).`,
      guideline: 'A short question back is a natural way to reply.',
      share: questions.length / n,
      sample: n,
      evidence: questions.map((i) => i.id),
    });
  }

  // ── emoji and hashtags ────────────────────────────────────────────────
  const withEmoji = having(usable, (i) => (i.text.match(EMOJI) ?? []).length > 0);
  const emojiCounts = new Map<string, number>();
  for (const item of withEmoji) for (const e of new Set(item.text.match(EMOJI) ?? [])) emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
  const topEmoji = [...emojiCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([emoji, count]) => ({ emoji, items: count }));
  if (withEmoji.length / n <= 0.05) {
    state({ area: 'EMOJI', text: `Rarely uses emoji (${withEmoji.length} of ${n}).`, guideline: 'Use emoji rarely or not at all.', share: 1 - withEmoji.length / n, sample: n, evidence: [] });
  } else {
    state({
      area: 'EMOJI',
      text: `Uses emoji in ${pct(withEmoji.length / n)} of messages, most often ${topEmoji.slice(0, 3).map((e) => e.emoji).join(' ')}.`,
      guideline: `Emoji are in character in moderation; the usual ones are ${topEmoji.slice(0, 3).map((e) => e.emoji).join(' ')}.`,
      share: withEmoji.length / n,
      sample: n,
      evidence: withEmoji.map((i) => i.id),
    });
  }
  const withHashtag = having(usable, (i) => HASHTAG.test(i.text));
  if (withHashtag.length / n <= 0.03 && n >= 20) {
    state({ area: 'HASHTAGS', text: `Almost never uses hashtags (${withHashtag.length} of ${n}).`, guideline: 'Do not use hashtags.', share: 1 - withHashtag.length / n, sample: n, evidence: [] });
  }

  // ── slang, hedging, disagreement, humour, greetings ───────────────────
  const slang = SLANG_TERMS.map((term) => ({
    term,
    ids: usable.filter((i) => new RegExp(`(^|[^\\p{L}])${term.replace('/', '\\/')}(?=$|[^\\p{L}])`, 'iu').test(body(i.text))).map((i) => i.id),
  }))
    .filter((s) => s.ids.length >= Math.max(3, n * 0.03))
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, 6);
  if (slang.length > 0) {
    state({
      area: 'SLANG',
      text: `Uses ${slang.map((s) => `"${s.term}" (${s.ids.length})`).join(', ')}.`,
      guideline: `Informal shorthand such as ${slang.slice(0, 4).map((s) => s.term).join(', ')} is in character; do not overuse any one of them.`,
      share: slang.reduce((a, s) => a + s.ids.length, 0) / n,
      sample: n,
      evidence: slang.flatMap((s) => s.ids.slice(0, 1)),
    });
  }
  const hedges = having(usable, (i) => HEDGE.test(i.text));
  if (hedges.length / n >= 0.1) {
    state({ area: 'HEDGING', text: `Hedges regularly (${pct(hedges.length / n)}): "I think", "probably", "not sure".`, guideline: 'Say when something is a view rather than a fact.', share: hedges.length / n, sample: n, evidence: hedges.map((i) => i.id) });
  } else if (n >= 30 && hedges.length / n <= 0.03) {
    state({ area: 'HEDGING', text: `Rarely hedges (${hedges.length} of ${n}); states things directly.`, guideline: 'Be direct. State a view plainly rather than hedging it.', share: 1 - hedges.length / n, sample: n, evidence: [] });
  }
  const disagree = having(replies, (i) => DISAGREE.test(body(i.text)));
  if (disagree.length >= 3) {
    state({
      area: 'DISAGREEMENT',
      text: `Disagrees plainly and briefly when it does (${disagree.length} replies open with "no", "nah" or "not really").`,
      guideline: 'When disagreeing, say so in the first words and keep it short. Never escalate.',
      share: disagree.length / Math.max(1, replies.length),
      sample: replies.length,
      evidence: disagree.map((i) => i.id),
    });
  }
  const humour = having(usable, (i) => HUMOUR.test(i.text));
  if (humour.length / n >= 0.08) {
    state({ area: 'HUMOUR', text: `Playful: laughs or jokes in ${pct(humour.length / n)} of messages.`, guideline: 'Light humour is in character.', share: humour.length / n, sample: n, evidence: humour.map((i) => i.id) });
  }
  const greetings = having(usable, (i) => GREETING.test(body(i.text)));
  if (greetings.length >= 3) {
    const forms = new Map<string, number>();
    for (const g of greetings) {
      const form = body(g.text).match(GREETING)![1]!.toLowerCase();
      forms.set(form, (forms.get(form) ?? 0) + 1);
    }
    const top = [...forms.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    state({ area: 'GREETING', text: `Greets with "${top}" (${greetings.length} messages open with a greeting).`, guideline: `"${top}" is the usual greeting.`, share: greetings.length / n, sample: n, evidence: greetings.map((i) => i.id) });
  }

  // ── languages and phrases ─────────────────────────────────────────────
  const langCounts = new Map<string, number>();
  for (const item of usable) {
    const lang = (item.lang && item.lang !== 'und' && item.lang !== 'zxx' ? item.lang : scriptOf(item.text)).toLowerCase();
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
  }
  const languages = [...langCounts.entries()].map(([lang, c]) => ({ lang, share: c / Math.max(1, n) })).sort((a, b) => b.share - a.share);
  const second = languages[1];
  if (second && second.share >= 0.05) {
    state({
      area: 'LANGUAGE',
      text: `Writes mostly in ${languages[0]!.lang} and sometimes in ${second.lang} (${pct(second.share)}).`,
      guideline: `Answer in the language the message was written in; ${second.lang} is part of this voice.`,
      share: second.share,
      sample: n,
      evidence: usable.filter((i) => (i.lang ?? scriptOf(i.text)).toLowerCase() === second.lang).map((i) => i.id),
    });
  }
  for (const habit of habitualPhrases(usable.map((i) => body(i.text)), Math.max(3, Math.ceil(n * 0.03)), 4)) {
    const ids = usable.filter((i) => body(i.text).toLowerCase().includes(habit.phrase)).map((i) => i.id);
    state({
      area: 'PHRASE',
      text: `Recurring phrase: "${habit.phrase}" (${habit.posts} messages).`,
      guideline: `"${habit.phrase}" is a real signature; use it occasionally, never as a template.`,
      share: habit.posts / n,
      sample: n,
      evidence: ids,
      confidence: 0.6,
    });
  }

  return {
    sample: { items: n, posts: posts.length, replies: replies.length, quotes: quotes.length, from: dates[0] ?? null, to: dates.at(-1) ?? null },
    chars,
    words,
    technicalShare: n === 0 ? 0 : technical.length / n,
    languages,
    topEmoji,
    statements,
  };
}
