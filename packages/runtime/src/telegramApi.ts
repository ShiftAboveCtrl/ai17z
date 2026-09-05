/**
 * The Telegram Bot API, in the four calls AI17Z actually makes.
 *
 * Telegram is used here as a *transport for owner notifications*, not as a
 * channel an agent acts on. Nothing an agent says goes through this file and
 * nothing that arrives here reaches an agent. The distinction is the whole
 * reason it lives beside `notify` rather than in `packages/channels`: a channel
 * adapter carries an agent's identity, and this carries the installation's.
 *
 * Why Telegram at all, for a local-first application with no servers: every
 * call below is an outbound HTTPS request from the machine AI17Z runs on. There
 * is no webhook, so no inbound port, no tunnel, no public hostname and nothing
 * to expose. A laptop behind a router can reach a phone anywhere without
 * anything in the middle that belongs to us.
 *
 * The token is the whole of the bot's security. Anyone holding it can read
 * everything the bot has been sent and post as it, so it is sealed under the
 * master key, never returned by an API route, never logged, and never carried
 * in an agent export. `redact()` blanks it if one ever reaches a log line by
 * another path.
 */
import { errorMessage } from '@xbam/shared';

const API = 'https://api.telegram.org';

/**
 * Long enough for a phone on a bad connection, short enough that a sweep does
 * not stall behind a service that has stopped answering.
 */
const TIMEOUT_MS = 10_000;

export interface TelegramError extends Error {
  /** Telegram's own code: 401 for a bad token, 403 for a blocked bot, 429 for a flood wait. */
  status: number;
  /** Seconds Telegram asked us to wait, when it said so. */
  retryAfterSeconds: number | null;
  /** Whether trying the same thing again could work. */
  retryable: boolean;
}

function telegramError(message: string, status: number, retryAfterSeconds: number | null): TelegramError {
  const error = new Error(message) as TelegramError;
  error.status = status;
  error.retryAfterSeconds = retryAfterSeconds;
  // 401 is a revoked or mistyped token and 403 is a bot the person blocked.
  // Neither improves by being tried again; everything else might.
  error.retryable = status !== 401 && status !== 403 && status !== 400;
  return error;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * One call.
 *
 * `token` is passed in rather than read from settings, so this file never
 * touches the database and a test can exercise it without one.
 */
export async function callTelegram<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // No answer at all: offline, DNS, blocked, timed out. Worth retrying, and
    // the message must not contain the URL, which contains the token.
    throw telegramError(`Telegram could not be reached: ${errorMessage(error)}`, 0, null);
  }

  let payload: TelegramResponse<T>;
  try {
    payload = (await response.json()) as TelegramResponse<T>;
  } catch {
    throw telegramError(`Telegram answered ${response.status} with something that was not JSON.`, response.status, null);
  }

  if (!payload.ok) {
    const status = payload.error_code ?? response.status;
    throw telegramError(explain(status, payload.description ?? 'no reason given'), status, payload.parameters?.retry_after ?? null);
  }

  return payload.result as T;
}

/**
 * Telegram's own wording, replaced where a person could act on something better.
 *
 * "Unauthorized" is accurate and useless. What somebody needs to hear is which
 * of the two things they did is wrong.
 */
function explain(status: number, description: string): string {
  switch (status) {
    case 401:
      return 'Telegram rejected the bot token. Check it was copied whole, including the number and the colon at the front.';
    case 403:
      return 'The bot cannot message you. Open the chat with it in Telegram and press Start, or unblock it.';
    case 404:
      return 'Telegram does not recognise that bot. The token may belong to a bot that has since been deleted.';
    case 429:
      return 'Telegram is rate limiting this bot. Notifications will resume by themselves.';
    default:
      return `Telegram refused the request: ${description}`;
  }
}

export interface TelegramBot {
  id: number;
  username: string;
  first_name: string;
}

/** Who this token belongs to. The one call that proves a token is real. */
export async function getMe(token: string, fetchImpl: typeof fetch = fetch): Promise<TelegramBot> {
  return callTelegram<TelegramBot>(token, 'getMe', {}, fetchImpl);
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
    from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
  };
}

/**
 * What has been said to the bot.
 *
 * Used once, during pairing, to learn which chat to send to. AI17Z does not
 * poll this in normal running: a notification transport has nothing to do with
 * incoming messages, and reading them continuously would make this a channel.
 *
 * `offset` acknowledges everything before it, so the pairing step does not
 * re-read a message it has already considered.
 */
export async function getUpdates(
  token: string,
  offset?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramUpdate[]> {
  return callTelegram<TelegramUpdate[]>(
    token,
    'getUpdates',
    // timeout 0 means do not hold the connection open. The pairing UI polls;
    // holding a long poll would make cancelling it awkward for no benefit.
    { timeout: 0, limit: 20, allowed_updates: ['message'], ...(offset === undefined ? {} : { offset }) },
    fetchImpl,
  );
}

/**
 * Sends a message.
 *
 * HTML rather than Markdown because notification text contains handles, paths
 * and model names, and Markdown's underscores and asterisks turn those into
 * formatting or into a parse error. Only the tags AI17Z emits are allowed
 * through, and everything interpolated is escaped.
 */
export async function sendMessage(
  token: string,
  chatId: number,
  html: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await callTelegram(
    token,
    'sendMessage',
    {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      // A notification about a link should not unfurl the link. The preview is
      // usually a localhost address the phone cannot reach anyway.
      link_preview_options: { is_disabled: true },
    },
    fetchImpl,
  );
}

/**
 * Escapes text for Telegram's HTML mode.
 *
 * Notification bodies contain whatever an error said, and an error containing
 * a `<` would otherwise fail the whole send with a parse error -- so the
 * notification about the broken thing would itself be broken.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
