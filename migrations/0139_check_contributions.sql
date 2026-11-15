-- What this installation has told Studio's "most checked" board, per mint and UTC hour.
-- A delivery ledger only: a count, never an asker, agent, handle or text. It is what lets a
-- repeated sweep send each bucket once and a changed count replace the earlier one.
CREATE TABLE studio_check_contributions (
  chain text NOT NULL CHECK (chain IN ('solana','ethereum','bnb','base','polygon','arbitrum','optimism','avalanche','robinhood')),
  address text NOT NULL,
  bucket_start timestamptz NOT NULL CHECK (extract(epoch FROM bucket_start)::bigint % 3600 = 0),
  askers integer NOT NULL CHECK (askers >= 1),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, address, bucket_start)
);
CREATE INDEX studio_check_contributions_sent ON studio_check_contributions(sent_at);
