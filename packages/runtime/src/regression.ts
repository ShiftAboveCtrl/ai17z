import { agents, events, jobs, providers, regression, withAdvisoryLock } from '@xbam/database';
import { BadRequestError, ConflictError, NotFoundError, PipelineError } from '@xbam/shared';
import { RegressionChecks, PolicyConfig, type DecisionDigest, type RegressionCandidate, type RegressionTrigger, type RegressionSubject } from '@xbam/shared/contracts';
import { explainRehearsal, rehearse, REHEARSAL_PATIENCE_MS, type RehearsalExplanation } from './rehearse';
import { judgeCase } from './testSuite';

export function digestOf(explanation: RehearsalExplanation, config: Pick<DecisionDigest, 'personaVersionId' | 'policyVersionId' | 'modelRoles'>): DecisionDigest {
  const stage = (key: string) => {
    const found = explanation.stages.find(s => s.key === key);
    return { outcome: found?.outcome ?? 'SKIPPED', detail: found?.detail ?? 'Did not run.' };
  };
  const decision = explanation.status === 'PERMANENT_FAILURE' || explanation.status === 'FAILED' ? 'FAILED'
    : explanation.status === 'REVIEW_REQUIRED' ? 'REVIEW'
    : explanation.silence || !explanation.answer ? 'SILENT' : 'ANSWERED';
  return { ...config, decision, silenceReason: explanation.silence, answer: explanation.answer, draft: explanation.draft,
    validator: stage('validator'), voice: stage('voice'), worth: stage('worth') };
}

function judged(digest: DecisionDigest, checks: RegressionChecks) {
  if (digest.decision === 'FAILED') return { verdict: 'FAILED' as const, reason: digest.silenceReason ?? 'The rehearsal failed.' };
  if (digest.decision === 'REVIEW') return { verdict: 'REVIEW' as const, reason: 'The rehearsal needs owner review.' };
  return judgeCase({ category: 'Saved case', checks }, { finished: true, answer: digest.answer, silence: digest.silenceReason ?? null,
    status: 'DRY_RUN_COMPLETED' });
}

/** Longest common subsequence of words, bounded by the explanation's draft limit. */
function wordDiff(a: string, b: string): { kind: 'same' | 'removed' | 'added'; text: string }[] {
  const left = a.split(/\s+/).filter(Boolean), right = b.split(/\s+/).filter(Boolean);
  const grid = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    grid[i]![j] = left[i] === right[j] ? grid[i + 1]![j + 1]! + 1 : Math.max(grid[i + 1]![j]!, grid[i]![j + 1]!);
  }
  const result: { kind: 'same' | 'removed' | 'added'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ kind: 'same', text: left[i++]! });
      j++;
    }
    else if (i < left.length && (j === right.length || grid[i + 1]![j]! >= grid[i]![j + 1]!)) result.push({ kind: 'removed', text: left[i++]! });
    else result.push({ kind: 'added', text: right[j++]! });
  }
  return result;
}

export function diffDigests(a: DecisionDigest, b: DecisionDigest, checks: RegressionChecks) {
  const before = judged(a, checks), after = judged(b, checks);
  const rank = { PASS: 0, SILENT: 0, REVIEW: 1, FAILED: 2, RUNNING: 3 };
  const validatorChanged = a.validator.outcome !== b.validator.outcome;
  const voiceChanged = a.voice.outcome !== b.voice.outcome;
  const decisionChanged = a.decision !== b.decision;
  const textChanged = a.draft !== b.draft || a.answer !== b.answer;
  const red = rank[after.verdict] > rank[before.verdict] || (checks.mustBeSilent && Boolean(b.answer?.trim())) ||
    (validatorChanged && b.validator.outcome === 'FAILED') || (a.decision !== 'FAILED' && b.decision === 'FAILED');
  const severity: 'REGRESSION' | 'CHANGED' | 'SAME' = red ? 'REGRESSION' : textChanged || decisionChanged || validatorChanged || voiceChanged ? 'CHANGED' : 'SAME';
  return { severity, decisionChange: decisionChanged ? `${a.decision} → ${b.decision}` : null, validatorChanged, voiceChanged,
    draft: wordDiff(a.draft ?? '', b.draft ?? ''), lengthDelta: (b.draft?.length ?? 0) - (a.draft?.length ?? 0),
    checks: { before, after }, beforePersonaVersionId: a.personaVersionId, afterPersonaVersionId: b.personaVersionId,
    beforePolicyVersionId: a.policyVersionId, afterPolicyVersionId: b.policyVersionId,
    textNote: textChanged ? 'Changed (a model rewrites differently every time).' : null };
}

async function digestForJob(jobId: string) {
  const job = await jobs.requireJob(jobId);
  if (!job.dryRun) throw PipelineError.permanent('regression_not_dry', 'A regression job must be a rehearsal.');
  const event = await events.getEvent(job.eventId);
  const modelRoles = (event?.payload.regressionModelRoles as DecisionDigest['modelRoles'] | undefined) ??
    (await providers.listModelConfigs(job.agentId)).map(({ role, model, providerCredentialId, parameters }) => ({ role, model, providerCredentialId, parameters }));
  return digestOf(await explainRehearsal(jobId), { personaVersionId: job.personaVersionId, policyVersionId: job.policyVersionId, modelRoles });
}

export async function saveRegressionCase(input: { agentId: string; jobId: string; title: string; checks: RegressionChecks; createdBy: string | null }) {
  const job = await jobs.requireJob(input.jobId);
  if (job.agentId !== input.agentId) throw new NotFoundError('Rehearsal');
  const explanation = await explainRehearsal(job.id);
  if (!job.dryRun || !explanation.finished) throw new BadRequestError('Wait for a completed rehearsal before saving it as a case.');
  const event = await events.getEvent(job.eventId);
  const subject = event?.payload.rehearsalSubject as RegressionSubject | undefined;
  if (!subject) throw new BadRequestError('This rehearsal has no subject snapshot. Rehearse it again to save it.');
  return regression.saveCase({ ...input, sourceJobId: job.id, subject, checks: RegressionChecks.parse(input.checks), baseline: await digestForJob(job.id) });
}

/** Queue only the next case. The existing worker sweep resumes persisted runs after a restart. */
export async function advanceRegression(runId: string): Promise<void> {
  await withAdvisoryLock(`regression:${runId}`, async () => {
    const run = await regression.getRun(runId);
    if (!run || run.finishedAt) return;
    for (const result of await regression.results(runId)) {
      if (result.digest || result.error) continue;
      if (result.jobId) {
        if (!await jobs.getJob(result.jobId)) {
          await regression.setResult(runId, result.caseId, { error: 'job_missing' });
          continue;
        }
        const explained = await explainRehearsal(result.jobId);
        if (!explained.finished) {
          const job = await jobs.requireJob(result.jobId);
          if (Date.now() - Date.parse(job.createdAt) < REHEARSAL_PATIENCE_MS) return;
          await jobs.updateJob(job.id, { status: 'CANCELLED', lastError: 'The regression rehearsal timed out.' });
          await regression.setResult(runId, result.caseId, { error: 'rehearsal_timeout' });
          continue;
        }
        await regression.setResult(runId, result.caseId, { digest: await digestForJob(result.jobId) });
        continue;
      }
      try {
        const saved = await regression.getCase(run.agentId, result.caseId);
        if (!saved) throw new NotFoundError('Case');
        // A saved real post is replayed locally from the exact text and thread snapshot.
        const queued = await rehearse({ agentId: run.agentId, candidate: run.candidate ?? undefined, replayOnMock: true,
          subject: { ...saved.subject, occurredAt: new Date().toISOString(), conversationRef: `regression_${runId}_${result.caseId}`,
            authorHandle: `tester_${result.caseId.replaceAll('-', '')}_${runId.slice(0, 8)}` } });
        const job = await jobs.requireJob(queued.jobId);
        if (!job.dryRun) throw PipelineError.permanent('regression_not_dry', 'A regression job must be a rehearsal.');
        await regression.setResult(runId, result.caseId, { jobId: job.id });
        return;
      } catch (error) {
        await regression.setResult(runId, result.caseId, { error: error instanceof PipelineError ? `${error.reason}: ${error.message}` : (error as Error).message });
      }
    }
    await regression.finishRun(runId);
  });
}

export async function runRegression(input: { agentId: string; trigger: RegressionTrigger; candidate?: RegressionCandidate; limit?: number }) {
  await agents.requireAgent(input.agentId);
  if (input.candidate && input.trigger !== 'PREVIEW') throw new BadRequestError('Candidates are only accepted for previews.');
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 40)) throw new BadRequestError('Choose between 1 and 40 cases.');
  const run = await regression.createRun(input).catch(error => {
    if ((error as { code?: string }).code === '23505') throw new ConflictError('This agent already has a regression run in progress.');
    throw error;
  });
  if (input.trigger !== 'PREVIEW') await regression.acknowledgeChange(input.agentId, run.createdAt);
  await advanceRegression(run.id);
  return (await regression.getRun(run.id))!;
}

export async function regressionRunView(id: string) {
  // Reading deliberately resumes persisted work, so an unfinished run can queue its next case.
  await advanceRegression(id);
  const run = await regression.getRun(id);
  if (!run) return null;
  return { ...run, results: (await regression.results(id)).map(r => ({ ...r, diff: r.digest ? diffDigests(r.baseline, r.digest, r.checks) : null })) };
}

export async function acceptRegressionBaseline(agentId: string, caseId: string, runId: string) {
  const run = await regression.getRun(runId);
  if (!run || run.agentId !== agentId || run.trigger === 'PREVIEW') throw new BadRequestError('Accept a completed saved-configuration run.');
  const result = (await regression.results(runId)).find(r => r.caseId === caseId);
  if (!result?.digest) throw new BadRequestError('That case has not finished.');
  return regression.editCase(agentId, caseId, { baseline: result.digest });
}

export async function sweepRegressions() {
  for (const run of await regression.activeRuns()) await advanceRegression(run.id);
  for (const change of await regression.pendingChanges()) {
    const agent = await agents.requireAgent(change.agentId);
    if (agent.state === 'PAUSED') continue;
    const policy = PolicyConfig.parse((await agents.getActivePolicy(agent.id))?.config ?? {});
    if (!policy.regression.autoRunOnChange) continue;
    await withAdvisoryLock(`regression-auto:${agent.id}`, async () => {
      if ((await regression.changeNotice(agent.id))?.pending && (await regression.runsToday(agent.id)) < policy.regression.maxRunsPerDay &&
          (await regression.listCases(agent.id)).length && !(await regression.listRuns(agent.id)).some(r => !r.finishedAt)) {
        await runRegression({ agentId: agent.id, trigger: change.trigger });
      }
    });
  }
}
