-- ---------------------------------------------------------------------------
-- A repository's existing history is not news
-- ---------------------------------------------------------------------------
--
-- The first poll of a newly watched repository records everything GitHub will
-- hand over: twenty releases, twenty commits, whatever pull requests are open.
-- All of it is recorded in the same second, so all of it is inside the window
-- of the next wake, and the agent's working set fills in one go with twenty
-- near-identical items -- one per release tag, each scoring the same, each
-- crowding out whatever was actually happening.
--
-- Measured on the live ai17zos agent's first wake: 34 observations, 23
-- attended, and the top ten were "AI17Z Beta 1.0.0 (17)", "(19)", "(20)",
-- "Beta 3.1", "Beta 3.2" and so on. That is the changelog bot `worthNoticing`
-- was written to prevent, arriving through a door it does not cover.
--
-- The precedent is `RETROACTIVE_WORK_WINDOW_MS` in ingest.ts, and the rule is
-- the same one: widening what an agent is triggered by changes what happens
-- next, never what happened yesterday. Connecting a repository today is not a
-- reason to have opinions about a release from last week.
--
-- The rows are still recorded, and the owner still sees the whole history on
-- the screen. What backfill decides is only whether the agent is told about it
-- as something that just happened.
ALTER TABLE repo_events ADD COLUMN backfill boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN repo_events.backfill IS
  'Recorded by a source''s first poll, so it is history rather than news. Shown to the owner, never offered to deliberation.';

-- Everything recorded before this column existed came from a first poll or
-- shortly after, and every installation that has watched a repository has the
-- flood. Marking the existing rows history is the honest reading: nothing that
-- old is something that just happened.
UPDATE repo_events SET backfill = true WHERE seen_at < now();
