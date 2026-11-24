import type { DecisionDigest, RegressionCase, RegressionChecks, RegressionResult, RegressionRun, RegressionCandidate, RegressionTrigger, RegressionSubject } from '@xbam/shared/contracts';
import { BadRequestError, NotFoundError } from '@xbam/shared';
import { query, queryOne, withTransaction, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

export async function listCases(agentId: string): Promise<RegressionCase[]> {
  return mapRows<RegressionCase>(await query('SELECT * FROM agent_regression_cases WHERE agent_id=$1 AND archived_at IS NULL ORDER BY created_at,id', [agentId]));
}
export async function getCase(agentId: string, id: string): Promise<RegressionCase | null> {
  return mapRow<RegressionCase>(await queryOne('SELECT * FROM agent_regression_cases WHERE id=$1 AND agent_id=$2', [id, agentId]));
}
export async function saveCase(input: { agentId: string; title: string; subject: RegressionSubject; sourceJobId: string; checks: RegressionChecks; baseline: DecisionDigest; createdBy: string | null }): Promise<RegressionCase> {
  return withTransaction(async tx => {
    await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [input.agentId]);
    const count = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM agent_regression_cases WHERE agent_id=$1 AND archived_at IS NULL', [input.agentId]);
    if (Number(count?.n) >= 40) throw new BadRequestError('An agent can keep at most 40 active cases. Archive one first.');
    return mapRow<RegressionCase>(await tx.one(`INSERT INTO agent_regression_cases(agent_id,title,subject,source_job_id,checks,baseline,created_by)
      VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7) RETURNING *`, [input.agentId, input.title, JSON.stringify(input.subject), input.sourceJobId, JSON.stringify(input.checks), JSON.stringify(input.baseline), input.createdBy]))!;
  });
}
export async function editCase(agentId: string, id: string, patch: { title?: string; checks?: RegressionChecks; archive?: boolean; baseline?: DecisionDigest }): Promise<RegressionCase> {
  const row = await queryOne(`UPDATE agent_regression_cases SET title=coalesce($3,title), checks=coalesce($4::jsonb,checks),
    archived_at=CASE WHEN $5 THEN now() ELSE archived_at END, baseline=coalesce($6::jsonb,baseline) WHERE id=$1 AND agent_id=$2 RETURNING *`,
  [id, agentId, patch.title ?? null, patch.checks ? JSON.stringify(patch.checks) : null, patch.archive ?? false, patch.baseline ? JSON.stringify(patch.baseline) : null]);
  if (!row) throw new NotFoundError('Case');
  return mapRow<RegressionCase>(row)!;
}
// The unique active-run index is the final guard when callers race to start a run.
export async function createRun(input: { agentId: string; trigger: RegressionTrigger; candidate?: RegressionCandidate; limit?: number }): Promise<RegressionRun> {
  return withTransaction(async tx => {
    await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [input.agentId]);
    const run = mapRow<RegressionRun>(await tx.one(`INSERT INTO agent_regression_runs(agent_id,trigger,candidate) VALUES($1,$2,$3::jsonb) RETURNING *`, [input.agentId, input.trigger, input.candidate ? JSON.stringify(input.candidate) : null]))!;
    // Freeze expectations so later case edits or accepted baselines cannot rewrite this run.
    await tx.query(`INSERT INTO agent_regression_results(run_id,case_id,baseline,checks,title)
      SELECT $1,id,baseline,checks,title FROM agent_regression_cases WHERE agent_id=$2 AND archived_at IS NULL ORDER BY created_at,id LIMIT $3`, [run.id, input.agentId, input.limit ?? 12]);
    return run;
  });
}
export async function getRun(id: string): Promise<RegressionRun | null> {
  return mapRow<RegressionRun>(await queryOne('SELECT * FROM agent_regression_runs WHERE id=$1', [id]));
}
export async function listRuns(agentId: string): Promise<RegressionRun[]> {
  return mapRows<RegressionRun>(await query('SELECT * FROM agent_regression_runs WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 30', [agentId]));
}
export async function results(runId: string): Promise<RegressionResult[]> {
  return mapRows<RegressionResult>(await query('SELECT * FROM agent_regression_results WHERE run_id=$1 ORDER BY case_id', [runId]));
}
export async function setResult(runId: string, caseId: string, patch: { jobId?: string; digest?: DecisionDigest; error?: string }): Promise<void> {
  await query(`UPDATE agent_regression_results SET job_id=coalesce($3,job_id),digest=coalesce($4::jsonb,digest),error=coalesce($5,error) WHERE run_id=$1 AND case_id=$2`, [runId, caseId, patch.jobId ?? null, patch.digest ? JSON.stringify(patch.digest) : null, patch.error ?? null]);
}
export async function finishRun(id: string): Promise<void> {
  await query('UPDATE agent_regression_runs SET finished_at=coalesce(finished_at,now()) WHERE id=$1', [id]);
}
export async function activeRuns(): Promise<RegressionRun[]> {
  return mapRows<RegressionRun>(await query('SELECT * FROM agent_regression_runs WHERE finished_at IS NULL ORDER BY created_at'));
}
// The notice commits with its configuration so a successful save cannot lose the reminder.
export async function noteChange(agentId: string, trigger: 'PERSONA' | 'POLICY' | 'MODEL', tx?: Tx) {
  const db = tx ?? { query };
  // Transaction start time can predate a run that did not include this save.
  await db.query(`INSERT INTO agent_regression_changes(agent_id,trigger,changed_at) VALUES($1,$2,clock_timestamp())
    ON CONFLICT(agent_id) DO UPDATE SET trigger=$2, changed_at=excluded.changed_at, pending=true`, [agentId, trigger]);
}
export async function changeNotice(agentId: string) {
  return mapRow<{ agentId: string; trigger: 'PERSONA' | 'POLICY' | 'MODEL'; changedAt: string; pending: boolean }>(await queryOne('SELECT * FROM agent_regression_changes WHERE agent_id=$1', [agentId]));
}
export async function pendingChanges() {
  return mapRows<{ agentId: string; trigger: 'PERSONA' | 'POLICY' | 'MODEL' }>(await query('SELECT * FROM agent_regression_changes WHERE pending=true'));
}
export async function acknowledgeChange(agentId: string, through: string) {
  // A save made after this run started still needs its own check.
  await query('UPDATE agent_regression_changes SET pending=false WHERE agent_id=$1 AND changed_at <= $2::timestamptz', [agentId, through]);
}
export async function runsToday(agentId: string): Promise<number> {
  const row = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM agent_regression_runs WHERE agent_id=$1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [agentId]);
  return Number(row?.n ?? 0);
}
