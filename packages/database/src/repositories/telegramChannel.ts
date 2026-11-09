import { BadRequestError, PipelineError, openSecret, sealSecret } from '@xbam/shared';
import type { Account } from '@xbam/shared/contracts';
import { query, queryOne, withTransaction } from '../pool';
import { mapRow } from '../mapper';

const ACCOUNT_COLUMNS = `
  id, owner_id, channel, remote_account_id, handle, display_name, status, enabled,
  capabilities, settings, last_health_check_at, last_health_status, last_activity_at,
  last_error, auth_started_at, auth_deadline_at, challenge_kind, created_at, updated_at`;

/**
 * Everything a Telegram group account keeps.
 *
 * This is the agent channel's own store. The notification transport keeps its
 * bot in the `settings` table and shares nothing with it: a different token, a
 * different update offset, a different table. Nothing in this file reads
 * `notifications.telegram`, and nothing in the transport reads these tables.
 */

export interface TelegramBotIdentity {
  botId: string;
  botUsername: string;
}

/** Presence is the only thing about the token that may leave the server. */
export interface TelegramPresence {
  hasToken: boolean;
  botUsername: string | null;
}

export interface TelegramChat {
  chatId: string;
  title: string;
}

/** The sealed columns are never selected here; `getDecryptedToken` is the one way in. */
export async function presence(accountId: string): Promise<TelegramPresence> {
  const row = await queryOne<{ bot_username: string }>(
    'SELECT bot_username FROM telegram_bots WHERE account_id = $1',
    [accountId],
  );
  return { hasToken: Boolean(row), botUsername: row?.bot_username ?? null };
}

export async function identity(accountId: string): Promise<TelegramBotIdentity | null> {
  const row = await queryOne<{ bot_id: string; bot_username: string }>(
    'SELECT bot_id, bot_username FROM telegram_bots WHERE account_id = $1',
    [accountId],
  );
  return row ? { botId: row.bot_id, botUsername: row.bot_username } : null;
}

/** Plaintext, for the one call that needs it. Never put into a log line or a row. */
export async function getDecryptedToken(accountId: string): Promise<string | null> {
  const row = await queryOne<{ sealed_token: string }>(
    'SELECT sealed_token FROM telegram_bots WHERE account_id = $1',
    [accountId],
  );
  return row ? openSecret(row.sealed_token) : null;
}

function isBotIdConflict(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'telegram_bots_bot_id_key';
}

const BOT_TAKEN = 'That bot is already linked to another account. Make a separate bot with BotFather for each agent.';

/**
 * Makes the account and stores its bot in one transaction.
 *
 * The caller has already proved the token against Telegram, so a typo creates
 * neither an account row nor a sealed credential.
 */
export async function createWithBot(input: {
  ownerId: string;
  bot: TelegramBotIdentity;
  token: string;
  capabilities: string[];
}): Promise<Account> {
  const sealed = sealSecret(input.token);
  try {
    return await withTransaction(async (tx) => {
      const taken = await tx.one(
        'SELECT 1 AS one FROM accounts WHERE owner_id = $1 AND channel = $2 AND lower(handle) = lower($3)',
        [input.ownerId, 'telegram', input.bot.botUsername],
      );
      if (taken) throw new BadRequestError('That bot is already an account. Replace its token on the account instead.');
      const row = await tx.one(
        `INSERT INTO accounts (owner_id, channel, handle, display_name, remote_account_id, status, enabled,
                               capabilities, last_health_status, last_health_check_at)
         VALUES ($1,'telegram',$2,$2,$3,'CONNECTED',true,$4::jsonb,'Bot verified.',now())
         RETURNING ${ACCOUNT_COLUMNS}`,
        [input.ownerId, input.bot.botUsername, input.bot.botId, JSON.stringify(input.capabilities)],
      );
      const account = mapRow<Account>(row) as Account;
      await tx.query(
        `INSERT INTO telegram_bots (account_id, bot_id, bot_username, sealed_token) VALUES ($1,$2,$3,$4)`,
        [account.id, input.bot.botId, input.bot.botUsername, sealed],
      );
      return account;
    });
  } catch (error) {
    if (isBotIdConflict(error)) throw new BadRequestError(BOT_TAKEN);
    throw error;
  }
}

/**
 * Replaces the token of the same bot, for example after /revoke in BotFather.
 *
 * A different bot is a different account (its username is the account's
 * handle), so it is refused. The offset belongs to the bot that issued it and is
 * cleared with the token; the version moves so a poll already in flight cannot
 * write the old one back.
 */
export async function replaceToken(accountId: string, bot: TelegramBotIdentity, token: string): Promise<void> {
  const sealed = sealSecret(token);
  await withTransaction(async (tx) => {
    const account = await tx.one<{ channel: string }>('SELECT channel FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (account?.channel !== 'telegram') throw new BadRequestError('This account is not on Telegram.');
    const current = await tx.one<{ bot_id: string }>('SELECT bot_id FROM telegram_bots WHERE account_id = $1', [accountId]);
    if (current && current.bot_id !== bot.botId) {
      throw new BadRequestError('That token belongs to a different bot. Link it as a new account instead.');
    }
    try {
      await tx.query(
        `INSERT INTO telegram_bots (account_id, bot_id, bot_username, sealed_token) VALUES ($1,$2,$3,$4)
         ON CONFLICT (account_id) DO UPDATE
           SET sealed_token = excluded.sealed_token, bot_username = excluded.bot_username,
               update_offset = NULL, poll_version = telegram_bots.poll_version + 1, updated_at = now()`,
        [accountId, bot.botId, bot.botUsername, sealed],
      );
    } catch (error) {
      if (isBotIdConflict(error)) throw new BadRequestError(BOT_TAKEN);
      throw error;
    }
    await tx.query(
      `UPDATE accounts SET status = 'CONNECTED', enabled = true, last_health_status = 'Bot verified.',
              last_error = NULL, last_health_check_at = now(), updated_at = now()
        WHERE id = $1`,
      [accountId],
    );
  });
}

/**
 * Forgets the bot, as the notification transport does on disconnect: a stopped
 * account holding a live credential is a credential nobody is watching.
 *
 * The allowlist stays, so reconnecting later does not mean choosing groups again.
 */
export async function clearBot(accountId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const account = await tx.one<{ channel: string }>('SELECT channel FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (account?.channel !== 'telegram') throw new BadRequestError('This account is not on Telegram.');
    await tx.query(
      `UPDATE accounts SET enabled = false, status = 'DISCONNECTED', last_health_status = 'Disconnected by the owner.',
              last_error = NULL, next_poll_at = NULL, last_health_check_at = now(), updated_at = now()
        WHERE id = $1`,
      [accountId],
    );
    await tx.query('DELETE FROM telegram_bots WHERE account_id = $1', [accountId]);
  });
}

export interface TelegramPollState {
  offset: number | null;
  version: number;
}

export async function pollState(accountId: string): Promise<TelegramPollState | null> {
  const row = await queryOne<{ update_offset: string | null; poll_version: number }>(
    'SELECT update_offset, poll_version FROM telegram_bots WHERE account_id = $1',
    [accountId],
  );
  return row ? { offset: row.update_offset === null ? null : Number(row.update_offset), version: row.poll_version } : null;
}

/**
 * Moves the offset on, only if nothing else did meanwhile.
 *
 * Called by the poller after the batch was ingested, never before: an offset
 * ahead of the events it covers is how messages are lost. A late poll whose
 * claim expired finds the version moved and changes nothing.
 */
export async function advanceOffset(accountId: string, version: number, offset: number): Promise<boolean> {
  const rows = await query(
    `UPDATE telegram_bots SET update_offset = GREATEST(coalesce(update_offset, 0), $3), poll_version = poll_version + 1,
            updated_at = now()
      WHERE account_id = $1 AND poll_version = $2 RETURNING poll_version`,
    [accountId, version, offset],
  );
  return rows.length === 1;
}

export async function listChats(accountId: string): Promise<TelegramChat[]> {
  const rows = await query<{ chat_id: string; title: string }>(
    'SELECT chat_id, title FROM telegram_chats WHERE account_id = $1 ORDER BY created_at, chat_id',
    [accountId],
  );
  return rows.map((row) => ({ chatId: row.chat_id, title: row.title }));
}

export async function isChatAllowed(accountId: string, chatId: string): Promise<boolean> {
  return Boolean(
    await queryOne('SELECT 1 FROM telegram_chats WHERE account_id = $1 AND chat_id = $2', [accountId, chatId]),
  );
}

export async function allowChat(accountId: string, chatId: string, title: string): Promise<void> {
  await query(
    `INSERT INTO telegram_chats (account_id, chat_id, title) VALUES ($1,$2,$3)
     ON CONFLICT (account_id, chat_id) DO UPDATE SET title = excluded.title`,
    [accountId, chatId, title.slice(0, 300)],
  );
}

export async function forgetChat(accountId: string, chatId: string): Promise<boolean> {
  const rows = await query(
    'DELETE FROM telegram_chats WHERE account_id = $1 AND chat_id = $2 RETURNING chat_id',
    [accountId, chatId],
  );
  return rows.length === 1;
}

export type OutboxState = 'SENDING' | 'SENT';

export interface OutboxRow {
  state: OutboxState;
  chatId: string;
  remoteMessageId: string | null;
}

export async function outboxRow(accountId: string, key: string, digest: string): Promise<OutboxRow | null> {
  const row = await queryOne<{ request_digest: string; state: OutboxState; chat_id: string; remote_message_id: string | null }>(
    'SELECT request_digest, state, chat_id, remote_message_id FROM telegram_outbox WHERE account_id = $1 AND idempotency_key = $2',
    [accountId, key],
  );
  if (row && row.request_digest !== digest) {
    throw PipelineError.permanent('telegram_idempotency_conflict', 'This action key already belongs to a different message.');
  }
  return row ? { state: row.state, chatId: row.chat_id, remoteMessageId: row.remote_message_id } : null;
}

/**
 * Claims the right to send. The insert wins or it does not: a second worker on
 * the same key gets `false` and must not send.
 */
export async function beginSend(accountId: string, key: string, digest: string, chatId: string): Promise<boolean> {
  const rows = await query(
    `INSERT INTO telegram_outbox (account_id, idempotency_key, request_digest, state, chat_id)
     VALUES ($1,$2,$3,'SENDING',$4) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
    [accountId, key, digest, chatId],
  );
  return rows.length === 1;
}

export async function settleSend(accountId: string, key: string, remoteMessageId: string): Promise<void> {
  await query(
    `UPDATE telegram_outbox SET state = 'SENT', remote_message_id = $3, updated_at = now()
      WHERE account_id = $1 AND idempotency_key = $2`,
    [accountId, key, remoteMessageId],
  );
}

/** Telegram refused the request outright, so it is known not to have been sent. */
export async function abandonSend(accountId: string, key: string): Promise<void> {
  await query(
    `DELETE FROM telegram_outbox WHERE account_id = $1 AND idempotency_key = $2 AND state = 'SENDING'`,
    [accountId, key],
  );
}
