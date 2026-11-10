-- A card is about one contract on one chain, and the cooldown has to see the
-- same contract whichever way it was typed.
--
-- 0124 keyed the cooldown on the address as written. An EVM address is
-- case-insensitive (the mixed case is only a checksum), so 0xAbC... and 0xabc...
-- were two mints and each earned its own card. The chain was not part of the
-- lookup either, so the same string asked about on two chains could be answered
-- with a pointer at the other chain's card. Solana addresses are base58 and
-- case-sensitive, so they stay exactly as written.
--
-- Generated rather than written by the application, so no writer can disagree
-- with the reader about what "the same contract" means. `canonicalMint` in the
-- repository computes the same value for the lookup, and a test pins the two.
ALTER TABLE mint_check_requests
  ADD COLUMN mint_key text GENERATED ALWAYS AS (
    CASE
      WHEN mint IS NULL THEN NULL
      WHEN chain = 'solana' THEN mint
      ELSE lower(mint)
    END
  ) STORED;

-- Replaces 0124's index on the address as written, which nothing reads any more.
DROP INDEX IF EXISTS mint_check_requests_card;

-- The lookup the cooldown makes: this agent, this chain, this contract, newest first.
CREATE INDEX mint_check_requests_contract
  ON mint_check_requests (agent_id, chain, mint_key, created_at DESC)
  WHERE outcome = 'CARD';
