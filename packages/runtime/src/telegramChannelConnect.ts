import type { Account } from '@xbam/shared/contracts';
import { TELEGRAM_TOKEN_PATTERN, TelegramChatId } from '@xbam/shared/contracts';
import { BadRequestError, PipelineError, createLogger } from '@xbam/shared';
import { accounts, telegramChannel } from '@xbam/database';
import { describeTelegramChat, inspectTelegramBot, telegramAdapter } from '@xbam/channels';
import { SHARED_BOT_MESSAGE, agentBotToken, sharesNotificationBot } from './telegramBotGuard';

type TelegramChat = telegramChannel.TelegramChat;
type TelegramPresence = telegramChannel.TelegramPresence;

const log = createLogger('telegram-channel');

/**
 * Linking a Telegram bot to an agent account, and choosing its groups.
 *
 * The same order Bluesky and Farcaster use: prove first, keep second, seal
 * third. A token that Telegram does not accept creates neither an account row
 * nor a sealed credential, and the response is the account, which has never
 * had a secret on it.
 */

/** What a person did wrong becomes a sentence; what Telegram did wrong stays an error. */
function asBadRequest(error: unknown): never {
  if (error instanceof PipelineError && error.errorClass === 'PERMANENT') throw new BadRequestError(error.message);
  throw error;
}

async function proveToken(raw: string) {
  const token = raw.trim();
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) {
    throw new BadRequestError(
      'That does not look like a bot token. It is a number, a colon, then a long string: copy the whole line BotFather sent.',
    );
  }
  // Before Telegram is asked anything, so the refusal needs no network.
  if (await sharesNotificationBot(token)) throw new BadRequestError(SHARED_BOT_MESSAGE);
  const bot = await inspectTelegramBot(token).catch(asBadRequest);
  return { token, bot };
}

export async function connectTelegramGroupAccount(input: { ownerId: string; token: string }): Promise<Account> {
  const { token, bot } = await proveToken(input.token);
  return telegramChannel.createWithBot({
    ownerId: input.ownerId,
    bot,
    token,
    capabilities: [...telegramAdapter.capabilities],
  });
}

/** After /revoke in BotFather: the same bot, a new token. */
export async function replaceTelegramGroupToken(accountId: string, rawToken: string): Promise<Account> {
  const { token, bot } = await proveToken(rawToken);
  await telegramChannel.replaceToken(accountId, bot, token);
  return accounts.requireAccount(accountId);
}

/** Drops the sealed token and switches the account off. The allowlist stays. */
export async function disconnectTelegramGroupAccount(accountId: string): Promise<void> {
  await telegramChannel.clearBot(accountId);
}

/**
 * Tries the stored token again.
 *
 * Without one the account settles at NEEDS_AUTH, which takes it out of the due
 * list. A token Telegram has revoked does the same, so a dead bot is not polled
 * back into a 401 every few minutes.
 */
export async function reconnectTelegramGroupAccount(accountId: string): Promise<Account> {
  let status: Account['status'] = 'NEEDS_AUTH';
  let detail = 'Store a Telegram bot token for this account.';
  try {
    const token = await agentBotToken(accountId);
    if (token) {
      const bot = await inspectTelegramBot(token);
      const stored = await telegramChannel.identity(accountId);
      if (stored && stored.botId !== bot.botId) {
        detail = 'The stored token belongs to a different bot than this account.';
      } else {
        status = 'CONNECTED';
        detail = 'Bot verified.';
      }
    }
  } catch (error) {
    if (!(error instanceof PipelineError)) throw error;
    // A configuration or credential fault is the owner's to fix; a Telegram
    // outage is not a reason to declare the token bad.
    if (error.errorClass === 'PERMANENT') detail = error.message;
    else throw error;
  }
  await accounts.updateAccount(accountId, {
    status,
    enabled: status === 'CONNECTED',
    lastHealthStatus: detail,
    lastError: status === 'CONNECTED' ? null : detail,
    touchHealthCheck: true,
  });
  return accounts.requireAccount(accountId);
}

export interface TelegramOverview extends TelegramPresence {
  chats: TelegramChat[];
}

export async function telegramGroupOverview(accountId: string): Promise<TelegramOverview> {
  return { ...(await telegramChannel.presence(accountId)), chats: await telegramChannel.listChats(accountId) };
}

/**
 * A group id from what an owner can actually get hold of.
 *
 * Telegram shows no chat id anywhere in its apps. What it does give is a link:
 * "Copy Message Link" on a message in a private supergroup produces
 * `https://t.me/c/1234567890/5`, and the chat id is `-100` followed by the
 * first number.
 */
export function chatIdFromInput(input: string): string {
  const text = input.trim();
  const link = /^(?:https?:\/\/)?t\.me\/c\/(\d{1,15})(?:\/\d+)*\/?$/i.exec(text);
  const id = link ? `-100${link[1]}` : text;
  if (!id.startsWith('-') || !TelegramChatId.safeParse(id).success) {
    throw new BadRequestError(
      'Give the group\'s chat id (it starts with a minus sign) or a message link copied from the group, like https://t.me/c/1234567890/5.',
    );
  }
  return id;
}

/** Adds a group to the list, after checking the bot is really in it. */
export async function allowTelegramGroup(accountId: string, input: string): Promise<TelegramChat> {
  const chatId = chatIdFromInput(input);
  const bot = await telegramChannel.identity(accountId);
  const token = await agentBotToken(accountId).catch(asBadRequest);
  if (!bot || !token) throw new BadRequestError('Store this account\'s bot token first.');
  const chat = await describeTelegramChat(token, chatId, bot.botId).catch(asBadRequest);
  await telegramChannel.allowChat(accountId, chatId, chat.title);
  log.info('a group was allowed', { accountId, chatId });
  return { chatId, title: chat.title };
}

export async function forgetTelegramGroup(accountId: string, input: string): Promise<boolean> {
  return telegramChannel.forgetChat(accountId, chatIdFromInput(input));
}
