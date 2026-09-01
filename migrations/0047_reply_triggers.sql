-- An agent that answers a stranger and then ignores their answer.
--
-- Every account link was created with trigger_event_types = ["MENTION"], which
-- was the default in five separate places. Two of the four radar monitors exist
-- solely to find replies: `reply_search` runs `to:@handle -from:@handle`, and
-- `own_threads` reads the threads under the agent's own posts. Both were
-- working. Both were recording their discoveries. And ingest dropped every
-- REPLY event they produced with "not triggered by REPLY".
--
-- On this installation that was nineteen of twenty-three replies discarded at
-- the door -- not declined by the engagement heuristic, which never saw them,
-- but refused before any judgement was possible.
--
-- Widening the existing links rather than only the default, because the default
-- is for accounts nobody has connected yet and the problem is on the ones people
-- are already running.
--
-- Only links that already trigger on MENTION are touched. A link deliberately
-- narrowed to something else, or deliberately emptied, is somebody's decision
-- and is left exactly as it is.
UPDATE agent_accounts
   SET trigger_event_types = trigger_event_types || '["REPLY"]'::jsonb
 WHERE trigger_event_types @> '["MENTION"]'::jsonb
   AND NOT trigger_event_types @> '["REPLY"]'::jsonb;
