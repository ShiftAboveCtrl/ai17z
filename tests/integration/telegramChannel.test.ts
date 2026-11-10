import { afterEach, describe, expect, it, vi } from 'vitest';
import { telegramAdapter } from '@xbam/channels';
import { accounts, cadences, capabilities, jobs, query, telegramChannel } from '@xbam/database';
import {
  allowTelegramGroup,
  buildChannelContext,
  connectTelegramGroupAccount,
  ingestNormalizedEvent,
  loadJobBundle,
  registerTelegramCapabilities,
  stepExecute,
  stepResolveContext,
} from '@xbam/runtime';
import { getCapability, resetCapabilitiesForTest } from '@xbam/tools';
import { createLogger, openSecret, redact } from '@xbam/shared';
import { ChannelPoller } from '../../apps/worker/src/poller';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs, makeDue } from '../support/runner';
import { fakeTelegram } from '../support/fakeTelegram';

installHarness();
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const CHAT = -1001234567890;
const OTHER_CHAT = -1009876543210;
const alice = { id: 11, username: 'alice', first_name: 'Alice' };

async function setup(options: { link?: 'REPLY' | 'NONE' } = {}) {
  const tg = fakeTelegram();
  const fixture = await createFixture();
  const bot = tg.addBot();
  tg.addChat(CHAT, { title: 'Builders' });
  tg.join(CHAT, bot);
  tg.addChat(OTHER_CHAT, { title: 'Elsewhere' });
  tg.join(OTHER_CHAT, bot);
  const account = await connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: bot.token });
  await allowTelegramGroup(account.id, String(CHAT));
  const config = await cadences.activeCadence(account.id);
  await cadences.saveVersion(
    account.id,
    {
      ...config,
      quietHours: { ...config.quietHours, enabled: false },
      acting: { ...config.acting, minSecondsBetweenActions: 0 },
      polling: { ...config.polling, intervalSeconds: 15, maxIntervalSeconds: 15, jitterPercent: 0 },
    },
    'telegram test cadence',
    fixture.ownerId,
  );
  await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, actionType: options.link ?? 'REPLY' });
  const ctx = await buildChannelContext(account, null);
  tg.clear();
  return { tg, fixture, bot, account, ctx };
}

/** One mention in the allowed group, ingested into a job. */
async function mentioned(s: Awaited<ReturnType<typeof setup>>, text = 'what is the safest way to bridge') {
  const messageId = s.tg.say(s.bot, { chatId: CHAT, from: alice, text, mention: true });
  const [event] = await telegramAdapter.ingestEvents(s.ctx, { limit: 20 });
  if (!event) throw new Error('The mention must produce an event.');
  const result = await ingestNormalizedEvent({ accountId: s.account.id, event });
  return { messageId, event, job: result.jobs[0]?.job };
}

const reply = (messageId: number, key = 'one-reply', text = 'Use a bridge with audited contracts and small first transfers.') => ({
  type: 'REPLY' as const,
  targetRef: `telegram:${CHAT}:${messageId}`,
  text,
  idempotencyKey: key,
  dryRun: false,
});

/** Every row of every table, as text, for a search that must come back empty. */
async function everywhereExcept(skip: string[]): Promise<string> {
  const tables = await query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const parts: string[] = [];
  for (const { tablename } of tables) {
    if (skip.includes(tablename)) continue;
    const rows = await query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM "${tablename}" t`);
    parts.push(...rows.map((r) => r.row));
  }
  return parts.join('\n');
}

describe('the bot token', () => {
  it('is sealed at rest, answers presence only, and is in no other table', async () => {
    const { bot, account } = await setup();
    const [row] = await query<{ sealed_token: string }>('SELECT sealed_token FROM telegram_bots WHERE account_id = $1', [account.id]);
    expect(row!.sealed_token).toMatch(/^v1\./);
    expect(row!.sealed_token).not.toContain(bot.token);
    expect(openSecret(row!.sealed_token)).toBe(bot.token);
    expect(await telegramChannel.presence(account.id)).toEqual({ hasToken: true, botUsername: bot.username });
    expect(JSON.stringify(account)).not.toContain(bot.token);
    expect(await everywhereExcept(['telegram_bots'])).not.toContain(bot.token);
    expect(await everywhereExcept(['telegram_bots'])).not.toContain(bot.token.split(':')[1]!);
    expect(redact({ botToken: bot.token, token: bot.token })).toEqual({ botToken: '[redacted]', token: '[redacted]' });
  });

  it('is proved against Telegram before anything is kept', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    const refuse = async (token: string, why: RegExp) => {
      await expect(connectTelegramGroupAccount({ ownerId: fixture.ownerId, token })).rejects.toThrow(why);
    };
    await refuse('hunter2', /does not look like a bot token/);
    expect(tg.calls).toHaveLength(0);

    const revoked = tg.addBot();
    revoked.revoked = true;
    await refuse(revoked.token, /does not accept this bot token/);
    await refuse(tg.addBot({ canReadAllGroupMessages: true }).token, /Group Privacy is off/);
    await refuse(tg.addBot({ webhookUrl: 'https://example.invalid/hook' }).token, /webhook/);
    await refuse(tg.addBot({ canJoinGroups: false }).token, /cannot be added to groups/);

    expect(await query("SELECT 1 FROM accounts WHERE channel = 'telegram'")).toHaveLength(0);
    expect(await query('SELECT 1 FROM telegram_bots')).toHaveLength(0);
  });

  it('cannot serve two accounts: the bot id is unique', async () => {
    const s = await setup();
    const other = await createFixture();
    // The same bot with a fresh token, as /revoke would produce.
    const sameBot = { ...s.bot, token: `${s.bot.id}:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaX` };
    s.tg.addBot(sameBot);
    await expect(connectTelegramGroupAccount({ ownerId: other.ownerId, token: sameBot.token })).rejects.toThrow(
      /already linked to another account/,
    );
  });
});

describe('the groups an owner allows', () => {
  it('requires the bot to be in the group, and only groups', async () => {
    const s = await setup();
    s.tg.addChat(-1005555555555, { title: 'Not joined' });
    await expect(allowTelegramGroup(s.account.id, '-1005555555555')).rejects.toThrow(/not in that group/);
    s.tg.addChat(-1006666666666, { type: 'channel', title: 'News' });
    s.tg.join(-1006666666666, s.bot, 'administrator');
    await expect(allowTelegramGroup(s.account.id, '-1006666666666')).rejects.toThrow(/Only groups/);
    await expect(allowTelegramGroup(s.account.id, '-1007777777777')).rejects.toThrow(/cannot find that group/);
    expect(await telegramChannel.listChats(s.account.id)).toEqual([{ chatId: String(CHAT), title: 'Builders' }]);
  });

  it('takes a copied message link as well as an id', async () => {
    const s = await setup();
    const added = await allowTelegramGroup(s.account.id, 'https://t.me/c/9876543210/12');
    expect(added).toEqual({ chatId: String(OTHER_CHAT), title: 'Elsewhere' });
  });
});

describe('what the poller reads', () => {
  it('ingests mentions and replies in allowed groups, drops the rest without a trace, and commits the offset after', async () => {
    const s = await setup();
    const secret = 'overheard-in-the-group-chat-7731';
    s.tg.say(s.bot, { chatId: CHAT, from: alice, text: 'gm builders, anyone seen the new fees?', mention: true });
    s.tg.say(s.bot, { chatId: CHAT, from: alice, text: `${secret} nobody asked the bot` });
    s.tg.say(s.bot, { chatId: OTHER_CHAT, from: alice, text: `${secret} but this one is from a group that is not allowed`, mention: true });
    s.tg.say(s.bot, { chatId: CHAT, from: { id: 99, is_bot: true, username: 'other_bot' }, text: 'bot spam', mention: true });
    s.tg.say(s.bot, {
      chatId: CHAT,
      from: { id: 12, username: 'bob' },
      text: 'following up on that',
      replyTo: { messageId: 4_000, from: { id: s.bot.id, is_bot: true }, text: 'Earlier answer from the agent.' },
    });

    await new ChannelPoller().tick();

    const events = await query<{ type: string; text: string }>('SELECT type, text FROM events WHERE account_id = $1 ORDER BY occurred_at, id', [s.account.id]);
    expect(events.map((e) => e.type).sort()).toEqual(['MENTION', 'REPLY']);
    // The unaddressed words and the other group's words are in no table at all.
    expect(await everywhereExcept([])).not.toContain(secret);
    expect(await everywhereExcept([])).not.toContain('bot spam');

    // Read the whole batch, kept or dropped, and committed it only afterwards.
    const state = await telegramChannel.pollState(s.account.id);
    expect(state?.offset).toBe(105);
    expect(state?.version).toBe(1);
    const updates = s.tg.callsFor(s.bot.token, 'getUpdates');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body).toMatchObject({ allowed_updates: ['message'] });
    expect(updates[0]!.body.offset).toBeUndefined();

    // The next poll acknowledges what was committed, so nothing comes round twice.
    await query('UPDATE accounts SET next_poll_at = now() WHERE id = $1', [s.account.id]);
    await new ChannelPoller().tick();
    expect(s.tg.callsFor(s.bot.token, 'getUpdates')[1]!.body.offset).toBe(105);
    expect(await query('SELECT 1 FROM events WHERE account_id = $1', [s.account.id])).toHaveLength(2);
  });

  it('never replies to a message it drops', async () => {
    const s = await setup();
    s.tg.say(s.bot, { chatId: OTHER_CHAT, from: alice, text: 'hello?', mention: true });
    s.tg.say(s.bot, { chatId: CHAT, from: alice, text: 'unaddressed' });
    await new ChannelPoller().tick();
    await drainAgentJobs(s.fixture.agentId);
    expect(s.tg.sent).toHaveLength(0);
    expect(s.tg.calls.filter((c) => c.method !== 'getUpdates' && c.method !== 'getMe')).toHaveLength(0);
  });

  it('does not move the offset when the adapter alone is asked, only when the poller commits', async () => {
    const s = await setup();
    s.tg.say(s.bot, { chatId: CHAT, from: alice, text: 'hi', mention: true });
    let reported: string | null = null;
    await telegramAdapter.ingestEvents(s.ctx, { limit: 20, reportCursor: (c) => (reported = c) });
    expect(reported).toBe('101');
    expect((await telegramChannel.pollState(s.account.id))?.offset).toBeNull();
  });

  it('refuses a late commit from a poll whose claim was overtaken', async () => {
    const s = await setup();
    const early = (await telegramChannel.pollState(s.account.id))!;
    expect(await telegramChannel.advanceOffset(s.account.id, early.version, 200)).toBe(true);
    expect(await telegramChannel.advanceOffset(s.account.id, early.version, 150)).toBe(false);
    expect((await telegramChannel.pollState(s.account.id))?.offset).toBe(200);
  });

  it('waits at least the time Telegram named after a rate limit, and changes nothing else', async () => {
    const s = await setup();
    s.tg.say(s.bot, { chatId: CHAT, from: alice, text: 'hi', mention: true });
    s.tg.rateLimitNextUpdates();
    const before = Date.now();
    await new ChannelPoller().tick();
    const scheduled = await cadences.pollState(s.account.id);
    expect(Date.parse(scheduled!.nextPollAt!) - before).toBeGreaterThanOrEqual(61_000);
    expect(await telegramChannel.pollState(s.account.id)).toMatchObject({ offset: null, version: 0 });
    expect(await query('SELECT 1 FROM events WHERE account_id = $1', [s.account.id])).toHaveLength(0);
    const [row] = await query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [s.account.id]);
    expect(row!.status).toBe('CONNECTED');
  });

  it('stops polling a bot Telegram no longer accepts', async () => {
    const s = await setup();
    s.tg.say(s.bot, { chatId: CHAT, from: alice, text: 'hi', mention: true });
    s.bot.revoked = true;
    await new ChannelPoller().tick();
    const [row] = await query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [s.account.id]);
    expect(row!.status).toBe('NEEDS_AUTH');
  });
});

describe('answering a group', () => {
  it('runs the whole pipeline once and replies to the message that asked', async () => {
    const s = await setup();
    const messageId = s.tg.say(s.bot, { chatId: CHAT, from: alice, text: 'how do I bridge safely', mention: true });
    await new ChannelPoller().tick();
    await drainAgentJobs(s.fixture.agentId);
    expect(s.tg.sent).toHaveLength(1);
    expect(s.tg.sent[0]).toMatchObject({ chatId: CHAT, replyTo: messageId });
    expect(s.tg.sent[0]!.text.length).toBeGreaterThan(0);
    const [job] = await query<{ status: string }>('SELECT status FROM jobs WHERE agent_id = $1', [s.fixture.agentId]);
    expect(job!.status).toBe('EXECUTED');
    const [action] = await query<{ remote_action_id: string; status: string }>(
      "SELECT remote_action_id, status FROM actions WHERE account_id = $1 AND status = 'EXECUTED'",
      [s.account.id],
    );
    expect(action!.remote_action_id).toBe(`telegram:${CHAT}:${s.tg.sent[0]!.messageId}`);
    // The poller finding it again, or the worker running it again, sends nothing more.
    await query('UPDATE accounts SET next_poll_at = now() WHERE id = $1', [s.account.id]);
    await new ChannelPoller().tick();
    await drainAgentJobs(s.fixture.agentId);
    expect(s.tg.sent).toHaveLength(1);
  });

  it('puts a Telegram 429 on waitForLimit: nothing charged, the wait is the one Telegram gave, then it sends once', async () => {
    const s = await setup();
    s.tg.setRetryAfter(7);
    s.tg.failNextSend('rate');
    s.tg.say(s.bot, { chatId: CHAT, from: alice, text: 'how do I bridge safely', mention: true });
    await new ChannelPoller().tick();
    const [before] = await query<{ attempt_count: number }>('SELECT attempt_count FROM jobs WHERE agent_id = $1', [s.fixture.agentId]);
    const started = Date.now();
    await drainAgentJobs(s.fixture.agentId);

    expect(s.tg.sent).toHaveLength(0);
    const [held] = await query<{ status: string; attempt_count: number; run_at: string; error_class: string }>(
      'SELECT status, attempt_count, run_at, error_class FROM jobs WHERE agent_id = $1',
      [s.fixture.agentId],
    );
    expect(held!.status).not.toMatch(/FAILURE|REVIEW|EXECUTED/);
    expect(held!.error_class).toBe('RETRYABLE');
    expect(held!.attempt_count).toBe(before!.attempt_count);
    const waitMs = new Date(held!.run_at).getTime() - started;
    expect(waitMs).toBeGreaterThanOrEqual(7_000);
    expect(waitMs).toBeLessThan(30_000);
    // The refused request is forgotten, so the retry is a fresh send.
    expect(await query('SELECT 1 FROM telegram_outbox')).toHaveLength(0);

    const [job] = await query<{ id: string }>('SELECT id FROM jobs WHERE agent_id = $1', [s.fixture.agentId]);
    await makeDue(job!.id);
    await drainAgentJobs(s.fixture.agentId);
    expect(s.tg.sent).toHaveLength(1);
    expect((await jobs.getJob(job!.id))!.status).toBe('EXECUTED');
  });

  it('checks the reply grant at ingest and again before it sends', async () => {
    const quiet = await setup({ link: 'NONE' });
    expect((await capabilities.grantsFor(quiet.fixture.agentId, quiet.account.id)).has('REPLY')).toBe(false);
    const none = await mentioned(quiet);
    expect(none.job).toBeUndefined();
    expect(quiet.tg.sent).toHaveLength(0);

    const s = await setup();
    const { job } = await mentioned(s);
    await stepResolveContext(await loadJobBundle(job!));
    await jobs.updateJob(job!.id, { validatedOutput: 'A considered reply.' });
    await capabilities.setGrants(s.fixture.agentId, s.account.id, ['READ', 'GENERATE'], null);
    await expect(stepExecute(await loadJobBundle((await jobs.getJob(job!.id))!))).rejects.toMatchObject({
      errorClass: 'PERMANENT',
      reason: 'capability_not_granted',
    });
    expect(s.tg.sent).toHaveLength(0);
  });

  it('never sends a dry run, and verifies the group first', async () => {
    const s = await setup();
    const { messageId } = await mentioned(s);
    const result = await telegramAdapter.executeAction(s.ctx, { ...reply(messageId), dryRun: true });
    expect(result.status).toBe('DRY_RUN');
    expect(s.tg.sent).toHaveLength(0);
    expect(s.tg.callsFor(s.bot.token, 'getChatMember')).toHaveLength(1);
  });

  it('refuses a group that is not on the list, even for a message it could reach', async () => {
    const s = await setup();
    await expect(
      telegramAdapter.executeAction(s.ctx, { ...reply(1), targetRef: `telegram:${OTHER_CHAT}:1` }),
    ).rejects.toMatchObject({ reason: 'telegram_chat_not_allowed' });
    expect(s.tg.sent).toHaveLength(0);
  });

  it('stops when the bot has been removed from the group or muted in it', async () => {
    const s = await setup();
    s.tg.join(CHAT, s.bot, 'kicked');
    await expect(telegramAdapter.executeAction(s.ctx, reply(1))).rejects.toMatchObject({ reason: 'telegram_not_a_member' });
    s.tg.join(CHAT, s.bot, 'restricted');
    await expect(telegramAdapter.executeAction(s.ctx, reply(1))).rejects.toMatchObject({ reason: 'telegram_muted' });
    expect(s.tg.sent).toHaveLength(0);
  });

  it('refuses text Telegram would, before asking it', async () => {
    const s = await setup();
    await expect(telegramAdapter.executeAction(s.ctx, reply(1, 'k', '   '))).rejects.toMatchObject({ reason: 'telegram_text_length' });
    await expect(telegramAdapter.executeAction(s.ctx, reply(1, 'k', 'x'.repeat(4_097)))).rejects.toMatchObject({
      reason: 'telegram_text_length',
    });
    await expect(telegramAdapter.executeAction(s.ctx, { ...reply(1), targetRef: '50' })).rejects.toMatchObject({
      reason: 'telegram_bad_reference',
    });
    await expect(telegramAdapter.executeAction(s.ctx, { ...reply(1), type: 'POST' })).rejects.toMatchObject({
      reason: 'telegram_unsupported_action',
    });
    expect(s.tg.sent).toHaveLength(0);
  });
});

describe('sending once', () => {
  it('sends a key once however many times it is asked', async () => {
    const s = await setup();
    const first = await telegramAdapter.executeAction(s.ctx, reply(60));
    const second = await telegramAdapter.executeAction(s.ctx, reply(60));
    expect(s.tg.sent).toHaveLength(1);
    expect(second.remoteActionId).toBe(first.remoteActionId);
    expect(await telegramAdapter.wasAlreadyDone!(s.ctx, reply(60))).toMatchObject({
      done: true,
      conclusive: true,
      remoteActionId: first.remoteActionId,
    });
    await expect(telegramAdapter.executeAction(s.ctx, reply(60, 'one-reply', 'Different words'))).rejects.toMatchObject({
      reason: 'telegram_idempotency_conflict',
    });
  });

  it('does not send again after an answer was lost, and hands it to a person', async () => {
    const s = await setup();
    s.tg.failNextSend('lose');
    await expect(telegramAdapter.executeAction(s.ctx, reply(60))).rejects.toMatchObject({
      errorClass: 'REVIEW_REQUIRED',
      reason: 'telegram_send_unknown',
    });
    // Telegram did deliver it. The only thing standing between this and a second
    // copy in a public group is the row written before the request.
    expect(s.tg.sent).toHaveLength(1);
    await expect(telegramAdapter.executeAction(s.ctx, reply(60))).rejects.toMatchObject({ reason: 'telegram_send_unknown' });
    expect(s.tg.sent).toHaveLength(1);
    expect(await telegramAdapter.wasAlreadyDone!(s.ctx, reply(60))).toMatchObject({ done: false, conclusive: false });
  });

  it('treats a gateway error as unknown, not as a refusal', async () => {
    const s = await setup();
    s.tg.failNextSend('bad-gateway');
    await expect(telegramAdapter.executeAction(s.ctx, reply(60))).rejects.toMatchObject({ reason: 'telegram_send_unknown' });
    expect(await query("SELECT 1 FROM telegram_outbox WHERE state = 'SENDING'")).toHaveLength(1);
  });

  it('forgets a request Telegram refused, so it can be sent later', async () => {
    const s = await setup();
    s.tg.failNextSend('reject');
    await expect(telegramAdapter.executeAction(s.ctx, reply(60))).rejects.toMatchObject({
      errorClass: 'PERMANENT',
      reason: 'telegram_message_gone',
    });
    expect(await query('SELECT 1 FROM telegram_outbox')).toHaveLength(0);
    expect(await telegramAdapter.wasAlreadyDone!(s.ctx, reply(60))).toMatchObject({ done: false, conclusive: true });
  });

  it('keeps a losing send claim retryable while the winning sender is in progress', async () => {
    const s = await setup();
    const begin = telegramChannel.beginSend;
    // Another worker inserted the claim after our first read and before our insert.
    vi.spyOn(telegramChannel, 'beginSend').mockImplementationOnce(async (...args) => {
      await begin(...args);
      return false;
    });
    await expect(telegramAdapter.executeAction(s.ctx, reply(60))).rejects.toMatchObject({
      errorClass: 'RETRYABLE', reason: 'telegram_send_in_progress',
    });
    expect(s.tg.sent).toHaveLength(0);
    expect(await query("SELECT state FROM telegram_outbox")).toEqual([{ state: 'SENDING' }]);
  });

  it('lets one of two racing workers send', async () => {
    const s = await setup();
    const results = await Promise.allSettled([
      telegramAdapter.executeAction(s.ctx, reply(60)),
      telegramAdapter.executeAction(s.ctx, reply(60)),
    ]);
    expect(s.tg.sent).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
});

describe('the reaction capability', () => {
  const context = (s: Awaited<ReturnType<typeof setup>>, jobId: string | null) => ({
    agentId: s.fixture.agentId,
    jobId,
    accountId: s.account.id,
    config: {},
    logger: createLogger('test'),
    signal: new AbortController().signal,
  });

  it('is refused until the owner grants it, and then reacts once', async () => {
    const s = await setup();
    const { job, messageId } = await mentioned(s);
    resetCapabilitiesForTest();
    registerTelegramCapabilities();
    const react = getCapability('telegram.react')!;
    const input = { message: `telegram:${CHAT}:${messageId}`, reaction: '🔥' } as never;

    await expect(react.run(input, context(s, job!.id))).rejects.toMatchObject({ reason: 'capability_not_granted' });
    expect(s.tg.reactions).toHaveLength(0);

    await capabilities.grant(s.fixture.agentId, s.account.id, 'REACT');
    expect(await react.run(input, context(s, job!.id))).toMatchObject({ performed: true });
    expect(s.tg.reactions).toEqual([{ chatId: CHAT, messageId, emoji: '🔥' }]);
    expect(await react.run(input, context(s, job!.id))).toMatchObject({ performed: false, alreadyDone: true });
    expect(s.tg.reactions).toHaveLength(1);
  });

  it('cannot be used for a group that was not allowed or from another agent\'s job', async () => {
    const s = await setup();
    const { job } = await mentioned(s);
    await capabilities.grant(s.fixture.agentId, s.account.id, 'REACT');
    resetCapabilitiesForTest();
    registerTelegramCapabilities();
    const react = getCapability('telegram.react')!;
    await expect(
      react.run({ message: `telegram:${OTHER_CHAT}:5`, reaction: '🔥' } as never, context(s, job!.id)),
    ).rejects.toMatchObject({ reason: 'telegram_chat_not_allowed' });
    await expect(
      react.run({ message: `telegram:${CHAT}:5`, reaction: '🔥' } as never, context(s, null)),
    ).rejects.toMatchObject({ reason: 'telegram_wrong_job' });
    expect(s.tg.reactions).toHaveLength(0);
  });

  it('reads an allowed group and no other', async () => {
    const s = await setup();
    resetCapabilitiesForTest();
    registerTelegramCapabilities();
    const read = getCapability('telegram.read_chat')!;
    expect(await read.run({ chat: String(CHAT) } as never, context(s, null))).toMatchObject({
      chatId: String(CHAT),
      title: 'Builders',
      type: 'supergroup',
      memberCount: 1234,
    });
    await expect(read.run({ chat: String(OTHER_CHAT) } as never, context(s, null))).rejects.toMatchObject({
      reason: 'telegram_chat_not_allowed',
    });
  });
});
