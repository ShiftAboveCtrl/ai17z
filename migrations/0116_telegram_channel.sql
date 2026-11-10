-- Telegram groups as an agent channel.
--
-- This is not the notification transport. That one lives in the `settings`
-- table under `notifications.telegram`, speaks for the installation, and is
-- never visible to an agent. What is added here belongs to one agent account,
-- uses a bot of its own, and shares nothing with it: not the token, not the
-- update offset, not a table.
--
-- ### No CHECK to widen
--
-- `accounts.channel` already admits 'telegram' (migration 0004 listed it before
-- any adapter existed), so a Telegram account is an ordinary `accounts` row and
-- its messages are ordinary events under the unique index on
-- (channel, account, remote_event_id). Nothing else in the schema names a
-- channel. The one new enum with a CHECK is `telegram_outbox.state`, and
-- tests/integration/statusConstraints.test.ts writes every value of it.
--
-- ### The bot token
--
-- One bot per account, sealed under the master key like the Bluesky app password
-- and the Farcaster signer, and returned by no route: the API says only whether
-- one is held. `bot_id` and `bot_username` are public (they appear in the
-- t.me link) and are what the notification transport is compared against.
--
-- `bot_id` is unique across the whole table. A Bot API token can be read by one
-- consumer: two accounts polling the same bot would take updates from each other
-- and one of them would be answered with a 409 for ever. The index makes that
-- impossible rather than unlikely.
--
-- `update_offset` is the next `getUpdates` offset. It is committed by the poller
-- only after the batch has been ingested, and `poll_version` stops a poll that
-- outlived its claim from overwriting a newer offset. Replacing the token bumps
-- the version and clears the offset, because an offset belongs to the bot that
-- issued it.
CREATE TABLE telegram_bots (
  account_id     uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  bot_id         text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,18}$'),
  bot_username   text NOT NULL,
  sealed_token   text NOT NULL,
  update_offset  bigint CHECK (update_offset IS NULL OR update_offset > 0),
  poll_version   integer NOT NULL DEFAULT 0 CHECK (poll_version >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX telegram_bots_bot_id_key ON telegram_bots (bot_id);

-- ### The groups an owner allows
--
-- Anything from a chat that is not in this table is dropped without a reply.
-- Chat ids are kept as text: supergroup ids are negative and thirteen digits
-- long, and nothing here does arithmetic on them.
CREATE TABLE telegram_chats (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  chat_id     text NOT NULL CHECK (chat_id ~ '^-?[1-9][0-9]{0,18}$'),
  title       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id)
);

-- ### Sending once
--
-- `sendMessage` has no idempotency key and the Bot API cannot read a chat back,
-- so the only record of "this reply went out" is ours. The row is written
-- before the request (SENDING) and settled after it (SENT, with the message
-- id). A row still SENDING when the action is tried again means the earlier
-- attempt ended without an answer, which is exactly the case where it may have
-- been delivered; that goes to a person rather than being sent a second time.
-- A request Telegram refused outright is deleted again, because it is known not
-- to have been sent.
CREATE TABLE telegram_outbox (
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  idempotency_key    text NOT NULL,
  request_digest     text NOT NULL,
  state              text NOT NULL CHECK (state IN ('SENDING','SENT')),
  chat_id            text NOT NULL,
  remote_message_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, idempotency_key),
  CHECK (state = 'SENDING' OR remote_message_id IS NOT NULL)
);
