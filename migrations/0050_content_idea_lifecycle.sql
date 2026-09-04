-- Giving a claimed idea a way back.
--
-- `claimBestIdea` moves an idea to 'drafting' and nothing ever moved it out
-- again. Not on a successful post -- `markIdeaUsed` existed and had no callers,
-- so used_at and used_job_id were never written and the backlog could not say
-- which post came from which thought. And not on a failed one either: a post
-- that hit a validator refusal, a revoked capability, a dead worker or a person
-- pressing stop left its idea 'drafting' for ever, invisible to the claim and
-- to the owner. Every failure silently spent one idea, and an agent whose
-- backlog had drained that way went quiet reporting "nothing in the idea
-- backlog was worth posting", which was not true.
--
-- The fix is a reconciler rather than a hook on each ending, because there are
-- five endings and the one that matters most -- the worker died -- has no code
-- running to hook. So an idea records the job that took it, and a sweep asks
-- that job how it went.

ALTER TABLE content_ideas
  -- The job currently drafting it. Distinct from used_job_id, which is set only
  -- once something was actually published.
  ADD COLUMN job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  -- How many times a post from this idea has been attempted and not published.
  -- An idea that keeps failing is discarded rather than retried for ever: the
  -- scheduler picks the highest score every time, so one permanently
  -- unpublishable idea would block the backlog behind it.
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  -- Why the last attempt did not produce a post, in words, for the owner.
  ADD COLUMN last_error text NOT NULL DEFAULT '';

-- The sweep reads exactly this set, and it is small.
CREATE INDEX content_ideas_drafting_idx ON content_ideas (updated_at) WHERE status = 'drafting';
