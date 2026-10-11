-- A third kind of wallet intent: a Solana swap through Jupiter's own router,
-- approved by the digest of the exact transaction message that would be signed.
-- Widening the CHECK is the whole change; the rows and their lifecycle are the
-- same as a transfer's.
ALTER TABLE wallet_intents DROP CONSTRAINT wallet_intents_kind_check;
ALTER TABLE wallet_intents ADD CONSTRAINT wallet_intents_kind_check
  CHECK (kind IN ('NATIVE_TRANSFER', 'TOKEN_TRANSFER', 'SOLANA_SWAP'));
