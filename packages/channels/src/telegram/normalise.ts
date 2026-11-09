import { z } from 'zod';
import { ContextPost, NormalizedEvent, ResolvedContext, telegramMessageRef } from '@xbam/shared/contracts';
import { TelegramUpdate, type RepliedTo, type TelegramMessage, type TelegramUser } from './client';

/**
 * Update to event, and event to context. Pure: no network, no database.
 *
 * This is the only place that decides what a Telegram message means to the
 * agent, and the decision is narrow on purpose. A message is read when it comes
 * from an allowed group AND it @mentions this bot or replies to one of its
 * messages. Everything else yields nothing: no event, no row, no log line
 * naming who said what.
 */

export interface BotIdentity {
  botId: string;
  botUsername: string;
}

export type Addressing = 'mention' | 'reply';

/** Groups only. A private chat with the bot is not a place the agent speaks. */
const GROUP_TYPES = new Set(['group', 'supergroup']);

const nameOf = (user: TelegramUser): string => [user.first_name, user.last_name].filter(Boolean).join(' ').trim();

/** The handle shown downstream. Telegram usernames are optional, the id never is. */
const handleOf = (user: TelegramUser): string => user.username ?? `user:${user.id}`;

/** A message link people can open: public groups by name, supergroups by their private form. */
export function messageUrl(chat: { id: string; username?: string | null }, messageId: number): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const match = /^-100(\d{1,15})$/.exec(chat.id);
  return match ? `https://t.me/c/${match[1]}/${messageId}` : null;
}

/**
 * Whether this message is addressed to the bot, and how.
 *
 * Entity offsets are UTF-16 code units, which is what JavaScript string indices
 * are, so slicing by them is correct for text with emoji in it.
 */
export function addressing(message: TelegramMessage, bot: BotIdentity): Addressing | null {
  const text = message.text ?? message.caption ?? '';
  const entities = message.text !== undefined ? (message.entities ?? []) : (message.caption_entities ?? []);
  const tag = `@${bot.botUsername}`.toLowerCase();

  // A reply to one of the bot's own messages. The topic-creation message a forum
  // attaches to every message in a topic is not a reply to anybody.
  const parent = message.reply_to_message;
  if (parent && parent.forum_topic_created === undefined && parent.from && String(parent.from.id) === bot.botId) {
    return 'reply';
  }

  for (const entity of entities) {
    if (entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === tag) {
      return 'mention';
    }
    if (entity.type === 'text_mention' && entity.user && String(entity.user.id) === bot.botId) return 'mention';
  }
  return null;
}

function parentOf(parent: RepliedTo | undefined, chatId: string, bot: BotIdentity) {
  if (!parent || parent.forum_topic_created !== undefined) return null;
  return {
    remoteId: telegramMessageRef(chatId, parent.message_id),
    authorId: parent.from ? String(parent.from.id) : null,
    authorHandle: parent.from ? handleOf(parent.from) : null,
    text: (parent.text ?? parent.caption ?? '').slice(0, 4_096),
    createdAt: new Date(parent.date * 1000).toISOString(),
    isSelf: parent.from ? String(parent.from.id) === bot.botId : false,
  };
}

/** What `NormalizedEvent.raw` carries for Telegram. Read back by `contextOf`. */
const RAW = z.object({
  addressedToAgent: z.literal(true),
  addressedBy: z.enum(['mention', 'reply']),
  chat: z.object({
    id: z.string(),
    type: z.string(),
    title: z.string().nullable(),
    username: z.string().nullable(),
  }),
  parent: z
    .object({
      remoteId: z.string(),
      authorId: z.string().nullable(),
      authorHandle: z.string().nullable(),
      text: z.string(),
      createdAt: z.string(),
      isSelf: z.boolean(),
    })
    .nullable(),
});

/**
 * One update, or nothing.
 *
 * `allowed` is the owner's list of group ids. A message from any other chat is
 * dropped here, silently: replying "I am not allowed here" would confirm to
 * anyone who added the bot that it is alive and listening.
 */
export function eventOf(update: unknown, bot: BotIdentity, allowed: ReadonlySet<string>): NormalizedEvent | null {
  const parsed = TelegramUpdate.safeParse(update);
  if (!parsed.success || !parsed.data.message) return null;
  const message = parsed.data.message;
  const chatId = String(message.chat.id);

  if (!GROUP_TYPES.has(message.chat.type) || !allowed.has(chatId)) return null;
  const from = message.from;
  // Bots do not talk to bots here. That includes this one, and it is also what
  // keeps two agents in one group from answering each other for ever.
  if (!from || from.is_bot === true || message.via_bot) return null;
  const text = (message.text ?? message.caption ?? '').trim();
  if (!text) return null;

  const how = addressing(message, bot);
  if (!how) return null;

  const ref = telegramMessageRef(chatId, message.message_id);
  const parent = parentOf(message.reply_to_message, chatId, bot);
  return NormalizedEvent.parse({
    channel: 'telegram',
    type: how === 'reply' ? 'REPLY' : 'MENTION',
    remoteEventId: ref,
    remoteMessageId: ref,
    remoteAuthorId: String(from.id),
    remoteAuthorHandle: handleOf(from),
    remoteAuthorDisplayName: nameOf(from) || null,
    remoteConversationId: parent ? parent.remoteId : ref,
    parentRemoteMessageId: parent ? parent.remoteId : null,
    remoteUrl: messageUrl({ id: chatId, username: message.chat.username }, message.message_id),
    text,
    occurredAt: new Date(message.date * 1000).toISOString(),
    raw: {
      addressedToAgent: true,
      addressedBy: how,
      chat: {
        id: chatId,
        type: message.chat.type,
        title: message.chat.title ?? null,
        username: message.chat.username ?? null,
      },
      parent,
    },
  });
}

/**
 * The conversation, from what the update itself carried.
 *
 * The Bot API has no call that reads a message or a history, so there is no
 * thread to fetch: Telegram puts the message being replied to inside the
 * update, and that one message is all the context there is. It is said plainly
 * in `note` rather than dressed up as a resolved thread.
 */
export function contextOf(event: NormalizedEvent): ResolvedContext {
  const raw = RAW.safeParse(event.raw);
  const parent = raw.success ? raw.data.parent : null;
  const incoming = ContextPost.parse({
    remoteId: event.remoteMessageId,
    remoteUrl: event.remoteUrl,
    authorHandle: event.remoteAuthorHandle,
    authorDisplayName: event.remoteAuthorDisplayName,
    text: event.text,
    createdAt: event.occurredAt,
    isSelf: false,
    authorVerified: null,
  });
  const parentPost = parent
    ? ContextPost.parse({
        remoteId: parent.remoteId,
        remoteUrl: null,
        authorHandle: parent.authorHandle,
        authorDisplayName: null,
        text: parent.text,
        createdAt: parent.createdAt,
        isSelf: parent.isSelf,
        authorVerified: null,
      })
    : null;
  return ResolvedContext.parse({
    targetRef: event.remoteMessageId,
    targetUrl: event.remoteUrl,
    targetAuthorHandle: event.remoteAuthorHandle,
    conversationRef: event.remoteConversationId,
    incomingText: event.text,
    parentText: parentPost?.text ?? null,
    thread: parentPost
      ? [
          {
            role: parentPost.isSelf ? 'OUTBOUND' : 'INBOUND',
            remoteMessageId: parentPost.remoteId,
            authorHandle: parentPost.authorHandle,
            text: parentPost.text,
            createdAt: parentPost.createdAt,
          },
        ]
      : [],
    conversation: {
      incoming,
      parent: parentPost,
      ancestors: parentPost ? [parentPost] : [],
      root: parentPost ?? incoming,
      quote: null,
      participants: [...new Set([parentPost?.authorHandle, incoming.authorHandle].filter((h): h is string => Boolean(h)))],
      excludedCount: 0,
      method: 'EVENT_ONLY',
      branchConfirmed: false,
      note: 'Telegram does not let a bot read a group history. The only earlier message shown is the one this replies to, as the update carried it.',
    },
    meta: {},
  });
}
