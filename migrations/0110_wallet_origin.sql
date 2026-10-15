-- How an agent wallet's key came to exist. GENERATED: made by the wallet adapter,
-- recoverable from the database and the master key. PHRASE: derived from a
-- recovery phrase only its owner holds, so it is also recoverable without AI17Z,
-- in any standard wallet. The phrase itself is never stored.
ALTER TABLE agent_wallets ADD COLUMN origin text NOT NULL DEFAULT 'GENERATED' CHECK (origin IN ('GENERATED', 'PHRASE'));
