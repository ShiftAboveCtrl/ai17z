-- `commitments` was written before every other table here grew an updated_at,
-- and the follow-up work is the first thing that needed one: a row that moves
-- through OPEN, DUE and a settled state without recording when it last moved
-- cannot answer "has this been sitting here" -- which is the only question an
-- owner asks about a promise.
--
-- Its own migration rather than an edit to 0051, because 0051 has been applied
-- and the migrator reports an edited migration as drift and refuses to re-run
-- it. That is the right behaviour and this is what it looks like to work with.
ALTER TABLE commitments ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
