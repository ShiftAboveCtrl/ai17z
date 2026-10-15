-- What the owner preauthorizes the agent's guardian to sell without waking them:
-- the triggers, and the worst slippage, impact and fee an exit may take. Only
-- ever a sale of something held, back to the native coin, in the agent's own
-- wallet. Null is no preauthorization, and every exit waits for the owner.
ALTER TABLE trade_mandates ADD COLUMN protective_exits jsonb;
