import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { telegramAdapter } from '@xbam/channels';
import { accounts, query, telegramChannel } from '@xbam/database';
import {
  allowTelegramGroup,
  buildChannelContext,
  clearTransports,
  connectTelegram,
  connectTelegramGroupAccount,
  disconnectTelegram,
  loadConfig,
  pairTelegram,
  telegramStatus,
} from '@xbam/runtime';
import { buildServer } from '../../apps/api/src/server';
import { ChannelPoller } from '../../apps/worker/src/poller';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { fakeTelegram } from '../support/fakeTelegram';

installHarness();
afterEach(() => vi.unstubAllGlobals());

const CHAT = -1001234567890;
const alice = { id: 11, username: 'alice', first_name: 'Alice' };

/**
 * The owner's notification bot and an agent's bot are two things.
 *
 * `telegram.ts`, `telegramApi.ts`, `telegramCommands.ts` and `notifyTransport.ts`
 * are unchanged by the agent channel and keep their guarantees: one paired chat,
 * a closed list of verbs, nothing typed there reaching an agent. What these
 * tests hold is the other half, that the agent channel can neither read nor
 * share what they keep.
 */
async function pairNotificationBot(tg: ReturnType<typeof fakeTelegram>) {
  const notifier = tg.addBot({ username: 'owner_notices_bot' });
  await connectTelegram(notifier.token);
  tg.say(notifier, { chatId: 555, from: { id: 555, username: 'owner' }, text: (await telegramStatus()).pairingCode!, chatType: 'private' });
  await pairTelegram();
  tg.clear();
  return notifier;
}

describe('the notification bot and the agent bot', () => {
  it('refuses to link the notification bot to an agent', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    await disconnectTelegram();
    clearTransports();
    const notifier = await pairNotificationBot(tg);

    await expect(connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: notifier.token })).rejects.toThrow(
      /bot AI17Z uses to send you notifications/,
    );
    // The same bot under a freshly issued token is still the same bot.
    const reissued = tg.addBot({ ...notifier, token: `${notifier.id}:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaX` });
    await expect(connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: reissued.token })).rejects.toThrow(
      /bot AI17Z uses to send you notifications/,
    );
    // Refused before Telegram was asked about either token.
    expect(tg.calls).toHaveLength(0);
    expect(await query('SELECT 1 FROM telegram_bots')).toHaveLength(0);

    const agentBot = tg.addBot();
    await expect(connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: agentBot.token })).resolves.toBeDefined();
    await disconnectTelegram();
  });

  it('stops using a bot the owner later makes their notification bot', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    await disconnectTelegram();
    clearTransports();
    const bot = tg.addBot();
    tg.addChat(CHAT, { title: 'Builders' });
    tg.join(CHAT, bot);
    const account = await connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: bot.token });
    await allowTelegramGroup(account.id, String(CHAT));
    await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, actionType: 'REPLY' });
    tg.say(bot, { chatId: CHAT, from: alice, text: 'hi', mention: true });

    // telegram.ts does not know about the agent channel and cannot refuse this.
    await connectTelegram(bot.token);
    tg.clear();

    // So the agent side is the one that notices, before it makes a request.
    const ctx = await buildChannelContext((await accounts.getAccount(account.id))!, null);
    await expect(telegramAdapter.ingestEvents(ctx, { limit: 10 })).rejects.toMatchObject({
      errorClass: 'PERMANENT',
      reason: 'telegram_shared_bot',
    });
    await new ChannelPoller().tick();
    expect(tg.callsFor(bot.token, 'getUpdates')).toHaveLength(0);
    const [row] = await query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [account.id]);
    expect(row!.status).toBe('NEEDS_AUTH');
    await disconnectTelegram();
  });

  it('keeps two update offsets in two places', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    await disconnectTelegram();
    clearTransports();
    const notifier = await pairNotificationBot(tg);
    const notifierOffset = (await loadConfig()).updateOffset;
    expect(notifierOffset).not.toBeNull();

    const bot = tg.addBot();
    tg.addChat(CHAT, { title: 'Builders' });
    tg.join(CHAT, bot);
    const account = await connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: bot.token });
    await allowTelegramGroup(account.id, String(CHAT));
    await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, actionType: 'REPLY' });
    tg.say(bot, { chatId: CHAT, from: alice, text: 'hi', mention: true });
    await new ChannelPoller().tick();

    // The agent's offset moved, the notification bot's did not, and each poll
    // went to its own bot with its own token.
    const agentOffset = (await telegramChannel.pollState(account.id))?.offset;
    expect(agentOffset).toBeGreaterThan(notifierOffset!);
    expect((await loadConfig()).updateOffset).toBe(notifierOffset);
    expect(tg.callsFor(bot.token, 'getUpdates')).toHaveLength(1);
    expect(tg.callsFor(notifier.token)).toHaveLength(0);

    // And the other way round: pairing again reads only the notification bot.
    tg.clear();
    await pairTelegram();
    expect((await telegramChannel.pollState(account.id))?.offset).toBe(agentOffset);
    expect(tg.callsFor(bot.token)).toHaveLength(0);
    await disconnectTelegram();
  });

  it('does not let a message typed to the agent bot reach the owner\'s command surface', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    await disconnectTelegram();
    clearTransports();
    await pairNotificationBot(tg);
    const bot = tg.addBot();
    tg.addChat(CHAT, { title: 'Builders' });
    tg.join(CHAT, bot);
    const account = await connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: bot.token });
    await allowTelegramGroup(account.id, String(CHAT));
    await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, actionType: 'REPLY' });
    tg.say(bot, { chatId: CHAT, from: alice, text: '/pause_all', mention: true });
    await new ChannelPoller().tick();
    // The text became an ordinary event for the agent and nothing else: the
    // notification bot was never asked to do anything and is exactly as it was.
    const events = await query<{ text: string }>('SELECT text FROM events WHERE account_id = $1', [account.id]);
    expect(events).toHaveLength(1);
    expect((await loadConfig()).mutedUntil).toBeNull();
    await disconnectTelegram();
  });
});

describe('the account routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  async function signIn(email: string): Promise<{ authorization: string }> {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
    const { data } = response.json() as { data: { token: string } };
    return { authorization: `Bearer ${data.token}` };
  }

  it('links a bot, allows a group, and never says the token', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const bot = tg.addBot();
    tg.addChat(CHAT, { title: 'Builders' });
    tg.join(CHAT, bot);

    const made = await app.inject({ method: 'POST', url: '/api/accounts/telegram', headers: auth, payload: { token: bot.token } });
    expect(made.statusCode).toBe(200);
    const account = (made.json() as { data: { id: string; handle: string; channel: string; status: string } }).data;
    expect(account).toMatchObject({ channel: 'telegram', handle: bot.username, status: 'CONNECTED' });

    const added = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/telegram/chats`, headers: auth, payload: { chat: 'https://t.me/c/1234567890/8' } });
    expect(added.statusCode).toBe(200);
    const overview = await app.inject({ method: 'GET', url: `/api/accounts/${account.id}/telegram`, headers: auth });
    expect((overview.json() as { data: unknown }).data).toEqual({
      hasToken: true,
      botUsername: bot.username,
      chats: [{ chatId: String(CHAT), title: 'Builders' }],
    });

    for (const response of [made, added, overview]) expect(response.body).not.toContain(bot.token.split(':')[1]);
    const listed = await app.inject({ method: 'GET', url: '/api/accounts', headers: auth });
    expect(listed.body).not.toContain(bot.token.split(':')[1]);

    const removed = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}/telegram/chats/${CHAT}`, headers: auth });
    expect((removed.json() as { data: { chats: unknown[] } }).data.chats).toEqual([]);
  });

  it('will not make a Telegram account from a handle, or show one owner another\'s', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    const stranger = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const bot = tg.addBot();
    const generic = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: auth,
      payload: { channel: 'telegram', handle: 'some_bot' },
    });
    expect(generic.statusCode).toBe(400);
    expect(generic.body).toContain('/api/accounts/telegram');

    const account = await connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: bot.token });
    const theirs = await signIn(stranger.ownerEmail);
    const peek = await app.inject({ method: 'GET', url: `/api/accounts/${account.id}/telegram`, headers: theirs });
    expect(peek.statusCode).toBe(403);
    const swap = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/telegram/bot`, headers: theirs, payload: { token: bot.token } });
    expect(swap.statusCode).toBe(403);
  });

  it('refuses a non-Telegram account on the Telegram routes, and a shared token on the link route', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    await disconnectTelegram();
    clearTransports();
    const auth = await signIn(fixture.ownerEmail);
    const x = await accounts.createAccount({ ownerId: fixture.ownerId, channel: 'x', handle: 'someone_on_x' });
    const wrong = await app.inject({ method: 'GET', url: `/api/accounts/${x.id}/telegram`, headers: auth });
    expect(wrong.statusCode).toBe(400);

    const notifier = await pairNotificationBot(tg);
    const shared = await app.inject({ method: 'POST', url: '/api/accounts/telegram', headers: auth, payload: { token: notifier.token } });
    expect(shared.statusCode).toBe(400);
    expect(shared.body).toMatch(/notifications/);
    await disconnectTelegram();
  });

  it('drops the sealed token on disconnect, keeps the groups, and reconnect needs a token again', async () => {
    const tg = fakeTelegram();
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const bot = tg.addBot();
    tg.addChat(CHAT, { title: 'Builders' });
    tg.join(CHAT, bot);
    const account = await connectTelegramGroupAccount({ ownerId: fixture.ownerId, token: bot.token });
    await allowTelegramGroup(account.id, String(CHAT));

    const off = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/disconnect`, headers: auth });
    expect((off.json() as { data: { status: string; enabled: boolean } }).data).toMatchObject({ status: 'DISCONNECTED', enabled: false });
    expect(await telegramChannel.getDecryptedToken(account.id)).toBeNull();
    expect(await telegramChannel.listChats(account.id)).toHaveLength(1);

    const back = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/reconnect`, headers: auth });
    expect((back.json() as { data: { status: string } }).data.status).toBe('NEEDS_AUTH');

    // A new token for the same bot brings it back, with a clean offset.
    const fresh = tg.addBot({ ...bot, token: `${bot.id}:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaX` });
    const swapped = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/telegram/bot`, headers: auth, payload: { token: fresh.token } });
    expect(swapped.statusCode).toBe(200);
    expect((await accounts.getAccount(account.id))!.status).toBe('CONNECTED');
    // And a different bot is a different account.
    const other = tg.addBot();
    const wrong = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/telegram/bot`, headers: auth, payload: { token: other.token } });
    expect(wrong.statusCode).toBe(400);
  });
});
