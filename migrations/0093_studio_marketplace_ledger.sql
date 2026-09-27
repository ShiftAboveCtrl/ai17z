-- What this installation's owner was asked to pay for, and what happened.
--
-- AI17Z Studio keeps the commercial record. This is the local one: every
-- purchase the owner's wallet was asked to sign from inside AI17Z, with the
-- exact terms it was shown, so "what did my AI17Z ask my wallet to do" has an
-- answer that does not depend on a website being reachable.
--
-- It is also what stops a payment being sent twice. A purchase whose wallet
-- request is outstanding, or whose transaction is already known, is never
-- prepared again on its own: a financial retry has to be a person saying
-- nothing was sent, never a loop deciding it on their behalf.
CREATE TABLE studio_purchase_ledger (
  -- Studio's own id for the checkout.
  intent_id          uuid PRIMARY KEY,
  plugin_id          text NOT NULL,
  plugin_name        text NOT NULL,
  chain_id           integer NOT NULL,
  token_address      text NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  payer_address      text NOT NULL CHECK (payer_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address  text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  -- Base units, exactly. Never a decimal.
  amount_base_units  numeric(78, 0) NOT NULL CHECK (amount_base_units > 0),
  state              text NOT NULL CHECK (state IN ('PREPARED', 'SENT', 'ABANDONED', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  tx_hash            text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- Studio's word on it, as last heard.
  studio_status      text,
  note               text,
  prepared_at        timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  settled_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- A transaction pays for one purchase, ever.
  CONSTRAINT studio_purchase_ledger_sent_has_hash CHECK (state <> 'SENT' OR tx_hash IS NOT NULL)
);

CREATE UNIQUE INDEX studio_purchase_ledger_tx_hash_key ON studio_purchase_ledger (tx_hash) WHERE tx_hash IS NOT NULL;

-- The terms are what the wallet was shown. Changing them afterwards would
-- make the record say something different from what was signed.
CREATE OR REPLACE FUNCTION studio_purchase_ledger_terms_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'studio purchase % cannot be deleted', OLD.intent_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
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

CREATE TRIGGER studio_purchase_ledger_terms_frozen
  BEFORE UPDATE OR DELETE ON studio_purchase_ledger
  FOR EACH ROW EXECUTE FUNCTION studio_purchase_ledger_terms_frozen();

-- Whether the registry a Plugin came from said it needs an entitlement.
-- Recorded at install, from the catalogue listing, and read by the Studio
-- gate: such a Plugin runs only while a signed lease says this installation
-- may use exactly that version. A Plugin from a registry that never said so
-- is untouched, which is every Plugin installed before this existed.
ALTER TABLE installed_plugins ADD COLUMN requires_entitlement boolean NOT NULL DEFAULT false;
