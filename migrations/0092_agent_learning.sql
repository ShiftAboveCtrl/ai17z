-- An agent that learns from what happened, and checks what it learned.
--
-- The readings were already being collected: every reply and post an agent
-- publishes is revisited and its views, likes, reposts and replies recorded in
-- post_analytics. Nothing ever connected a reading to the choices behind the
-- action, so an agent changed whom it avoided and never how it chose.
--
-- Three tables, all per agent and all removed with it.

/*
  What became of one published action, scored once it has had time to be seen.

  `features` are the choices behind it: how the post was found, how long the
  reply was, whether it asked something, the author's audience, the hour, and
  for each learned preference whether it was applied or held back as the
  control. `reach` is the raw score from the readings; `reward` is where that
  sits among this agent's own recent outcomes, from 0 to 1, so an account with
  forty followers and one with forty thousand learn at the same scale.
*/
CREATE TABLE IF NOT EXISTS agent_learning_outcomes (
  action_id uuid PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  features jsonb NOT NULL,
  reach double precision NOT NULL,
  reward double precision NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_learning_outcomes_agent_idx
  ON agent_learning_outcomes (agent_id, measured_at DESC);

/*
  The evidence for each option of each choice, decayed as it ages.

  `trials` and `reward` are sums that halve every fourteen days, so what worked
  last month counts for less than what worked this week and an agent whose
  audience changed is not held to its old one.
*/
CREATE TABLE IF NOT EXISTS agent_strategy_arms (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  dimension text NOT NULL,
  arm text NOT NULL,
  trials double precision NOT NULL DEFAULT 0,
  reward double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, dimension, arm)
);

/*
  A change the agent made to how it behaves, treated as a hypothesis.

  While RUNNING, the learned option is applied most of the time and the old
  behaviour the rest, as a control. The trial ends KEPT when the learned option
  did at least as well as the control, and REVERTED when it did not.
*/
CREATE TABLE IF NOT EXISTS agent_learning_trials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  dimension text NOT NULL,
  arm text NOT NULL,
  hypothesis text NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  verdict text,
  started_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT agent_learning_trials_status_check CHECK (status IN ('RUNNING', 'KEPT', 'REVERTED'))
);

-- One running trial per choice: two at once on the same choice would each be
-- the other's control.
CREATE UNIQUE INDEX IF NOT EXISTS agent_learning_trials_running
  ON agent_learning_trials (agent_id, dimension) WHERE status = 'RUNNING';

/*
  How far the agent trusts its own conclusions about each choice.

  The recursive part. A kept trial raises it and a reverted one lowers it, and
  the evidence a new trial needs before it starts is divided by it: a choice on
  which the agent has been right before is changed on less, and one on which it
  has been wrong needs more before it is changed again.
*/
CREATE TABLE IF NOT EXISTS agent_learning_dimensions (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  dimension text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1,
  kept integer NOT NULL DEFAULT 0,
  reverted integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, dimension)
);
