-- A Studio checkout can now be more than one payment: the publisher's share
-- and, on a paid plan, the marketplace fee, each its own transfer in ETH or
-- $AI17Z. The local ledger records each one separately, because each is a
-- separate request to the owner's wallet and a separate transaction.
--
-- A row is now (intent, leg, attempt). The attempt exists for one case only:
-- Studio read a transaction for a leg off the chain and refused it (it
-- reverted, say). That leg is still owed, and the record of what was sent and
-- refused must stay exactly as it was, so paying it again is a new row rather
-- than an edit. Every row already here is the first attempt of the only leg of
-- a single $AI17Z payment, which is what the defaults say.
ALTER TABLE studio_purchase_ledger
  ADD COLUMN leg_index integer NOT NULL DEFAULT 0 CHECK (leg_index BETWEEN 0 AND 7),
  ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  ADD COLUMN role text NOT NULL DEFAULT 'PUBLISHER' CHECK (role IN ('PUBLISHER', 'TREASURY')),
  ADD COLUMN asset text NOT NULL DEFAULT 'AI17Z' CHECK (asset IN ('AI17Z', 'ETH')),
  -- What was bought, as Studio described it; shown, never used to pay.
  ADD COLUMN billing_mode text,
  ADD COLUMN intent_kind text;

ALTER TABLE studio_purchase_ledger DROP CONSTRAINT studio_purchase_ledger_pkey;
ALTER TABLE studio_purchase_ledger ADD PRIMARY KEY (intent_id, leg_index, attempt);

-- An ETH payment has no token. Studio records the zero address for it.
ALTER TABLE studio_purchase_ledger ADD CONSTRAINT studio_purchase_ledger_asset_token
  CHECK ((asset = 'ETH') = (token_address = '0x0000000000000000000000000000000000000000'));

CREATE OR REPLACE FUNCTION studio_purchase_ledger_terms_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'studio purchase % cannot be deleted', OLD.intent_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.leg_index IS DISTINCT FROM OLD.leg_index
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
     OR NEW.token_address IS DISTINCT FROM OLD.token_address
     OR NEW.payer_address IS DISTINCT FROM OLD.payer_address
     OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
     OR NEW.amount_base_units IS DISTINCT FROM OLD.amount_base_units
     OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) THEN
    RAISE EXCEPTION 'the terms of studio purchase % are frozen', OLD.intent_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
