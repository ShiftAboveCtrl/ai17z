-- REPOST as an action an agent may be configured to attempt.
--
-- `agent_accounts.action_type` has carried a CHECK since 0004 listing every
-- ActionType by name. Adding one in TypeScript without widening it fails at the
-- database and passes every unit test -- the same trap as the account statuses
-- in 0020, which broke every sign-in.
--
-- `actions.type` and `jobs.action_type` are deliberately left alone: neither
-- has a constraint, and adding one now would reject rows written by an older
-- copy of the code mid-upgrade.
--
-- Nothing here grants anything. `linkAgentAccount` seeds capabilities as
-- READ, GENERATE and the link's own action type, so an existing agent gains no
-- new autonomous behaviour from this migration: an agent can only repost once
-- an owner has both set the action and granted the capability. That is the
-- intended default -- new engagement is off until somebody asks for it.

ALTER TABLE agent_accounts DROP CONSTRAINT IF EXISTS agent_accounts_action_type_check;
ALTER TABLE agent_accounts ADD CONSTRAINT agent_accounts_action_type_check
  CHECK (action_type IN ('REPLY','POST','DIRECT_MESSAGE','LIKE','REPOST','REACT','CALL_TOOL','CALL_API','NONE'));
