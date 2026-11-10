import { PipelineError, openSecret } from '@xbam/shared';
import { telegramBotIdOfToken } from '@xbam/shared/contracts';
import { telegramChannel } from '@xbam/database';
import { loadConfig } from './telegram';

/**
 * Keeps the agent channel's bots apart from the owner's notification bot.
 *
 * They are two different things that happen to use one API. The notification
 * bot speaks for the installation, reads one paired chat for commands, and keeps
 * its update offset in `settings`. An agent's bot speaks for the agent, in groups
 * the owner allowed, and keeps its offset on `telegram_bots`. If one token served
 * both, each `getUpdates` would acknowledge the other's messages, a group member
 * could type at the owner's command surface, and the owner's notifications would
 * be readable by a bot that sits in public groups.
 *
 * Nothing here changes `telegram.ts`: it only reads what that file stores.
 */

/** The numeric bot id of the notification bot, or null when none is connected. */
export async function notificationBotId(): Promise<string | null> {
  const config = await loadConfig();
  if (!config.tokenSealed) return null;
  try {
    return telegramBotIdOfToken(openSecret(config.tokenSealed));
  } catch {
    // A token that cannot be opened is not one that can be shared.
    return null;
  }
}

export const SHARED_BOT_MESSAGE =
  'That is the bot AI17Z uses to send you notifications. Make a separate bot with BotFather for the agent, because a bot that sits in public groups must not also be the one that reaches you.';

/** True when this token belongs to the same bot as the notification transport. */
export async function sharesNotificationBot(token: string): Promise<boolean> {
  const id = telegramBotIdOfToken(token);
  return id !== null && id === (await notificationBotId());
}

/**
 * The agent account's token, opened for one call.
 *
 * The check runs on every open, not only when the bot was linked. An owner can
 * connect the notification transport to the same bot afterwards, and the
 * transport does not know about this channel, so this is the side that has to
 * notice. It refuses before a single request is made.
 */
export async function agentBotToken(accountId: string): Promise<string | null> {
  const token = await telegramChannel.getDecryptedToken(accountId);
  if (!token) return null;
  if (await sharesNotificationBot(token)) {
    throw PipelineError.permanent('telegram_shared_bot', SHARED_BOT_MESSAGE);
  }
  return token;
}
