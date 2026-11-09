-- Bluesky as a channel.
--
-- Only `accounts.channel` carries a CHECK on the channel name. Events, jobs,
-- actions, relationships and conversations store the channel as plain text, so
-- widening this one constraint is the whole schema change: a Bluesky account is
-- an ordinary row, its mentions are ordinary events under the existing unique
-- index on (channel, account, remote_event_id), and its app password is an
-- ordinary sealed account_credentials row (username = handle or email,
-- password = the app password), exactly the arrangement an X sign-in uses.
--
-- The list is the one in ChannelId (packages/shared/src/contracts/enums.ts).
-- tests/integration/statusConstraints.test.ts writes every value of it.

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_channel_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_channel_check
  CHECK (channel IN ('mock','x','bluesky','farcaster','discord','telegram','slack','email','http'));
