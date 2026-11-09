ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_channel_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_channel_check
  CHECK (channel IN ('mock','x','bluesky','farcaster','discord','telegram','slack','email','http'));

CREATE TABLE farcaster_signers (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  sealed_signer_key text NOT NULL,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Opaque cursors belong to adapters. A version stops an overlapping poll
-- overwriting a newer cursor after it finishes ingesting the same page.
CREATE TABLE channel_poll_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  cursor text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);

-- Persist bytes before sending. Replaying one key sends the same signed hash,
-- including after a lost response, process restart or signing key rotation.
CREATE TABLE channel_outgoing_messages (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  message bytea NOT NULL,
  PRIMARY KEY (account_id, idempotency_key)
);
