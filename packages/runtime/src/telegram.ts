/**
 * Telegram as a way to reach the owner when they are not at the machine.
 *
 * AI17Z runs on somebody's own computer. That is the point of it, and it is
 * also the problem this solves: an agent that stops at three in the morning
 * because X asked for a login code has nobody to tell. The web UI is on a
 * screen nobody is looking at, and there is no server to send an email from.
 *
 * What this is not:
 *
 *   - **not a channel.** No agent reads from it, writes to it, or knows it
 *     exists. `packages/channels` is where an agent's identity lives; this
 *     carries the installation's. An agent given a Telegram account one day
 *     would be a separate thing that happens to use the same API.
 *   - **not a second decision about what is worth saying.** Everything here has
 *     already been through `notify`: raised, deduped, severity assigned, mute
 *     honoured. This only chooses whether the owner wants that particular kind
 *     on their phone, and sends it.
 *   - **not a command channel.** Incoming messages are read exactly once, during
 *     pairing, to learn which chat to send to. Nothing an owner types into
 *     Telegram can make AI17Z do anything -- a bot token is a bearer credential
 *     and a chat is not an authenticated session.
 */
import { ops as opsRepo } from '@xbam/database';
import type { NotificationRecord, NotificationSeverity } from '@xbam/database';
import { BadRequestError, createLogger, errorMessage, openSecret, sealSecret } from '@xbam/shared';
import { deliveryState, markCaughtUp, registerTransport } from './notifyTransport';
import type { NotificationTransport } from './notifyTransport';
import { escapeHtml, getMe, getUpdates, sendMessage } from './telegramApi';
import type { TelegramError } from './telegramApi';

const log = createLogger('telegram');

export const TELEGRAM_TRANSPORT = 'telegram';
const SETTING_KEY = 'notifications.telegram';

/**
 * Which notifications go to a phone.
 *
 * Categories rather than individual kinds, because a person choosing what wakes
 * them up is thinking "problems with my accounts", not "ACCOUNT_SIGNED_OUT".
 * Every kind maps to exactly one, and an unmapped kind falls into `runtime` --
 * a new condition arrives loud rather than silently undeliverable.
 */
export const TELEGRAM_CATEGORIES = ['accounts', 'runtime', 'models', 'budget'] as const;
export type TelegramCategory = (typeof TELEGRAM_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TelegramCategory, string> = {
  accounts: 'Account problems',
  runtime: 'AI17Z stopped or paused',
  models: 'Models and providers',
  budget: 'Spending limits',
};

export const CATEGORY_DESCRIPTIONS: Record<TelegramCategory, string> = {
  accounts: 'A security challenge is waiting, or a connected account was signed out.',
  runtime: 'The worker stopped, or everything was paused.',
  models: 'An agent has no model configured, or a provider is failing.',
  budget: 'An agent reached a daily or monthly limit and stopped.',
};

const KIND_CATEGORY: Record<string, TelegramCategory> = {
  ACCOUNT_NEEDS_USER: 'accounts',
  ACCOUNT_SIGNED_OUT: 'accounts',
  WORKER_STOPPED: 'runtime',
  EVERYTHING_PAUSED: 'runtime',
  AGENT_HAS_NO_MODEL: 'models',
  PROVIDER_FAILING: 'models',
  LIMIT_REACHED: 'budget',
};

export function categoryFor(kind: string): TelegramCategory {
  return KIND_CATEGORY[kind] ?? 'runtime';
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/**
 * What is stored.
 *
 * The token is sealed; the chat id is not, because it is not a secret -- it
 * identifies a conversation and is useless without the token.
 */
export interface TelegramConfig {
  enabled: boolean;
  tokenSealed: string | null;
  botUsername: string | null;
  chatId: number | null;
  chatLabel: string | null;
  connectedAt: string | null;
  /** Pairing code the owner must send the bot. Cleared once pairing succeeds. */
  pairingCode: string | null;
  /** Highest update id already read, so pairing does not re-read old messages. */
  updateOffset: number | null;
  categories: Record<TelegramCategory, boolean>;
  minSeverity: NotificationSeverity;
  /** Hours between "still running" messages, or 0 for none. */
  heartbeatHours: number;
  lastHeartbeatAt: string | null;
}

const DEFAULTS: TelegramConfig = {
  enabled: false,
  tokenSealed: null,
  botUsername: null,
  chatId: null,
  chatLabel: null,
  connectedAt: null,
  pairingCode: null,
  updateOffset: null,
  // Everything on by default. Somebody who has just gone to the trouble of
  // creating a bot wants to be told things; turning categories off is a
  // decision they can make once they know what arrives.
  categories: { accounts: true, runtime: true, models: true, budget: true },
  minSeverity: 'WARNING',
  heartbeatHours: 0,
  lastHeartbeatAt: null,
};

export async function loadConfig(): Promise<TelegramConfig> {
  const stored = await opsRepo.getSetting<Partial<TelegramConfig>>(SETTING_KEY);
  if (!stored) return { ...DEFAULTS };
  return {
    ...DEFAULTS,
    ...stored,
    categories: { ...DEFAULTS.categories, ...(stored.categories ?? {}) },
  };
}

async function saveConfig(config: TelegramConfig): Promise<void> {
  await opsRepo.setSetting(SETTING_KEY, config);
}

/**
 * What an API route may say about the connection.
 *
 * There is no field here that could be assembled back into the token, and no
 * route returns one. A fingerprint is deliberately absent too: a token is a
 * bearer credential, and confirming a guess about one is worth something.
 */
export interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  botUsername: string | null;
  chatLabel: string | null;
  connectedAt: string | null;
  awaitingPairing: boolean;
  pairingCode: string | null;
  categories: Record<TelegramCategory, boolean>;
  minSeverity: NotificationSeverity;
  heartbeatHours: number;
  lastDeliveryAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export async function telegramStatus(): Promise<TelegramStatus> {
  const config = await loadConfig();
  const delivery = await deliveryState(TELEGRAM_TRANSPORT);
  return {
    configured: Boolean(config.tokenSealed),
    connected: Boolean(config.tokenSealed && config.chatId),
    enabled: config.enabled,
    botUsername: config.botUsername,
    chatLabel: config.chatLabel,
    connectedAt: config.connectedAt,
    awaitingPairing: Boolean(config.tokenSealed && !config.chatId),
    // Shown so the owner can send it to the bot. It is single-use, dies with
    // the pairing attempt, and grants nothing except becoming the recipient.
    pairingCode: config.chatId ? null : config.pairingCode,
    categories: config.categories,
    minSeverity: config.minSeverity,
    heartbeatHours: config.heartbeatHours,
    lastDeliveryAt: delivery.lastOkAt,
    lastError: delivery.lastError,
    lastErrorAt: delivery.lastErrorAt,
  };
}

/** Six digits, from the crypto RNG. Guessable in principle, but only once. */
function newPairingCode(): string {
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0]! % 900000));
}

/**
 * Step one: the owner pastes the token BotFather gave them.
 *
 * Validated against Telegram before it is stored, because a token that turns
 * out to be wrong three hours later, silently, at the moment it was needed, is
 * the failure this whole feature exists to prevent.
 */
export async function connectTelegram(token: string, fetchImpl: typeof fetch = fetch): Promise<TelegramStatus> {
  const trimmed = token.trim();
  if (!trimmed) throw new BadRequestError('Paste the token BotFather gave you.');
  // BotFather tokens are "<bot id>:<secret>". Checked here so an obvious paste
  // mistake is a sentence rather than a round trip to Telegram.
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    throw new BadRequestError(
      'That does not look like a bot token. It should be a number, a colon, then a long string -- copy the whole line BotFather sent.',
    );
  }

  const bot = await getMe(trimmed, fetchImpl);
  const config = await loadConfig();
  await saveConfig({
    ...config,
    tokenSealed: sealSecret(trimmed),
    botUsername: bot.username,
    // A new token means a new bot, so any previous chat is meaningless.
    chatId: null,
    chatLabel: null,
    connectedAt: null,
    pairingCode: newPairingCode(),
    updateOffset: null,
    enabled: true,
  });
  return telegramStatus();
}

/**
 * Step two: find out which chat to send to.
 *
 * A bot can be messaged by anybody who knows its username, and `getUpdates`
 * returns all of it. Taking the first chat that appears would let whoever found
 * the bot first receive the owner's notifications -- account handles, failure
 * reasons, which agent is stopped. So the owner is given a code, and only the
 * chat that sends that exact code is accepted.
 */
export async function pairTelegram(fetchImpl: typeof fetch = fetch): Promise<TelegramStatus> {
  const config = await loadConfig();
  if (!config.tokenSealed) throw new BadRequestError('Add the bot token first.');
  if (config.chatId) return telegramStatus();
  if (!config.pairingCode) throw new BadRequestError('Start again: this pairing attempt has no code.');

  const token = openSecret(config.tokenSealed);
  const updates = await getUpdates(token, config.updateOffset ?? undefined, fetchImpl);

  let highest = config.updateOffset ?? null;
  for (const update of updates) {
    highest = Math.max(highest ?? 0, update.update_id);
    const message = update.message;
    if (!message?.text) continue;
    if (!message.text.includes(config.pairingCode)) continue;

    const chat = message.chat;
    const label = chat.title ?? chat.username ?? chat.first_name ?? `chat ${chat.id}`;
    await saveConfig({
      ...config,
      chatId: chat.id,
      chatLabel: label,
      connectedAt: new Date().toISOString(),
      pairingCode: null,
      // +1 acknowledges this update, so the code cannot be replayed out of the
      // backlog by somebody who saw it over a shoulder.
      updateOffset: update.update_id + 1,
    });

    // Anything already open predates the connection. Somebody who has just
    // paired does not want a fortnight of history arriving at once.
    const caughtUp = await markCaughtUp(TELEGRAM_TRANSPORT);
    const opener = [
      '<b>AI17Z is connected.</b>',
      '',
      'You will get a message here when something needs you -- an account waiting on a security challenge, the worker stopping, an agent with no model.',
    ];
    if (caughtUp > 0) {
      opener.push(
        '',
        `${caughtUp === 1 ? 'One notification was' : `${caughtUp} notifications were`} already open. They have been left in the app rather than sent here.`,
      );
    }
    await sendMessage(token, chat.id, opener.join('\n'), fetchImpl);
    return telegramStatus();
  }

  // Nothing matched. The offset still moves, so a long backlog is worked
  // through rather than re-read on every poll.
  if (highest !== null && highest !== config.updateOffset) {
    await saveConfig({ ...config, updateOffset: highest + 1 });
  }
  return telegramStatus();
}

/** Sends a test message, so the owner sees it arrive rather than trusting a tick. */
export async function testTelegram(fetchImpl: typeof fetch = fetch): Promise<void> {
  const config = await loadConfig();
  if (!config.tokenSealed || !config.chatId) throw new BadRequestError('Connect Telegram first.');
  await sendMessage(
    openSecret(config.tokenSealed),
    config.chatId,
    '<b>AI17Z test</b>\nThis is what a notification will look like. Nothing is wrong.',
    fetchImpl,
  );
}

export async function updateTelegramPreferences(input: {
  enabled?: boolean;
  categories?: Partial<Record<TelegramCategory, boolean>>;
  minSeverity?: NotificationSeverity;
  heartbeatHours?: number;
}): Promise<TelegramStatus> {
  const config = await loadConfig();
  await saveConfig({
    ...config,
    enabled: input.enabled ?? config.enabled,
    categories: { ...config.categories, ...(input.categories ?? {}) },
    minSeverity: input.minSeverity ?? config.minSeverity,
    heartbeatHours: input.heartbeatHours ?? config.heartbeatHours,
  });
  return telegramStatus();
}

/**
 * Forgets the bot.
 *
 * The sealed token is removed rather than kept "in case". A disconnected
 * transport holding a live credential is a credential nobody is watching.
 */
export async function disconnectTelegram(): Promise<TelegramStatus> {
  await saveConfig({ ...DEFAULTS });
  return telegramStatus();
}

/** How a notification reads on a phone. */
export function formatNotification(notification: NotificationRecord): string {
  const mark = notification.severity === 'CRITICAL' ? '🔴' : notification.severity === 'WARNING' ? '🟠' : '🔵';
  const lines = [`${mark} <b>${escapeHtml(notification.title)}</b>`];
  if (notification.body) lines.push('', escapeHtml(notification.body));
  if (notification.occurrences > 1) lines.push('', `<i>Seen ${notification.occurrences} times.</i>`);
  if (notification.actionLabel) {
    // The href is almost always a localhost path, which a phone cannot open.
    // Saying where to go is useful; a dead link is not.
    lines.push('', `<i>In AI17Z: ${escapeHtml(notification.actionLabel)}</i>`);
  }
  return lines.join('\n');
}

export const telegramTransport: NotificationTransport = {
  name: TELEGRAM_TRANSPORT,

  async isConfigured() {
    const config = await loadConfig();
    return config.enabled && Boolean(config.tokenSealed) && Boolean(config.chatId);
  },

  async wants(notification) {
    const config = await loadConfig();
    if (SEVERITY_RANK[notification.severity] < SEVERITY_RANK[config.minSeverity]) return false;
    return config.categories[categoryFor(notification.kind)] !== false;
  },

  async deliver(notification) {
    const config = await loadConfig();
    if (!config.tokenSealed || !config.chatId) throw new Error('Telegram is not connected.');
    await sendMessage(openSecret(config.tokenSealed), config.chatId, formatNotification(notification));
  },
};

/**
 * "Still running."
 *
 * The gap this closes: the transport lives in the worker, so the one thing it
 * can never tell anybody about is the worker having stopped. A notification
 * that AI17Z is down cannot be sent by AI17Z. Nothing in a local-first design
 * fixes that from the inside -- so instead the owner can ask for a message on a
 * schedule, and absence becomes the signal. A heartbeat that does not arrive
 * says what no notification could.
 *
 * Off by default. A message every six hours saying nothing happened is how
 * somebody learns to ignore the channel.
 */
export async function telegramHeartbeat(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const config = await loadConfig();
  if (!config.enabled || !config.tokenSealed || !config.chatId || config.heartbeatHours <= 0) return false;

  const dueAfter = config.lastHeartbeatAt
    ? new Date(config.lastHeartbeatAt).getTime() + config.heartbeatHours * 3_600_000
    : 0;
  if (Date.now() < dueAfter) return false;

  try {
    await sendMessage(
      openSecret(config.tokenSealed),
      config.chatId,
      `<b>AI17Z is running.</b>\n<i>Scheduled check, every ${config.heartbeatHours} hour${config.heartbeatHours === 1 ? '' : 's'}. If one of these does not arrive, AI17Z has stopped.</i>`,
      fetchImpl,
    );
  } catch (error) {
    // A heartbeat that fails is not worth a notification of its own: the next
    // one will fail too, and the owner is about to notice the silence, which is
    // exactly what the heartbeat is for.
    log.warn('heartbeat could not be sent', { message: errorMessage(error) });
    return false;
  }

  await saveConfig({ ...config, lastHeartbeatAt: new Date().toISOString() });
  return true;
}

/** Called once at worker startup. */
export function installTelegramTransport(): void {
  registerTransport(telegramTransport);
}

export function isTelegramError(error: unknown): error is TelegramError {
  return error instanceof Error && 'status' in error && 'retryable' in error;
}
