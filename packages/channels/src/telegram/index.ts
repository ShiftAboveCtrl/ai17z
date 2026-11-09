import { telegramChannel } from '@xbam/database';
import { PipelineError, envInt, sha256Hex } from '@xbam/shared';
import {
  TELEGRAM_REACTIONS,
  TelegramChatInfo,
  parseTelegramMessageRef,
  telegramMessageRef,
} from '@xbam/shared/contracts';
import type { ActionRequest, ChannelAdapter, ChannelContext, IngestOptions } from '../contract';
import {
  getBotMembership,
  getChat,
  getChatMemberCount,
  getMe,
  getUpdates,
  getWebhookUrl,
  sendReply,
  setReaction,
  wasRefused,
} from './client';
import { contextOf, eventOf, messageUrl, type BotIdentity } from './normalise';

/**
 * How long Telegram may hold a poll open waiting for a message.
 *
 * The poller walks its due accounts one after another, so a long hold here is
 * time every other account waits. Five seconds still turns an idle poll into a
 * real long poll, without letting one quiet group slow the rest of the tick.
 */
const holdSeconds = () => Math.max(0, Math.min(25, envInt('AI17Z_TELEGRAM_POLL_HOLD_S', 5)));

const MAX_TEXT = 4_096;

async function tokenOf(ctx: ChannelContext): Promise<string> {
  const token = await ctx.botToken?.();
  if (!token) {
    throw PipelineError.permanent('telegram_no_token', 'Store this account\'s bot token before using it.');
  }
  return token;
}

async function botOf(ctx: ChannelContext): Promise<BotIdentity> {
  const bot = await telegramChannel.identity(ctx.account.id);
  if (!bot) throw PipelineError.permanent('telegram_no_token', 'Store this account\'s bot token before using it.');
  return bot;
}

/**
 * Proves a token and that the bot behind it is set up the way AI17Z needs.
 *
 * Two settings are refused rather than worked around, because each one is the
 * owner's decision and each changes what the bot can see:
 *
 *   - Group Privacy off lets the bot receive every message in a group. AI17Z
 *     needs only mentions and replies, so a bot that can read everything is more
 *     access than the job calls for.
 *   - A webhook means something else is receiving this bot's updates, and
 *     `getUpdates` would be refused by Telegram or would take them from it.
 */
export async function inspectBot(token: string): Promise<BotIdentity> {
  const bot = await getMe(token);
  if (!bot.is_bot || !bot.username) {
    throw PipelineError.permanent('telegram_bad_bot', 'That token does not belong to a bot with a username.');
  }
  if (bot.can_join_groups === false) {
    throw PipelineError.permanent(
      'telegram_bot_config',
      'This bot cannot be added to groups. In BotFather choose the bot, then Bot Settings, then Allow Groups.',
    );
  }
  if (bot.can_read_all_group_messages === true) {
    throw PipelineError.permanent(
      'telegram_bot_config',
      'Group Privacy is off for this bot, so it could read every message in a group. In BotFather choose the bot, then Bot Settings, then Group Privacy, and turn it on. AI17Z only needs mentions and replies.',
    );
  }
  if (await getWebhookUrl(token)) {
    throw PipelineError.permanent(
      'telegram_bot_config',
      'This bot has a webhook set, so something else is receiving its messages. Use a bot that only AI17Z reads.',
    );
  }
  return { botId: String(bot.id), botUsername: bot.username };
}

export async function ingestEvents(ctx: ChannelContext, options: IngestOptions) {
  const token = await tokenOf(ctx);
  const bot = await botOf(ctx);
  const stored = options.cursor ? Number(options.cursor) : null;
  const offset = stored !== null && Number.isSafeInteger(stored) && stored > 0 ? stored : null;

  const updates = await getUpdates(token, {
    offset,
    limit: Math.max(1, Math.min(100, Math.floor(options.limit))),
    holdSeconds: holdSeconds(),
  });

  // The list is read after the poll, so a group the owner removed while it was
  // waiting is already gone by the time a message from it is judged.
  const allowed = new Set((await telegramChannel.listChats(ctx.account.id)).map((chat) => chat.chatId));
  const events = [];
  let highest = -1;
  for (const update of updates) {
    const id = (update as { update_id?: unknown } | null)?.update_id;
    if (typeof id === 'number' && Number.isSafeInteger(id)) highest = Math.max(highest, id);
    const event = eventOf(update, bot, allowed);
    if (event) events.push(event);
  }
  // Past everything read, kept or dropped. The poller commits it only after the
  // events above were ingested, so a failure in between re-reads and the unique
  // index on the event makes that harmless.
  if (highest >= 0) options.reportCursor?.(String(highest + 1));
  return events;
}

function digestFor(bot: BotIdentity, action: ActionRequest, chatId: string, messageId: number): string {
  return sha256Hex(JSON.stringify([bot.botId, action.type, chatId, messageId, action.text]));
}

function target(action: ActionRequest): { chatId: string; messageId: number } {
  const parsed = parseTelegramMessageRef(action.targetRef);
  if (!parsed) {
    throw PipelineError.permanent(
      'telegram_bad_reference',
      'Use a Telegram message reference written telegram:<chat id>:<message id>.',
    );
  }
  return parsed;
}

function checkText(action: ActionRequest): void {
  if (action.type === 'REPLY') {
    if (!action.text.trim() || action.text.length > MAX_TEXT) {
      throw PipelineError.permanent('telegram_text_length', `A Telegram message must have text and fit in ${MAX_TEXT} characters.`);
    }
  } else if (!(TELEGRAM_REACTIONS as readonly string[]).includes(action.text)) {
    throw PipelineError.permanent('telegram_reaction_invalid', 'That is not a reaction this agent may set.');
  }
}

const unknownSend = () =>
  PipelineError.review(
    'telegram_send_unknown',
    'An earlier attempt to send this reply ended without an answer from Telegram, so it may already be in the group. It was not sent again. Look at the group before deciding.',
  );

export const telegramAdapter: ChannelAdapter = {
  id: 'telegram',
  displayName: 'Telegram groups',
  requiresBrowser: false,
  capabilities: ['REPLY', 'REACT'],

  async connect(ctx) {
    const token = await ctx.botToken?.();
    if (!token) return { status: 'NEEDS_AUTH', detail: 'Store a Telegram bot token for this account.' };
    try {
      const bot = await inspectBot(token);
      return { status: 'CONNECTED', detail: 'Telegram accepted the bot token.', remoteAccountId: bot.botId, handle: bot.botUsername };
    } catch (error) {
      if (error instanceof PipelineError && error.errorClass === 'PERMANENT') {
        return { status: 'NEEDS_AUTH', detail: error.message };
      }
      throw error;
    }
  },

  async disconnect() {
    // The runtime drops the sealed token. Revoking it is BotFather's, and the owner's.
  },

  async healthCheck(ctx) {
    const result = await telegramAdapter.connect(ctx);
    return {
      status: result.status === 'CONNECTED' ? 'healthy' : 'offline',
      authenticated: result.status === 'CONNECTED',
      detail: result.detail,
      ...(result.handle ? { handle: result.handle } : {}),
    };
  },

  ingestEvents,

  async resolveContext(_ctx, event) {
    return contextOf(event);
  },

  async verifyAction(ctx, action) {
    if (action.type !== 'REPLY' && action.type !== 'REACT') {
      throw PipelineError.permanent('telegram_unsupported_action', 'This action is not supported by the Telegram channel.');
    }
    const { chatId, messageId } = target(action);
    checkText(action);
    // Checked again here, not only at ingest: the owner may have removed the
    // group while the job waited.
    if (!(await telegramChannel.isChatAllowed(ctx.account.id, chatId))) {
      throw PipelineError.permanent('telegram_chat_not_allowed', 'This group is not on the list of groups this agent may use.');
    }
    const bot = await botOf(ctx);
    const member = await getBotMembership(await tokenOf(ctx), chatId, bot.botId);
    if (member.status === 'left' || member.status === 'kicked') {
      throw PipelineError.permanent('telegram_not_a_member', 'The bot is no longer in that group.');
    }
    if (action.type === 'REPLY' && member.status === 'restricted' && member.can_send_messages === false) {
      throw PipelineError.permanent('telegram_muted', 'The bot is not allowed to send messages in that group.');
    }
    return {
      verified: true,
      detail: 'The group is on the allowed list and the bot is a member.',
      targetRef: telegramMessageRef(chatId, messageId),
      targetUrl: messageUrl({ id: chatId }, messageId),
      targetAuthorHandle: null,
      evidence: { chatId, memberStatus: member.status },
    };
  },

  async executeAction(ctx, action) {
    const verification = await telegramAdapter.verifyAction(ctx, action);
    if (action.dryRun) return { status: 'DRY_RUN', remoteActionId: null, remoteActionUrl: null, verification };
    const { chatId, messageId } = target(action);
    const token = await tokenOf(ctx);

    if (action.type === 'REACT') {
      // A reaction is a state, not an event: setting it twice leaves one.
      await setReaction(token, { chatId, messageId, emoji: action.text });
      return {
        status: 'EXECUTED',
        remoteActionId: telegramMessageRef(chatId, messageId),
        remoteActionUrl: verification.targetUrl,
        verification: { ...verification, detail: 'Telegram accepted the reaction.' },
      };
    }

    const bot = await botOf(ctx);
    const digest = digestFor(bot, action, chatId, messageId);
    const done = (sent: string | null) => ({
      status: 'EXECUTED' as const,
      remoteActionId: sent,
      remoteActionUrl: sent ? urlOfRef(sent) : null,
      verification: { ...verification, detail: 'Telegram accepted the reply.' },
    });

    const existing = await telegramChannel.outboxRow(ctx.account.id, action.idempotencyKey, digest);
    if (existing?.state === 'SENT') return done(existing.remoteMessageId);
    if (existing?.state === 'SENDING') throw unknownSend();

    // The row is the claim. It is written before the request, because the Bot API
    // has no idempotency key and cannot read the chat back: this is the only
    // memory of an attempt that a crash leaves behind.
    if (!(await telegramChannel.beginSend(ctx.account.id, action.idempotencyKey, digest, chatId))) {
      const raced = await telegramChannel.outboxRow(ctx.account.id, action.idempotencyKey, digest);
      if (raced?.state === 'SENT') return done(raced.remoteMessageId);
      throw unknownSend();
    }
    let sent: { messageId: number };
    try {
      sent = await sendReply(token, { chatId, replyTo: messageId, text: action.text });
    } catch (error) {
      // A refusal proves nothing was sent, so the claim is released and the job
      // may try again (a 429 waits the time Telegram named). Any other failure may
      // have been delivered, so the claim stays and the next attempt goes to a person.
      if (wasRefused(error)) {
        await telegramChannel.abandonSend(ctx.account.id, action.idempotencyKey);
        throw error;
      }
      throw unknownSend();
    }
    const ref = telegramMessageRef(chatId, sent.messageId);
    await telegramChannel.settleSend(ctx.account.id, action.idempotencyKey, ref);
    return done(ref);
  },

  async wasAlreadyDone(ctx, action) {
    if (action.type !== 'REPLY') {
      return { done: false, conclusive: false, remoteActionId: null, remoteActionUrl: null, detail: 'A reaction cannot be read back.' };
    }
    const { chatId, messageId } = target(action);
    const row = await telegramChannel.outboxRow(
      ctx.account.id,
      action.idempotencyKey,
      digestFor(await botOf(ctx), action, chatId, messageId),
    );
    if (row?.state === 'SENT') {
      return {
        done: true,
        conclusive: true,
        remoteActionId: row.remoteMessageId,
        remoteActionUrl: row.remoteMessageId ? urlOfRef(row.remoteMessageId) : null,
        detail: 'This reply was already sent.',
      };
    }
    if (row?.state === 'SENDING') {
      // Telegram cannot say whether it arrived, so this is not proof of absence.
      return {
        done: false,
        conclusive: false,
        remoteActionId: null,
        remoteActionUrl: null,
        detail: 'An earlier send ended without an answer, so it is not known whether it arrived.',
      };
    }
    return { done: false, conclusive: true, remoteActionId: null, remoteActionUrl: null, detail: 'No send was started for this action.' };
  },

  async captureDiagnostics() {
    return null;
  },
};

function urlOfRef(ref: string): string | null {
  const parsed = parseTelegramMessageRef(ref);
  return parsed ? messageUrl({ id: parsed.chatId }, parsed.messageId) : null;
}

/**
 * One allowed group, as the agent may know it. Refuses any other chat, so a
 * model cannot use the bot to look at a group the owner never named.
 */
export async function readChat(ctx: ChannelContext, chatId: string): Promise<TelegramChatInfo> {
  if (!(await telegramChannel.isChatAllowed(ctx.account.id, chatId))) {
    throw PipelineError.permanent('telegram_chat_not_allowed', 'This group is not on the list of groups this agent may use.');
  }
  const token = await tokenOf(ctx);
  const chat = await getChat(token, chatId);
  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    throw PipelineError.permanent('telegram_chat_not_allowed', 'Only groups are supported.');
  }
  const memberCount = await getChatMemberCount(token, chatId).catch(() => null);
  return TelegramChatInfo.parse({
    chatId,
    type: chat.type,
    title: chat.title ?? '',
    username: chat.username ?? null,
    description: chat.description ? chat.description.slice(0, 2_000) : null,
    memberCount,
  });
}

/**
 * What the owner sees before allowing a group: that the bot is in it, and its
 * name. Used by the route that adds a group, which has no account context yet.
 */
export async function describeChat(token: string, chatId: string, botId: string) {
  const chat = await getChat(token, chatId);
  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    throw PipelineError.permanent('telegram_bad_chat', 'Only groups and supergroups can be allowed, not channels or private chats.');
  }
  // A public supergroup can be read by anyone, so being able to describe it
  // proves nothing. Membership is what says the owner actually added the bot.
  const member = await getBotMembership(token, chatId, botId);
  if (member.status === 'left' || member.status === 'kicked') {
    throw PipelineError.permanent('telegram_not_a_member', 'The bot is not in that group yet. Add it to the group first.');
  }
  return { chatId, title: chat.title ?? '', type: chat.type };
}
