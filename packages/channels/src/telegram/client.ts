import { z } from 'zod';
import { PipelineError } from '@xbam/shared';

/**
 * The Telegram Bot API, in the calls an agent in a group needs.
 *
 * This is the agent channel's own client. It is deliberately not
 * `runtime/src/telegramApi.ts`, which belongs to the owner notification
 * transport: that one carries the installation's voice to its owner and this one
 * carries an agent's. Sharing a client would be one import away from sharing a
 * token, and the two are kept apart on purpose (see TELEGRAM_CHANNEL.md).
 *
 * The token is part of the URL, so nothing here puts a URL, a request body or a
 * raw response into an error message or a log line. Every message below is a
 * fixed sentence, and Telegram's own `description` is only ever quoted for a
 * refusal of the request the caller made, which never contains the token.
 */

const API = 'https://api.telegram.org';
const BASE_TIMEOUT_MS = 15_000;

/**
 * Whether Telegram said no, or merely did not say.
 *
 * A write must tell these apart. A refusal (`refused: true`) proves nothing was
 * sent, so the attempt can be forgotten and retried. Anything else (a dropped
 * connection, a timeout, a 502 from a proxy) may have been delivered, and a
 * reply sent a second time into a public group is worse than one that is late.
 */
export function wasRefused(error: unknown): boolean {
  return error instanceof PipelineError && error.data.refused === true;
}

function refusal(
  make: typeof PipelineError.permanent,
  reason: string,
  message: string,
  data: Record<string, unknown> = {},
): PipelineError {
  return make(reason, message, { ...data, refused: true });
}

const ENVELOPE = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

/** Telegram's wording trimmed to something safe to show, for a request it refused. */
function said(description: string | undefined): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : 'no reason given';
}

export async function callBot<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  options: { holdSeconds?: number } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(BASE_TIMEOUT_MS + (options.holdSeconds ?? 0) * 1000),
    });
  } catch {
    // No answer at all. The message must not echo the error: undici's can carry the URL.
    throw PipelineError.retryable('telegram_unavailable', 'Telegram could not be reached.', { refused: false });
  }

  let envelope: z.infer<typeof ENVELOPE>;
  try {
    const parsed = ENVELOPE.safeParse(await response.json());
    if (!parsed.success) throw new Error('shape');
    envelope = parsed.data;
  } catch {
    throw PipelineError.retryable('telegram_unreadable', 'Telegram answered with something that could not be read.', {
      refused: false,
    });
  }

  if (envelope.ok) return envelope.result as T;

  const status = envelope.error_code ?? response.status;
  const detail = said(envelope.description);
  if (status === 429) {
    const seconds = envelope.parameters?.retry_after;
    const retryAfterMs = Math.max(1_000, Math.ceil(typeof seconds === 'number' && seconds > 0 ? seconds : 30) * 1000);
    throw refusal(PipelineError.retryable, 'telegram_rate_limited', 'Telegram asked this bot to slow down.', { retryAfterMs });
  }
  if (status === 401 || status === 404) {
    throw refusal(
      PipelineError.permanent,
      'telegram_auth_failed',
      'Telegram does not accept this bot token. It may have been revoked.',
    );
  }
  if (status === 403) {
    throw refusal(
      PipelineError.permanent,
      'telegram_forbidden',
      'Telegram will not let this bot do that. It may have been removed from the group.',
    );
  }
  if (status === 409) {
    // Another consumer is reading this bot's updates, or a webhook is set.
    throw refusal(
      PipelineError.retryable,
      'telegram_conflict',
      'Something else is reading this bot. Use a bot that only AI17Z reads, with no webhook.',
      { retryAfterMs: 5 * 60_000 },
    );
  }
  if (status >= 500) {
    // A server error does not prove the request was not processed.
    throw PipelineError.retryable('telegram_unavailable', 'Telegram is temporarily unavailable.', { refused: false });
  }
  if (/chat not found/i.test(detail)) {
    throw refusal(
      PipelineError.permanent,
      'telegram_chat_not_found',
      'Telegram cannot find that group for this bot. Add the bot to the group first.',
    );
  }
  if (/REACTION_INVALID/i.test(detail)) {
    throw refusal(PipelineError.permanent, 'telegram_reaction_invalid', 'Telegram does not allow that reaction here.');
  }
  if (/message to be replied not found|message to react not found|MESSAGE_ID_INVALID/i.test(detail)) {
    throw refusal(PipelineError.permanent, 'telegram_message_gone', 'The message this refers to is no longer in the group.');
  }
  throw refusal(PipelineError.permanent, 'telegram_rejected', `Telegram refused the request: ${detail}`);
}

// ── What comes back ──────────────────────────────────────────────────────────

export const BotUser = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean(),
  first_name: z.string().default(''),
  username: z.string().optional(),
  can_join_groups: z.boolean().optional(),
  can_read_all_group_messages: z.boolean().optional(),
});
export type BotUser = z.infer<typeof BotUser>;

const User = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});
export type TelegramUser = z.infer<typeof User>;

const Chat = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
  is_forum: z.boolean().optional(),
});

const Entity = z.object({
  type: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  user: User.optional(),
});

/** The message a reply points at. Telegram does not nest this any deeper. */
const RepliedTo = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int().nonnegative(),
  from: User.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  forum_topic_created: z.unknown().optional(),
});
export type RepliedTo = z.infer<typeof RepliedTo>;

export const TelegramMessage = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int().nonnegative(),
  chat: Chat,
  from: User.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  entities: z.array(Entity).optional(),
  caption_entities: z.array(Entity).optional(),
  reply_to_message: RepliedTo.optional(),
  message_thread_id: z.number().int().optional(),
  via_bot: User.optional(),
});
export type TelegramMessage = z.infer<typeof TelegramMessage>;

export const TelegramUpdate = z.object({
  update_id: z.number().int().nonnegative(),
  message: TelegramMessage.optional(),
});

const WebhookInfo = z.object({ url: z.string().default('') });

const ChatFull = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
  description: z.string().optional(),
});

const ChatMember = z.object({
  status: z.string(),
  can_send_messages: z.boolean().optional(),
});

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw PipelineError.retryable('telegram_unreadable', 'Telegram answered with something that could not be read.', {
      refused: false,
    });
  }
  return result.data;
}

export async function getMe(token: string): Promise<BotUser> {
  return parsed(BotUser, await callBot(token, 'getMe'));
}

export async function getWebhookUrl(token: string): Promise<string> {
  return parsed(WebhookInfo, await callBot(token, 'getWebhookInfo')).url;
}

/**
 * Raw updates, each parsed on its own by the caller.
 *
 * Only `message` is asked for, so edits, channel posts, joins and reactions never
 * arrive. `offset` acknowledges everything before it; the caller commits it only
 * after the batch has been ingested.
 */
export async function getUpdates(
  token: string,
  input: { offset: number | null; limit: number; holdSeconds: number },
): Promise<unknown[]> {
  const result = await callBot<unknown>(
    token,
    'getUpdates',
    {
      ...(input.offset === null ? {} : { offset: input.offset }),
      limit: input.limit,
      timeout: input.holdSeconds,
      allowed_updates: ['message'],
    },
    { holdSeconds: input.holdSeconds },
  );
  return parsed(z.array(z.unknown()), result);
}

export async function sendReply(
  token: string,
  input: { chatId: string; replyTo: number; text: string },
): Promise<{ messageId: number }> {
  const sent = parsed(
    z.object({ message_id: z.number().int().positive() }),
    await callBot(token, 'sendMessage', {
      chat_id: Number(input.chatId),
      text: input.text,
      reply_parameters: { message_id: input.replyTo, allow_sending_without_reply: false },
      link_preview_options: { is_disabled: true },
    }),
  );
  return { messageId: sent.message_id };
}

export async function setReaction(
  token: string,
  input: { chatId: string; messageId: number; emoji: string },
): Promise<void> {
  await callBot(token, 'setMessageReaction', {
    chat_id: Number(input.chatId),
    message_id: input.messageId,
    reaction: [{ type: 'emoji', emoji: input.emoji }],
  });
}

export async function getChat(token: string, chatId: string) {
  return parsed(ChatFull, await callBot(token, 'getChat', { chat_id: Number(chatId) }));
}

export async function getChatMemberCount(token: string, chatId: string): Promise<number> {
  return parsed(z.number().int().nonnegative(), await callBot(token, 'getChatMemberCount', { chat_id: Number(chatId) }));
}

export async function getBotMembership(token: string, chatId: string, botId: string) {
  return parsed(ChatMember, await callBot(token, 'getChatMember', { chat_id: Number(chatId), user_id: Number(botId) }));
}
