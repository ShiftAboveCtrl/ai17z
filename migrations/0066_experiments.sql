-- Trying one way of writing against another, at the rate an agent actually posts.
--
-- An agent posts a couple of times a day. That is the fact this whole feature is
-- arranged around: a difference between two ways of writing takes weeks to show,
-- and a tool that announces a winner on Thursday is worse than no tool, because
-- the owner acts on it and the agent's voice drifts on the strength of eleven
-- posts. The arithmetic that decides lives in `packages/runtime/src/experiments.ts`
-- and refuses to answer below a floor; this is only where the question is kept.

CREATE TABLE experiments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- What is being asked, in a sentence somebody wrote. Not generated: an
  -- experiment nobody can state is an experiment nobody can act on.
  hypothesis text NOT NULL,
  status     text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'STOPPED')),

  -- Two arms, each with the instruction that makes it different. The key is
  -- what results are recorded against and never changes; the label and the
  -- instruction are editable text.
  variant_a_key         text NOT NULL,
  variant_a_label       text NOT NULL,
  variant_a_instruction text NOT NULL DEFAULT '',
  variant_b_key         text NOT NULL,
  variant_b_label       text NOT NULL,
  variant_b_instruction text NOT NULL DEFAULT '',
  CHECK (variant_a_key <> variant_b_key),

  -- Posts per arm before a verdict is possible. Stored so an owner can raise it
  -- for a fast-posting account; the code clamps it, and there is no way to
  -- lower it past the floor.
  minimum_per_arm integer NOT NULL DEFAULT 12 CHECK (minimum_per_arm >= 12),

  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);

-- At most one running experiment per agent.
--
-- Two at once are one experiment with four arms and no way to attribute
-- anything to either question: a post written short *and* with a picture
-- belongs to both, and whichever finishes first takes credit for the other's
-- effect. A partial unique index says so at the database rather than in a
-- screen that somebody will eventually bypass.
CREATE UNIQUE INDEX experiments_one_running ON experiments (agent_id) WHERE status = 'RUNNING';

CREATE INDEX experiments_agent_idx ON experiments (agent_id, created_at DESC);

-- Which arm a post was written for.
--
-- Recorded rather than recomputed. `assignVariant` is a stable hash so a
-- restart between generating a post and publishing it cannot move it between
-- arms -- but the experiment id is part of that hash, and recomputing later
-- against an experiment somebody edited would silently reshuffle every result
-- that had already been counted.
CREATE TABLE experiment_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- The job the post was written by. Null once that job is gone; the reading is
  -- still valid because the remote post and its arm are what matter.
  job_id        uuid REFERENCES jobs (id) ON DELETE SET NULL,
  -- Filled in when the post is actually published. Absent means it was written
  -- and never sent, which takes no part in any comparison.
  remote_post_id text,
  variant_key   text NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now()
);

-- One assignment per job. A job that is retried is the same post, and counting
-- it twice would put one post in an arm twice.
CREATE UNIQUE INDEX experiment_assignments_job
  ON experiment_assignments (experiment_id, job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX experiment_assignments_reading
  ON experiment_assignments (experiment_id, variant_key)
  WHERE remote_post_id IS NOT NULL;
