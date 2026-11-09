import { z } from 'zod';

/**
 * The values `telegram_outbox.state` may hold. A database CHECK backs it, so it
 * is listed in tests/integration/statusConstraints.test.ts.
 */
export const TELEGRAM_OUTBOX_STATES = ['SENDING', 'SENT'] as const;
export type TelegramOutboxState = (typeof TELEGRAM_OUTBOX_STATES)[number];

/** A chat id as Telegram prints it: negative for groups, thirteen digits for supergroups. */
export const TelegramChatId = z
  .string()
  .regex(/^-?[1-9][0-9]{0,18}$/)
  .refine((value) => Number.isSafeInteger(Number(value)), 'Telegram chat ids fit in 53 bits.');

/**
 * What an action names on Telegram: `telegram:<chat id>:<message id>`.
 *
 * Message ids are only unique inside one chat, so the chat is part of the
 * identity. A bare message id is refused rather than guessed at.
 */
export const TelegramMessageRef = z
  .string()
  .regex(/^telegram:-?[1-9][0-9]{0,18}:[1-9][0-9]{0,12}$/)
  .refine((value) => Number.isSafeInteger(Number(value.split(':')[1])), 'Telegram chat ids fit in 53 bits.');

/**
 * A bot token as BotFather prints it: `<bot id>:<secret>`.
 *
 * Checked before Telegram is asked anything, so a paste mistake is a sentence
 * and not a round trip.
 */
export const TELEGRAM_TOKEN_PATTERN = /^[1-9]\d{4,18}:[A-Za-z0-9_-]{20,}$/;

/** The numeric id at the front of a token. Public: it is in the bot's own link. */
export function telegramBotIdOfToken(token: string): string | null {
  return TELEGRAM_TOKEN_PATTERN.test(token) ? token.slice(0, token.indexOf(':')) : null;
}

/** What the agent may know about an allowed group. Absent is null, never zero. */
export const TelegramChatInfo = z.object({
  chatId: TelegramChatId,
  type: z.enum(['group', 'supergroup']),
  title: z.string().max(300),
  username: z.string().max(100).nullable(),
  description: z.string().max(2_000).nullable(),
  memberCount: z.number().int().nonnegative().nullable(),
});
export type TelegramChatInfo = z.infer<typeof TelegramChatInfo>;

/** The reactions an agent may set. A closed list, so a model cannot invent one. */
export const TELEGRAM_REACTIONS = ['👍', '❤', '🔥', '🎉', '👏', '🤔', '😁', '👀', '💯'] as const;
export const TelegramReaction = z.enum(TELEGRAM_REACTIONS);
export type TelegramReaction = (typeof TELEGRAM_REACTIONS)[number];

export function telegramMessageRef(chatId: string, messageId: number | string): string {
  return `telegram:${chatId}:${messageId}`;
}

export function parseTelegramMessageRef(ref: string | null): { chatId: string; messageId: number } | null {
  if (!ref || !TelegramMessageRef.safeParse(ref).success) return null;
  const [, chatId, messageId] = ref.split(':');
  return { chatId: chatId!, messageId: Number(messageId) };
}
