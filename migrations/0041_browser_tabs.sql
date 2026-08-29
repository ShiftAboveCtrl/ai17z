-- What each of an account's three browser tabs is doing.
--
-- The API never opens a browser, so it cannot ask; only the worker knows. The
-- worker writes this on every browser operation and on a heartbeat, and the
-- account page reads it. Without it, "the mentions monitor is dead" looks
-- exactly like "nothing has been mentioned".
--
-- One row per account holding an array of {role, state, url, lastUsedAt,
-- lastError}. A jsonb array rather than a table because it is a snapshot of
-- live process state, not history: it is overwritten, never accumulated.

ALTER TABLE browser_sessions
  ADD COLUMN tabs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN tabs_updated_at timestamptz;
