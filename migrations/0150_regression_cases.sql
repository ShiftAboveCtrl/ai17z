CREATE TABLE agent_regression_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL, subject jsonb NOT NULL,
  source_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  checks jsonb NOT NULL DEFAULT '{}', baseline jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE INDEX ON agent_regression_cases(agent_id) WHERE archived_at IS NULL;
CREATE TABLE agent_regression_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('MANUAL','PERSONA','POLICY','MODEL','PREVIEW')),
  candidate jsonb, baseline_run_id uuid REFERENCES agent_regression_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX ON agent_regression_runs(agent_id, created_at DESC);
CREATE UNIQUE INDEX regression_one_active_run ON agent_regression_runs(agent_id) WHERE finished_at IS NULL;
CREATE TABLE agent_regression_results (
  run_id uuid NOT NULL REFERENCES agent_regression_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES agent_regression_cases(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL, error text, digest jsonb,
  baseline jsonb NOT NULL, checks jsonb NOT NULL, title text NOT NULL,
  PRIMARY KEY (run_id, case_id)
);
CREATE TABLE agent_regression_changes (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('PERSONA','POLICY','MODEL')),
  changed_at timestamptz NOT NULL DEFAULT now(), pending boolean NOT NULL DEFAULT true
);
