/**
 * Whether an original post is worth anybody's timeline.
 *
 * A reply answers somebody. An original post interrupts everybody who follows
 * the account, so it has to clear a higher bar than "the voice check passed".
 * Measured on ai17z-main: sixteen original posts in three weeks, eleven of them
 * explaining an AI17Z feature, three nearly identical posts about a Telegram
 * alert inside two days, and two about "the self-hosted Chrome runtime" that
 * shared their opening and closing sentences. Every one had passed the voice
 * and repetition checks, because those ask whether a draft sounds like the
 * agent, not whether it has anything to say.
 *
 * Deterministic, for the reason `salience.ts` gives: "the model thought it was
 * a good post" is not a reason an owner can inspect or tune. Every refusal is a
 * sentence, and silence is the outcome of a refusal, never a retry.
 */

export interface PostQualityInput {
  draft: string;
  /** What the post was written from: the idea or brief. */
  source: string;
  /** The account's recent original posts, newest first. */
  recentPosts: readonly string[];
  /** Names that mean the agent or the product it runs on: display name, handles, AI17Z. */
  selfNames: readonly string[];
}

export interface PostQualityVerdict {
  post: boolean;
  /** Why not, in sentences. Empty when it may post. */
  reasons: string[];
  /** The measurements behind the verdict, for the trace. */
  factors: Record<string, number | boolean>;
}

/**
 * Words that describe AI17Z's own machinery.
 *
 * Two of these in a post that also names the product is a feature
 * announcement, which is what a marketing account posts and what the owner
 * asked this one to stop doing. One is fine: the agent may say what it runs on.
 */
const PRODUCT_TERMS = [
  'self-hosted', 'self hosted', 'local-first', 'runtime', 'signed-in browser', 'real browser', 'chrome',
  'telegram alert', 'worker', 'plugin', 'toolspace', 'your own machine', 'no api key', 'x api',
  'memory', 'persona', 'restart', 'resumes', 'open source', 'autonomous agent', 'feature', 'shipped',
];

/** Phrases that ask for engagement rather than earning it. */
const BAIT = [
  /\bwhat do you (all |guys )?think\??\s*$/i,
  /\bthoughts\?\s*$/i,
  /\blet'?s go\b/i,
  /\bgame[- ]?changer\b/i,
  /\bthe future is (here|now)\b/i,
  /\b(like|rt|retweet) if\b/i,
  /\bdrop (a|your)\b.*\bbelow\b/i,
  /\bwho else\b.*\?/i,
];

const WORD = /[a-z0-9$#@][a-z0-9'$#_-]*/g;
const FUNCTION = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'that', 'this', 'with', 'as',
  'at', 'be', 'are', 'was', 'i', 'you', 'we', 'they', 'not', 'if', 'so', 'just', 'what', 'from', 'by', 'its',
  "it's", 'my', 'your', 'me', 'do', 'does', 'have', 'has', 'can', 'will', 'there', 'than', 'then', 'about',
]);

function words(text: string): string[] {
  return (text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(WORD) ?? []);
}

function content(text: string): string[] {
  return words(text).filter((w) => !FUNCTION.has(w) && !w.startsWith('@'));
}

function grams(text: string, n: number): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i += 1) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/** Share of the draft's three-word runs that also appear in `other`. */
function overlap(draft: string, other: string): number {
  const a = grams(draft, 3);
  if (a.size === 0) return 0;
  const b = grams(other, 3);
  let shared = 0;
  for (const g of a) if (b.has(g)) shared += 1;
  return shared / a.size;
}

function aboutItself(text: string, selfNames: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return selfNames.some((name) => name.trim().length >= 3 && lower.includes(name.trim().toLowerCase().replace(/^@/, '')));
}

function productTerms(text: string): number {
  const lower = text.toLowerCase();
  return PRODUCT_TERMS.filter((term) => lower.includes(term)).length;
}

/** Whether a post announces the product rather than saying something. */
export function isSelfPromotion(text: string, selfNames: readonly string[]): boolean {
  const terms = productTerms(text);
  return (aboutItself(text, selfNames) && terms >= 2) || terms >= 4;
}

/** How many of the last few posts are too close to repeat? Three in a row about itself is a campaign. */
const PROMO_WINDOW = 5;
const PROMO_ALLOWED_IN_WINDOW = 1;

export function judgePost(input: PostQualityInput): PostQualityVerdict {
  const reasons: string[] = [];
  const draft = input.draft.trim();
  const substance = content(draft);

  // Something to say at all.
  if (substance.length < 5) reasons.push('It says almost nothing.');

  // Not the idea, reworded. A post that restates what somebody else wrote, or
  // what the agent already told one person, is an echo rather than a thought.
  const echo = input.source.trim() ? overlap(draft, input.source) : 0;
  if (echo >= 0.5) reasons.push('It mostly repeats what it was written from, rather than adding a view of its own.');

  // Not something it posted recently.
  let closest = 0;
  for (const post of input.recentPosts) closest = Math.max(closest, overlap(draft, post), overlap(post, draft));
  if (closest >= 0.3) reasons.push('It is too close to something the account already posted recently.');

  // Not another feature announcement.
  const promo = isSelfPromotion(draft, input.selfNames);
  const recentPromo = input.recentPosts.slice(0, PROMO_WINDOW).filter((p) => isSelfPromotion(p, input.selfNames)).length;
  if (promo && recentPromo >= PROMO_ALLOWED_IN_WINDOW) {
    reasons.push(`It is another post about the product itself, and ${recentPromo} of the last ${PROMO_WINDOW} already were.`);
  }

  // Earning a reaction, not asking for one.
  const bait = BAIT.some((pattern) => pattern.test(draft));
  if (bait) reasons.push('It asks for engagement instead of giving people something to react to.');

  return {
    post: reasons.length === 0,
    reasons,
    factors: {
      substance: substance.length,
      echo: Math.round(echo * 100) / 100,
      closestRecent: Math.round(closest * 100) / 100,
      selfPromotion: promo,
      recentSelfPromotion: recentPromo,
      bait,
    },
  };
}
