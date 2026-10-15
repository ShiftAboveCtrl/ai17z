-- Which assets a mandate allows. LISTED: only those in allowed_assets, the
-- default and the only scope there was. ANY_SOLANA_TOKEN: any token on Solana,
-- for an agent that trades what it finds, still bound by every amount, count
-- and pause in the mandate. Only the owner writes it.
ALTER TABLE trade_mandates ADD COLUMN asset_scope text NOT NULL DEFAULT 'LISTED' CHECK (asset_scope IN ('LISTED', 'ANY_SOLANA_TOKEN'));
