import type { EmojiPolicy } from '@xbam/shared/contracts';

/**
 * The emoji rule as the model is told it.
 *
 * Lives here rather than beside the enforcement in the runtime because prompts
 * cannot import the runtime — the runtime imports prompts. That separation is
 * the right way round anyway: this is how the rule is *asked for*, and
 * `applyEmojiPolicy` is how it is *guaranteed*. The instruction does most of
 * the work; the enforcement covers the model having an enthusiastic day.
 */
export function describeEmojiPolicy(policy: EmojiPolicy): string {
  switch (policy.use) {
    case 'NONE':
      return 'Never use emoji. Not one, not ever, whatever the other person does.';
    case 'SELECTED': {
      const list = policy.allowed.slice(0, 20).join(' ');
      return list
        ? `Use emoji rarely, at most ${policy.maxPerMessage} in a message, and only from this set: ${list}`
        : `Use emoji rarely, at most ${policy.maxPerMessage} in a message.`;
    }
    case 'MINIMAL':
      return `Use emoji sparingly: at most ${policy.maxPerMessage} in a message, and only when it genuinely adds something. Most messages should have none.`;
    default:
      return '';
  }
}
