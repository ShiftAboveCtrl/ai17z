/**
 * Whether a post is somebody selling a token rather than saying something.
 *
 * Measured on a live agent's own discovery: of eighteen posts it found under
 * its topics, the account with the second-largest audience (1.6 million) was
 * flexing old calls, "I GAVE YOU $PONS AT 411K", and the one with the largest
 * was "$EKOX is looking seriously strong right now". Ranked on audience alone,
 * those were the first two things it would have answered, and answering a
 * pitch reads as either endorsing it or picking a fight with it. Neither is
 * growth.
 *
 * Deterministic and cheap on purpose, for the reason `salience.ts` gives: this
 * runs before anything expensive, and "the model thought it was spam" is not a
 * reason an owner can inspect. Every point names what it saw.
 *
 * **A ticker is not a pitch.** Most of what an agent that follows Pons and
 * Robinhood Chain should talk about has a ticker in it, and "$PONS revenue is
 * still down, but four new assets were added" is a post worth answering. What
 * scores is the shape of selling: flexing calls, multipliers, urgency, "bid
 * zone", ad copy that opens with the ticker and never says anything else.
 */

export interface PromoReading {
  /** How strongly this reads as a pitch. 0 is none. */
  score: number;
  /** What was seen, in words. */
  signals: string[];
  /** strong: skip unless there is a reason; some: rank lower; none. */
  level: 'none' | 'some' | 'strong';
}

const RULES: { pattern: RegExp; weight: number; label: string }[] = [
  // Flexing past calls: the single clearest sign of a shill account.
  { pattern: /\bi (gave|called|told) (you|u)\b/i, weight: 2, label: 'flexes past calls' },
  { pattern: /\bdon'?t (tell|say) (me )?i didn'?t\b/i, weight: 2, label: 'flexes past calls' },
  // Teasing the next call: "I have the next $CASHCAT / I have the next $PONS".
  // Measured: the first live proactive reply went under exactly this post,
  // because four tickers alone only read as a list.
  { pattern: /\b(i have|i'?ve got|i got|got|found) the next\s+\$[A-Za-z]/i, weight: 2, label: 'teases the next call' },
  // "I have the CA to the next $PONS", measured on a live agent: the call is
  // teased through the contract rather than the ticker, and it was answered.
  { pattern: /\b(ca|contract(?: address)?)\b[^.!?\n]{0,24}\bnext\s+\$[A-Za-z]/i, weight: 2, label: 'teases the next call' },
  // A price promised with a clock on it: "it will go to millions in a few minutes".
  { pattern: /\b(will|gonna|going to|about to)\s+(go|hit|run|send)\s+(to\s+)?(millions|billions|\d+(?:[.,]\d+)?\s?[kmb]\b)/i, weight: 1, label: 'promises a price' },
  // The close of the pitch, asked of whoever is reading.
  { pattern: /\b(want in|who'?s in|get in (now|early)|ape in|don'?t fade (this|it))\b/i, weight: 1, label: 'urgency' },
  // Multipliers: 3x, 418X, 1.060X, 1000x.
  { pattern: /\b\d+(?:[.,]\d+)?\s?x\b(?!\w)/i, weight: 1, label: 'quotes a multiplier' },
  // Urgency and selling language.
  { pattern: /\b(is sending|sending already|next big run|about to (send|explode|run)|don'?t miss|last chance|before it'?s too late|to the moon|moon ?bag|send it)\b/i, weight: 1, label: 'urgency' },
  { pattern: /\b(bid (zone|the dips?)|my bags?|load(ing)? up|accumulat(e|ing) here|entry zone|dca zone)\b/i, weight: 1, label: 'tells people where to buy' },
  // "Some of the main, high conviction ARC / Robinhood bags" is a shopping list
  // however it is punctuated. Measured: scored only partly as a pitch, and a
  // reply was drafted under it.
  { pattern: /\bhigh[- ]conviction\b[^.!?\n]{0,60}\bbags?\b/i, weight: 2, label: 'lists its bags' },
  { pattern: /\b(looking (seriously |very |so )?(strong|bullish)|huge potential|unique setup|gem alert|100x gem|next 100x|low cap gem)\b/i, weight: 1, label: 'sells a setup' },
  { pattern: /\b(nfa|dyor|not financial advice)\b/i, weight: 1, label: 'disclaims advice while giving it' },
  // Engagement farming.
  { pattern: /\b(like (and|&) (rt|retweet|repost)|rt (and|&) follow|follow (and|&) (rt|retweet)|tag \d+ friends|drop your (wallet|address)|comment your)\b/i, weight: 2, label: 'farms engagement' },
  { pattern: /\b(giveaway|airdrop(ping)? to|whitelist spots?|wl spots?|referral (link|code))\b/i, weight: 2, label: 'giveaway or referral mechanics' },
  { pattern: /\b(paid (promo|partnership)|#ad\b|sponsored)\b/i, weight: 3, label: 'says it is paid' },
];

const PITCH_EMOJI = /[\u{1F440}\u{1F680}\u{1F4C8}\u{1F92F}\u{1F48E}\u{1F525}\u{1F4B0}\u{1F911}]/u;
const CASHTAG = /\$[A-Za-z][A-Za-z0-9]{1,11}\b/g;

export function readPromo(text: string): PromoReading {
  const signals: string[] = [];
  let score = 0;
  const add = (label: string, weight: number) => {
    if (!signals.includes(label)) signals.push(label);
    score += weight;
  };

  for (const rule of RULES) if (rule.pattern.test(text)) add(rule.label, rule.weight);

  const tickers = new Set((text.match(CASHTAG) ?? []).map((t) => t.toUpperCase()));
  const trimmed = text.trim();

  /*
    A contract address is a ticker by other means. "Golden Kitty's on page 2 of
    @ponsdotfamily 👀 robinhood:0x92e4...", measured, went through as no pitch at
    all because it carried no cashtag, and the agent replied under it. An
    address with hype, or with almost nothing else said, is somebody selling.
  */
  const contract = /\b0x[a-fA-F0-9]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}pump\b/.test(text);
  if (contract) {
    add('shares a contract address', 1);
    const said = text
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\S*0x[a-fA-F0-9]{40}\S*/g, ' ')
      .replace(/@[A-Za-z0-9_]+/g, ' ')
      .trim();
    if (said.length < 80) add('says little besides the address', 1);
    if (PITCH_EMOJI.test(text)) add('address with hype emoji', 1);
  }
  // Ad copy leads with the ticker: "$INFERNOAI — Inferno AI ...", "$EKOX is ...".
  if (/^\$[A-Za-z][A-Za-z0-9]{1,11}\b/.test(trimmed) && tickers.size >= 1) add('opens with a ticker', 1);
  // A ticker plus the emoji people sell with.
  if (tickers.size >= 1 && PITCH_EMOJI.test(text)) add('ticker with hype emoji', 1);
  // A list of bags is a shopping list.
  if (tickers.size >= 3) add(`lists ${tickers.size} tickers`, 1);

  const level = score >= 3 ? 'strong' : score >= 2 ? 'some' : 'none';
  return { score, signals, level };
}
