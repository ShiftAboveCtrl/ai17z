import type { EmojiPolicy } from '@xbam/shared/contracts';

/**
 * Keeping emoji to what somebody asked for.
 *
 * Models left alone punctuate every other sentence with one, and an account
 * that does that reads as a bot to every human who sees it. Telling the model
 * to go easy helps and does not hold: it is the kind of instruction that decays
 * over a long prompt and evaporates when the incoming message is cheerful.
 *
 * So this is enforcement, applied to the finished text. Surplus emoji are
 * removed rather than the message being rejected, because the sentence is
 * usually fine and the decoration is the problem.
 */

/**
 * Matches a single emoji, including the multi-codepoint ones.
 *
 * Built from Unicode property escapes so it stays correct as Unicode grows:
 * `Extended_Pictographic` is the property that actually means "emoji", and the
 * surrounding parts catch skin tones, flags, keycaps and ZWJ sequences that
 * would otherwise be torn in half and leave debris behind.
 */
const EMOJI = new RegExp(
  '(?:\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*)' +
    '|(?:\\p{Regional_Indicator}\\p{Regional_Indicator})' +
    '|(?:[0-9#*]\\uFE0F?\\u20E3)',
  'gu',
);

export interface EmojiOutcome {
  text: string;
  /** How many were taken out. Zero means the text was already within policy. */
  removed: number;
  /** Said in words, for the trace and the review screen. */
  reason: string | null;
}

/** Every emoji in the text, in order, as whole graphemes. */
export function findEmoji(text: string): string[] {
  return [...text.matchAll(EMOJI)].map((m) => m[0]);
}

export function countEmoji(text: string): number {
  return findEmoji(text).length;
}

/**
 * Tidies whitespace after removing something from the middle of a sentence.
 *
 * Stripping an emoji leaves a double space, or a space before a full stop, and
 * a reply with those in it looks more careless than one with an emoji in it.
 */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Applies the policy to finished text.
 *
 * `messageIndex` decides the frequency rule: a percentage means "roughly this
 * share of messages may carry one", and with nothing to count against it the
 * only honest reading is to allow it. Callers pass a stable per-agent counter
 * when they have one.
 */
export function applyEmojiPolicy(
  text: string,
  policy: EmojiPolicy,
  options: { messageIndex?: number } = {},
): EmojiOutcome {
  if (policy.use === 'UNRESTRICTED') return { text, removed: 0, reason: null };

  const present = findEmoji(text);
  if (present.length === 0) return { text, removed: 0, reason: null };

  if (policy.use === 'NONE') {
    return {
      text: tidy(text.replace(EMOJI, '')),
      removed: present.length,
      reason: `Removed ${present.length} emoji: this agent uses none.`,
    };
  }

  // The frequency rule, when the caller can say which message this is. A share
  // of 25 means one message in four; the rest carry none however few they used.
  if (typeof options.messageIndex === 'number' && policy.messagesPercent < 100) {
    const allowedThisMessage =
      policy.messagesPercent > 0 && (options.messageIndex * policy.messagesPercent) % 100 < policy.messagesPercent;
    if (!allowedThisMessage) {
      return {
        text: tidy(text.replace(EMOJI, '')),
        removed: present.length,
        reason: `Removed ${present.length} emoji: this agent uses them in about ${policy.messagesPercent}% of messages and this is not one of them.`,
      };
    }
  }

  const allowed = new Set(policy.allowed.map((e) => e.trim()).filter(Boolean));
  let kept = 0;
  let removed = 0;
  let offList = 0;

  const result = text.replace(EMOJI, (match) => {
    if (policy.use === 'SELECTED' && !allowed.has(match)) {
      removed += 1;
      offList += 1;
      return '';
    }
    if (kept >= policy.maxPerMessage) {
      removed += 1;
      return '';
    }
    kept += 1;
    return match;
  });

  if (removed === 0) return { text, removed: 0, reason: null };

  const parts: string[] = [];
  if (offList > 0) parts.push(`${offList} not on this agent's list`);
  if (removed - offList > 0) parts.push(`${removed - offList} over the limit of ${policy.maxPerMessage}`);
  return {
    text: tidy(result),
    removed,
    reason: `Removed ${removed} emoji (${parts.join(', ')}).`,
  };
}
