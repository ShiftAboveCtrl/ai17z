import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifications as notificationsRepo, ops } from '@xbam/database';
import type { NotificationRecord } from '@xbam/database';
import {
  categoryFor,
  clearTransports,
  connectTelegram,
  deliverNotifications,
  disconnectTelegram,
  formatNotification,
  installTelegramTransport,
  loadConfig,
  markCaughtUp,
  pairTelegram,
  registerTransport,
  telegramHeartbeat,
  telegramStatus,
  updateTelegramPreferences,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { uniqueSuffix } from '../support/db';

installHarness();

/** A token shaped like BotFather's, so the format check is exercised for real. */
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

/**
 * A stand-in for Telegram, installed over the global fetch.
 *
 * Over the global rather than passed in, because the transport that delivers a
 * notification is called by a sweep and has nowhere to take an argument from.
 * Injecting one would test a path that never runs in production.
 */
class FakeTelegram {
  sent: Sent[] = [];
  updates: unknown[] = [];
  failSend: { status: number; description: string } | null = null;

  readonly impl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    this.sent.push({ method, body });

    if (method === 'getMe') {
      return json({ ok: true, result: { id: 123456789, username: 'ai17z_test_bot', first_name: 'AI17Z' } });
    }
    if (method === 'getUpdates') return json({ ok: true, result: this.updates });
    if (method === 'sendMessage') {
      if (this.failSend) {
        return json({ ok: false, error_code: this.failSend.status, description: this.failSend.description });
      }
      return json({ ok: true, result: { message_id: 1 } });
    }
    return json({ ok: true, result: {} });
  }) as unknown as typeof fetch;

  texts(): string[] {
    return this.sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.body.text));
  }

  clear(): void {
    this.sent = [];
  }
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function anUpdate(text: string, chatId = 555, updateId = 900) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 1,
      text,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: { id: chatId, first_name: 'Owner' },
    },
  };
}

async function raise(
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
  kind = 'ACCOUNT_NEEDS_USER',
): Promise<NotificationRecord> {
  const record = await notificationsRepo.raise({
    kind,
    severity,
    title: `${kind} needs you`,
    body: 'Something is waiting.',
    dedupeKey: `${kind}:${uniqueSuffix()}`,
  });
  return record!;
}

let telegram: FakeTelegram;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  telegram = new FakeTelegram();
  globalThis.fetch = telegram.impl;
  clearTransports();
  await disconnectTelegram();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Connects a bot and pairs it: the state everything below assumes. */
async function connected(chatId = 555): Promise<void> {
  await connectTelegram(TOKEN);
  telegram.updates = [anUpdate((await telegramStatus()).pairingCode!, chatId)];
  await pairTelegram();
  telegram.updates = [];
  telegram.clear();
}

describe('connecting a bot', () => {
  it('refuses something that is not a token before asking Telegram', async () => {
    await expect(connectTelegram('hunter2')).rejects.toThrow(/does not look like a bot token/i);
    // Not a single call made. A paste mistake should not be a round trip.
    expect(telegram.sent).toHaveLength(0);
  });

  it('proves the token against Telegram before storing it', async () => {
    const status = await connectTelegram(TOKEN);
    expect(telegram.sent.map((s) => s.method)).toContain('getMe');
    expect(status.botUsername).toBe('ai17z_test_bot');
  });

  it('never returns the token, in any field', async () => {
    const status = await connectTelegram(TOKEN);
    // The whole object, not a field list, because a field added later is
    // exactly how a token escapes.
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });

  it('seals the token rather than storing it as it was typed', async () => {
    await connectTelegram(TOKEN);
    const raw = JSON.stringify(await ops.getSetting('notifications.telegram'));
    expect(raw).not.toContain(TOKEN);
    const config = await loadConfig();
    expect(config.tokenSealed).toBeTruthy();
    expect(config.tokenSealed).not.toContain('AAHdqTcv');
  });

  it('says what Telegram meant, not what it said', async () => {
    // "Unauthorized" is accurate and useless.
    globalThis.fetch = (async () =>
      json({ ok: false, error_code: 401, description: 'Unauthorized' })) as unknown as typeof fetch;
    await expect(connectTelegram(TOKEN)).rejects.toThrow(/rejected the bot token/i);
  });
});

/**
 * The part that matters. A bot can be messaged by anybody who knows its
 * username, and taking the first chat that appears would hand the owner's
 * notifications -- account handles, failure reasons, which agent is stopped --
 * to whoever found it.
 */
describe('pairing only accepts the chat that knows the code', () => {
  it('ignores a stranger who messaged the bot first', async () => {
    await connectTelegram(TOKEN);
    telegram.updates = [anUpdate('hello?', 999)];

    const status = await pairTelegram();

    expect(status.connected).toBe(false);
    expect(status.awaitingPairing).toBe(true);
    // And nothing was sent to them.
    expect(telegram.texts()).toHaveLength(0);
  });

  it('accepts the chat that sends the code', async () => {
    await connectTelegram(TOKEN);
    telegram.updates = [anUpdate(`hi ${(await telegramStatus()).pairingCode}`, 777)];

    const status = await pairTelegram();

    expect(status.connected).toBe(true);
    expect((await loadConfig()).chatId).toBe(777);
    expect(telegram.texts()[0]).toContain('AI17Z is connected');
  });

  it('stops showing the code once it has been used', async () => {
    await connected();
    expect((await telegramStatus()).pairingCode).toBeNull();
  });

  it('does not let the code be replayed out of the backlog', async () => {
    await connectTelegram(TOKEN);
    const code = (await telegramStatus()).pairingCode!;
    telegram.updates = [anUpdate(code, 777)];
    await pairTelegram();

    // Somebody who saw the code over a shoulder sends it afterwards.
    telegram.updates = [anUpdate(code, 999, 901)];
    await pairTelegram();

    expect((await loadConfig()).chatId).toBe(777);
  });

  it('acknowledges what it has read so a backlog is not re-scanned', async () => {
    await connectTelegram(TOKEN);
    telegram.updates = [anUpdate('nothing relevant', 999)];
    await pairTelegram();
    expect((await loadConfig()).updateOffset).toBe(901);
  });
});

describe('what arrives, and what does not', () => {
  it('sends an open notification once', async () => {
    await connected();
    installTelegramTransport();
    await raise('CRITICAL');

    const first = await deliverNotifications();
    const second = await deliverNotifications();

    expect(first.delivered).toBe(1);
    // The second sweep says nothing. A sweep every sixty seconds must not mean
    // a message every sixty seconds.
    expect(second.delivered).toBe(0);
  });

  it('says nothing at all until a bot is connected', async () => {
    installTelegramTransport();
    await raise('CRITICAL');
    expect(await deliverNotifications()).toEqual({ delivered: 0, failed: 0, skipped: 0 });
  });

  it('honours the severity floor', async () => {
    await connected();
    installTelegramTransport();
    await updateTelegramPreferences({ minSeverity: 'CRITICAL' });
    await raise('WARNING');

    expect((await deliverNotifications()).delivered).toBe(0);
  });

  it('honours a category being switched off', async () => {
    await connected();
    installTelegramTransport();
    await updateTelegramPreferences({ categories: { accounts: false } });
    await raise('CRITICAL', 'ACCOUNT_SIGNED_OUT');

    expect((await deliverNotifications()).delivered).toBe(0);
  });

  it('does not deliver a backlog when a category is switched back on', async () => {
    // The worst first impression a new setting can make: turning something on
    // and receiving every notification it ever declined.
    await connected();
    installTelegramTransport();
    await updateTelegramPreferences({ categories: { accounts: false } });
    await raise('CRITICAL', 'ACCOUNT_SIGNED_OUT');
    await deliverNotifications();

    await updateTelegramPreferences({ categories: { accounts: true } });
    expect((await deliverNotifications()).delivered).toBe(0);
  });

  it('leaves everything that was already open where it was', async () => {
    // Somebody who has just pasted a token does not want a fortnight at once.
    await raise('CRITICAL');
    await raise('WARNING');
    await connected();
    installTelegramTransport();

    expect((await deliverNotifications()).delivered).toBe(0);
  });

  it('sends a notification raised after pairing', async () => {
    await connected();
    installTelegramTransport();
    await raise('CRITICAL');

    expect((await deliverNotifications()).delivered).toBe(1);
    expect(telegram.texts()[0]).toContain('needs you');
  });
});

describe('when Telegram will not take it', () => {
  it('records the failure and keeps the notification for the next sweep', async () => {
    await connected();
    installTelegramTransport();
    await raise('CRITICAL');

    // A blocked bot.
    telegram.failSend = { status: 403, description: 'bot was blocked by the user' };
    const failed = await deliverNotifications();

    expect(failed.failed).toBe(1);
    expect(failed.delivered).toBe(0);
    expect((await telegramStatus()).lastError).toMatch(/cannot message you/i);

    // Not lost. Once it works again, it goes.
    telegram.failSend = null;
    expect((await deliverNotifications()).delivered).toBe(1);
  });

  it('does not let one transport failing stop another', async () => {
    await connected();
    installTelegramTransport();
    const seen: string[] = [];
    registerTransport({
      name: 'a-second-transport',
      isConfigured: async () => true,
      wants: async () => true,
      deliver: async (notification) => {
        seen.push(notification.kind);
      },
    });
    await raise('CRITICAL');

    telegram.failSend = { status: 500, description: 'server error' };
    await deliverNotifications();

    expect(seen).toEqual(['ACCOUNT_NEEDS_USER']);
  });

  it('stops after the first failure rather than working through forty', async () => {
    await connected();
    installTelegramTransport();
    for (let i = 0; i < 4; i += 1) await raise('CRITICAL');

    telegram.failSend = { status: 429, description: 'Too Many Requests' };
    const result = await deliverNotifications();

    // Rate limited means the next thirty-nine will fail identically.
    expect(result.failed).toBe(1);
    expect(telegram.texts()).toHaveLength(1);
  });
});

describe('disconnecting', () => {
  it('forgets the token rather than keeping it in case', async () => {
    await connected();
    await disconnectTelegram();
    const config = await loadConfig();
    expect(config.tokenSealed).toBeNull();
    expect(config.chatId).toBeNull();
    expect((await telegramStatus()).connected).toBe(false);
  });

  it('stops sending', async () => {
    await connected();
    installTelegramTransport();
    await disconnectTelegram();
    await raise('CRITICAL');
    expect((await deliverNotifications()).delivered).toBe(0);
  });
});

/**
 * The one thing the transport can never report is the process it lives in
 * having stopped. A heartbeat inverts that: absence becomes the signal.
 */
describe('the heartbeat', () => {
  it('says nothing unless it was asked for', async () => {
    await connected();
    expect(await telegramHeartbeat()).toBe(false);
    expect(telegram.texts()).toHaveLength(0);
  });

  it('sends one when it is due, and not a second straight after', async () => {
    await connected();
    await updateTelegramPreferences({ heartbeatHours: 6 });

    expect(await telegramHeartbeat()).toBe(true);
    expect(telegram.texts()[0]).toContain('AI17Z is running');

    telegram.clear();
    expect(await telegramHeartbeat()).toBe(false);
    expect(telegram.texts()).toHaveLength(0);
  });

  it('says what its own silence would mean', async () => {
    await connected();
    await updateTelegramPreferences({ heartbeatHours: 6 });
    await telegramHeartbeat();
    expect(telegram.texts()[0]).toMatch(/does not arrive/i);
  });

  it('does not raise anything of its own when it fails', async () => {
    // The next one will fail the same way, and the owner is about to notice
    // the silence -- which is the whole point of it.
    await connected();
    await updateTelegramPreferences({ heartbeatHours: 6 });
    telegram.failSend = { status: 500, description: 'server error' };
    await expect(telegramHeartbeat()).resolves.toBe(false);
  });
});

describe('how it reads on a phone', () => {
  it('escapes what a failure message might contain', async () => {
    const record = await notificationsRepo.raise({
      kind: 'PROVIDER_FAILING',
      severity: 'WARNING',
      title: 'A provider is failing',
      // An error containing markup would otherwise break the send, so the
      // notification about the broken thing would itself be broken.
      body: 'Read <html> from https://x & got 500',
      dedupeKey: `esc:${uniqueSuffix()}`,
    });
    const text = formatNotification(record!);
    expect(text).toContain('&lt;html&gt;');
    expect(text).toContain('&amp;');
    // The tags AI17Z puts there itself survive.
    expect(text).toContain('<b>A provider is failing</b>');
  });

  it('routes every kind the runtime raises to a category', () => {
    // An unmapped kind falls into runtime, so a condition added later arrives
    // loud rather than silently undeliverable -- but the ones that exist are
    // named, not guessed.
    expect(categoryFor('ACCOUNT_NEEDS_USER')).toBe('accounts');
    expect(categoryFor('ACCOUNT_SIGNED_OUT')).toBe('accounts');
    expect(categoryFor('WORKER_STOPPED')).toBe('runtime');
    expect(categoryFor('EVERYTHING_PAUSED')).toBe('runtime');
    expect(categoryFor('AGENT_HAS_NO_MODEL')).toBe('models');
    expect(categoryFor('PROVIDER_FAILING')).toBe('models');
    expect(categoryFor('LIMIT_REACHED')).toBe('budget');
    expect(categoryFor('SOMETHING_ADDED_LATER')).toBe('runtime');
  });
});

describe('catching up', () => {
  it('marks open notifications as seen without sending them', async () => {
    await raise('CRITICAL');
    await raise('WARNING');
    expect(await markCaughtUp('telegram')).toBeGreaterThanOrEqual(2);
    expect(telegram.texts()).toHaveLength(0);
  });
});
