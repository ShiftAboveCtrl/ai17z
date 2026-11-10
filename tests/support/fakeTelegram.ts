import { vi } from 'vitest';

/**
 * A stand-in for the Telegram Bot API, installed over the global fetch.
 *
 * Only the HTTP boundary is replaced; the adapter, the repositories and the
 * runtime are real. Nothing here reaches the network, and a request to any host
 * but api.telegram.org fails the test rather than going anywhere.
 *
 * It behaves like the real thing where the behaviour is the point of a test:
 * `getUpdates` acknowledges everything before its offset and holds nothing
 * back after it, a webhook makes `getUpdates` a 409, and a revoked token is a
 * 401 for every method.
 */

export interface FakeBot {
  id: number;
  username: string;
  token: string;
  canJoinGroups: boolean;
  /** True when Group Privacy is OFF, which is the setting AI17Z refuses. */
  canReadAllGroupMessages: boolean;
  webhookUrl: string;
  revoked: boolean;
}

export interface BotCall {
  token: string;
  method: string;
  body: Record<string, unknown>;
}

export interface FakeUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

interface Sent {
  chatId: number;
  messageId: number;
  text: string;
  replyTo: number | null;
}

let nextBotId = 7_000_000_001;

export function tokenFor(id: number, secret = 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'): string {
  return `${id}:${secret}`;
}

export function fakeTelegram() {
  const bots = new Map<string, FakeBot>();
  const chats = new Map<number, { type: string; title: string; username?: string; members: Map<number, string> }>();
  const calls: BotCall[] = [];
  const sent: Sent[] = [];
  const reactions: { chatId: number; messageId: number; emoji: string }[] = [];
  const queues = new Map<string, { update_id: number; message?: unknown }[]>();
  let updateSeq = 100;
  let messageSeq = 5_000;
  let failNextSend: 'lose' | 'rate' | 'reject' | 'bad-gateway' | null = null;
  let retryAfter = 7;
  let rateLimitNextUpdates = false;

  function addBot(input: Partial<FakeBot> = {}): FakeBot {
    const id = input.id ?? nextBotId++;
    const bot: FakeBot = {
      id,
      username: input.username ?? `agent_${id}_bot`,
      token: input.token ?? tokenFor(id),
      canJoinGroups: input.canJoinGroups ?? true,
      canReadAllGroupMessages: input.canReadAllGroupMessages ?? false,
      webhookUrl: input.webhookUrl ?? '',
      revoked: false,
    };
    bots.set(bot.token, bot);
    queues.set(bot.token, []);
    return bot;
  }

  function addChat(id: number, input: { type?: string; title?: string; username?: string } = {}) {
    chats.set(id, {
      type: input.type ?? 'supergroup',
      title: input.title ?? `Group ${id}`,
      ...(input.username ? { username: input.username } : {}),
      members: new Map(),
    });
  }

  function join(chatId: number, bot: FakeBot, status = 'member') {
    chats.get(chatId)!.members.set(bot.id, status);
  }

  /** Queues a group message for a bot, as Telegram would after privacy filtering. */
  function say(
    bot: FakeBot,
    input: {
      chatId: number;
      from: FakeUser;
      text: string;
      mention?: boolean;
      replyTo?: { messageId: number; from: FakeUser; text?: string; forumTopicCreated?: boolean };
      chatType?: string;
      raw?: Record<string, unknown>;
    },
  ): number {
    const messageId = messageSeq++;
    const chat = chats.get(input.chatId);
    const text = input.mention ? `${input.text} @${bot.username}` : input.text;
    const message: Record<string, unknown> = {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: input.chatId, type: input.chatType ?? chat?.type ?? 'supergroup', title: chat?.title, ...(chat?.username ? { username: chat.username } : {}) },
      from: { first_name: 'Person', ...input.from },
      text,
      ...(input.mention
        ? { entities: [{ type: 'mention', offset: input.text.length + 1, length: bot.username.length + 1 }] }
        : {}),
      ...(input.replyTo
        ? {
            reply_to_message: {
              message_id: input.replyTo.messageId,
              date: Math.floor(Date.now() / 1000) - 60,
              from: input.replyTo.from,
              text: input.replyTo.text ?? 'an earlier message',
              ...(input.replyTo.forumTopicCreated ? { forum_topic_created: { name: 'topic' } } : {}),
            },
          }
        : {}),
      ...(input.raw ?? {}),
    };
    queues.get(bot.token)!.push({ update_id: updateSeq++, message });
    return messageId;
  }

  function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }
  const ok = (result: unknown) => json({ ok: true, result });
  const fail = (code: number, description: string, parameters?: Record<string, unknown>) =>
    json({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }, code);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://api.telegram.org') throw new Error('The test refused an unexpected host.');
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
      if (!match) return fail(404, 'Not Found');
      const [, token, method] = match as unknown as [string, string, string];
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ token, method, body });

      const bot = bots.get(token);
      if (!bot || bot.revoked) return fail(401, 'Unauthorized');

      switch (method) {
        case 'getMe':
          return ok({
            id: bot.id,
            is_bot: true,
            first_name: 'Agent',
            username: bot.username,
            can_join_groups: bot.canJoinGroups,
            can_read_all_group_messages: bot.canReadAllGroupMessages,
          });
        case 'getWebhookInfo':
          return ok({ url: bot.webhookUrl });
        case 'getUpdates': {
          if (rateLimitNextUpdates) {
            rateLimitNextUpdates = false;
            return fail(429, 'Too Many Requests: retry after 61', { retry_after: 61 });
          }
          if (bot.webhookUrl) return fail(409, 'Conflict: can\'t use getUpdates method while webhook is active');
          const queue = queues.get(token)!;
          const offset = typeof body.offset === 'number' ? body.offset : null;
          // Telegram forgets what the offset confirms.
          if (offset !== null) queues.set(token, queue.filter((u) => u.update_id >= offset));
          return ok(queues.get(token)!.slice(0, Number(body.limit ?? 100)));
        }
        case 'getChat': {
          const chat = chats.get(Number(body.chat_id));
          if (!chat) return fail(400, 'Bad Request: chat not found');
          return ok({ id: Number(body.chat_id), type: chat.type, title: chat.title, ...(chat.username ? { username: chat.username } : {}), description: 'A crypto community.' });
        }
        case 'getChatMember': {
          const chat = chats.get(Number(body.chat_id));
          if (!chat) return fail(400, 'Bad Request: chat not found');
          const status = chat.members.get(Number(body.user_id)) ?? 'left';
          return ok({ status, ...(status === 'restricted' ? { can_send_messages: false } : {}) });
        }
        case 'getChatMemberCount':
          return ok(1234);
        case 'sendMessage': {
          if (failNextSend === 'rate') {
            failNextSend = null;
            return fail(429, 'Too Many Requests: retry after 7', { retry_after: retryAfter });
          }
          if (failNextSend === 'reject') {
            failNextSend = null;
            return fail(400, 'Bad Request: message to be replied not found');
          }
          if (failNextSend === 'bad-gateway') {
            failNextSend = null;
            return new Response('<html>502</html>', { status: 502 });
          }
          const chatId = Number(body.chat_id);
          const messageId = messageSeq++;
          sent.push({
            chatId,
            messageId,
            text: String(body.text),
            replyTo: (body.reply_parameters as { message_id?: number } | undefined)?.message_id ?? null,
          });
          if (failNextSend === 'lose') {
            // Telegram delivered it and the answer never arrived.
            failNextSend = null;
            throw new TypeError('fetch failed');
          }
          return ok({ message_id: messageId, chat: { id: chatId } });
        }
        case 'setMessageReaction': {
          const emoji = (body.reaction as { emoji: string }[])[0]!.emoji;
          if (emoji === '💯' && body.chat_id === -1009999999999) return fail(400, 'Bad Request: REACTION_INVALID');
          reactions.push({ chatId: Number(body.chat_id), messageId: Number(body.message_id), emoji });
          return ok(true);
        }
        default:
          return fail(404, 'Not Found');
      }
    }),
  );

  return {
    addBot,
    addChat,
    join,
    say,
    calls,
    sent,
    reactions,
    queued: (bot: FakeBot) => queues.get(bot.token)!.length,
    callsFor: (token: string, method?: string) => calls.filter((c) => c.token === token && (!method || c.method === method)),
    /** The next sendMessage fails: 'lose' delivers it and loses the answer. */
    failNextSend(kind: 'lose' | 'rate' | 'reject' | 'bad-gateway') {
      failNextSend = kind;
    },
    /** The next getUpdates is a 429 asking for sixty-one seconds. */
    rateLimitNextUpdates() {
      rateLimitNextUpdates = true;
    },
    setRetryAfter(seconds: number) {
      retryAfter = seconds;
    },
    clear() {
      calls.length = 0;
    },
  };
}
