-- AI17Z 0058: a radar source is one row, even when it has no target.
--
-- `UNIQUE (account_id, kind, target)` looks like it says "one source per kind
-- per account", and for `tracked_account` and `keyword` -- which carry a target
-- -- it does. For the four that do not, it says nothing at all: SQL nulls are
-- distinct from one another, so two rows with the same account, the same kind
-- and `target IS NULL` do not conflict.
--
-- Which means `upsertSource` has never been an upsert for `notifications`,
-- `mention_search`, `reply_search` or `own_threads`. Its ON CONFLICT clause
-- never fires and every call inserts another row. Three consequences, in order
-- of how much they cost:
--
--   * Turning a source **off** does not turn it off. Easy Mode disables an
--     unwanted monitor by upserting it with `enabled = false`; that wrote a
--     second, disabled row and left the enabled one polling. The setting looked
--     applied and did nothing.
--   * Saving Easy Mode, or pressing "turn on the defaults", added another set
--     of rows each time.
--   * The poller claims rows, so a duplicated source is a duplicated page load
--     on every cycle. The event unique index still made it one job, which is
--     why this cost time rather than correctness and stayed invisible.
--
-- Postgres 15 added NULLS NOT DISTINCT for exactly this, and the compose file
-- pins 16.
--
-- Existing duplicates are collapsed first, keeping the most recently updated
-- row of each group -- the last thing the owner actually asked for -- because
-- the constraint cannot be created while they are there.

DELETE FROM radar_sources a
  USING radar_sources b
 WHERE a.account_id = b.account_id
   AND a.kind = b.kind
   AND a.target IS NULL
   AND b.target IS NULL
   AND (b.updated_at, b.created_at, b.id) > (a.updated_at, a.created_at, a.id);

ALTER TABLE radar_sources
  DROP CONSTRAINT radar_sources_account_id_kind_target_key;

ALTER TABLE radar_sources
  ADD CONSTRAINT radar_sources_account_id_kind_target_key
    UNIQUE NULLS NOT DISTINCT (account_id, kind, target);
