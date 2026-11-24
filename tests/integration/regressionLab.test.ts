import { afterEach, expect, it, vi } from 'vitest';
import { agents, jobs, query, regression, events } from '@xbam/database';
import { PersonaDraft, PolicyConfig } from '@xbam/shared/contracts';
import * as runtime from '@xbam/runtime';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import * as rehearsals from '../../packages/runtime/src/rehearse';
import { mockAdapter } from '../../packages/models/src/providers/mock';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs, runOne } from '../support/runner';

installHarness();
afterEach(() => vi.restoreAllMocks());

it('fails a tampered live candidate permanently without executing an action', async () => {
  const f = await createFixture();
  const persona = (await agents.getActivePersona(f.agentId))!;
  const run = await runtime.rehearse({ agentId: f.agentId, candidate: { persona: PersonaDraft.parse({ ...persona, tone: 'Unsaved' }) }, subject: { channel: 'mock', authorHandle: 'tester', text: 'How does this work?' } });
  await query('UPDATE jobs SET dry_run=false WHERE id=$1', [run.jobId]);
  const job = await runOne(run.jobId);
  expect(job.status).toBe('PERMANENT_FAILURE');
  expect(job.errorClass).toBe('PERMANENT');
  expect(job.lastError).toMatch(/candidate configuration/);
  expect(await query('SELECT id FROM actions WHERE job_id=$1', [job.id])).toHaveLength(0);
});

it('spends nothing on changes by default and caps explicitly enabled automatic runs', async () => {
  const f = await savedCase();
  await regression.noteChange(f.agentId, 'PERSONA');
  await runtime.sweepRegressions();
  expect(await regression.listRuns(f.agentId)).toHaveLength(0);
  const policy = (await agents.getActivePolicy(f.agentId))!;
  await agents.savePolicyVersion(f.agentId, PolicyConfig.parse({ ...policy.config, regression: { autoRunOnChange: true, maxRunsPerDay: 1 } }), 'Enable regression checks', f.ownerId);
  await runtime.sweepRegressions();
  expect(await regression.listRuns(f.agentId)).toHaveLength(1);
  await drainJobs();
  await runtime.sweepRegressions();
  await regression.noteChange(f.agentId, 'POLICY');
  await runtime.sweepRegressions();
  expect(await regression.listRuns(f.agentId)).toHaveLength(1);
  expect((await regression.changeNotice(f.agentId))!.pending).toBe(true);
});

it('replays a real-post snapshot locally and queues only one case at a time', async () => {
  const f = await savedCase();
  await regression.saveCase({ agentId: f.agentId, title: 'Snapshot', subject: { ...f.c.subject, channel: 'x', remoteId: '1234', parentText: 'The parent as read', gaps: ['Image unreadable'], occurredAt: '2020-01-01T00:00:00.000Z' }, sourceJobId: f.c.sourceJobId!, baseline: f.c.baseline, checks: {}, createdBy: f.ownerId });
  const queued = vi.spyOn(rehearsals, 'rehearse');
  const run = await runtime.runRegression({ agentId: f.agentId, trigger: 'MANUAL' });
  let results = await regression.results(run.id);
  expect(results.filter(r => r.jobId)).toHaveLength(1);
  expect(queued).toHaveBeenCalledTimes(1);
  await runtime.advanceRegression(run.id);
  expect((await regression.results(run.id)).filter(r => r.jobId)).toHaveLength(1);
  expect(queued).toHaveBeenCalledTimes(1);
  await drainJobs();
  await runtime.advanceRegression(run.id);
  results = await regression.results(run.id);
  expect(results.filter(r => r.jobId)).toHaveLength(2);
  expect(queued).toHaveBeenCalledTimes(2);
  const snapshot = results.find(r => r.title === 'Snapshot')!;
  const job = await jobs.requireJob(snapshot.jobId!);
  const event = (await events.getEvent(job.eventId))!;
  expect(job.channel).toBe('mock');
  expect(job.dryRun).toBe(true);
  expect(job.requiresBrowser).toBe(false);
  expect(event.payload.parentText).toBe('The parent as read');
  expect(event.payload.readerGaps).toEqual(['Image unreadable']);
  await drainJobs();
  const view = (await runtime.regressionRunView(run.id))!;
  expect(view.finishedAt).not.toBeNull();
  expect(view.results.every(r => r.digest)).toBe(true);
  const baseline = view.results[0]!.baseline;
  await runtime.acceptRegressionBaseline(f.agentId, view.results[0]!.caseId, run.id);
  expect((await runtime.regressionRunView(run.id))!.results[0]!.baseline).toEqual(baseline);
});

it('previews a policy decision without changing either active version', async () => {
  const f = await createFixture();
  const persona = (await agents.getActivePersona(f.agentId))!;
  const policy = (await agents.getActivePolicy(f.agentId))!;
  const original = await runtime.rehearse({ agentId: f.agentId, subject: { channel: 'mock', authorHandle: 'reader', text: 'Testing software catches mistakes.' } });
  await drainJobs();
  await runtime.saveRegressionCase({ agentId: f.agentId, jobId: original.jobId, title: 'Statement', checks: {}, createdBy: f.ownerId });
  const before = await query('SELECT (SELECT count(*) FROM persona_versions) AS personas, (SELECT count(*) FROM policy_versions) AS policies');
  const run = await runtime.runRegression({ agentId: f.agentId, trigger: 'PREVIEW', candidate: { persona: PersonaDraft.parse({ ...persona, prohibitedBehaviors: ['Do not answer statements about software'] }), policy: PolicyConfig.parse({ ...policy.config, engagement: { ...policy.config.engagement, strategy: 'QUESTIONS_ONLY' } }) } });
  await drainJobs();
  const view = (await runtime.regressionRunView(run.id))!;
  expect(view.results[0]!.baseline.decision).toBe('ANSWERED');
  expect(view.results[0]!.digest!.decision).toBe('SILENT');
  expect((await agents.requireAgent(f.agentId)).personaVersionId).toBe(persona.id);
  expect((await agents.requireAgent(f.agentId)).policyVersionId).toBe(policy.id);
  expect(await query('SELECT (SELECT count(*) FROM persona_versions) AS personas, (SELECT count(*) FROM policy_versions) AS policies')).toEqual(before);
});

async function savedCase() {
  const f = await createFixture();
  const rehearsal = await runtime.rehearse({ agentId: f.agentId, subject: { channel: 'mock', authorHandle: 'reader', text: 'What is a useful way to test software?' } });
  await drainJobs();
  const c = await runtime.saveRegressionCase({ agentId: f.agentId, jobId: rehearsal.jobId, title: 'Software question', createdBy: f.ownerId, checks: {} });
  return { ...f, c };
}

it('saves a snapshot and compares a later persona with both version ids without publishing', async () => {
  expect(runtime).toHaveProperty('saveRegressionCase');
  const generate = mockAdapter.generate;
  vi.spyOn(mockAdapter, 'generate').mockImplementation(async request => {
    const response = await generate(request);
    return request.messages.some(message => message.content.includes('Dry and factual'))
      ? { ...response, text: 'The test starts with a clear assertion.' } : response;
  });
  const f = await savedCase();
  const persona = (await agents.getActivePersona(f.agentId))!;
  const next = await agents.savePersonaVersion(f.agentId, PersonaDraft.parse({ ...persona, tone: 'Dry and factual' }), f.ownerId);
  const run = await runtime.runRegression({ agentId: f.agentId, trigger: 'PERSONA' });
  await drainJobs();
  const view = (await runtime.regressionRunView(run.id))!;
  expect(view.finishedAt).not.toBeNull();
  expect(view.results[0]!.baseline.personaVersionId).toBe(persona.id);
  expect(view.results[0]!.digest!.personaVersionId).toBe(next.id);
  expect(view.results[0]!.diff).not.toBeNull();
  expect(view.results[0]!.diff!.severity).toBe('CHANGED');
  const records = await regression.results(run.id);
  for (const result of records) expect((await jobs.requireJob(result.jobId!)).dryRun).toBe(true);
  expect(await query("SELECT id FROM actions WHERE status='EXECUTED'")).toHaveLength(0);
});

it('previews an unsaved configuration across context resolution without writing versions', async () => {
  const f = await createFixture();
  const before = (await agents.getActivePersona(f.agentId))!;
  const counts = await query('SELECT count(*) AS n FROM persona_versions');
  const candidate = { persona: PersonaDraft.parse({ ...before, tone: 'Never discuss software' }), policy: PolicyConfig.parse({ content: { blockedTopics: ['software'] } }) };
  const rehearsal = await runtime.rehearse({ agentId: f.agentId, candidate, subject: { channel: 'mock', authorHandle: 'tester', text: 'What is software?' } });
  const job = await jobs.requireJob(rehearsal.jobId);
  expect((await loadJobBundle(job)).persona.tone).toBe('Never discuss software');
  await drainJobs();
  expect((await jobs.requireJob(job.id)).resolvedContext?.meta.candidate).toEqual(candidate);
  expect((await jobs.requireJob(job.id)).contextResolvedAt).not.toBeNull();
  expect((await agents.getActivePersona(f.agentId))!.id).toBe(before.id);
  expect(await query('SELECT count(*) AS n FROM persona_versions')).toEqual(counts);
});

it('keeps a paused run as a failure with agent_paused and enforces case caps', async () => {
  const f = await savedCase();
  for (let i = 1; i < 40; i++) await regression.saveCase({ agentId: f.agentId, title: `Case ${i}`, subject: f.c.subject, sourceJobId: f.c.sourceJobId!, baseline: f.c.baseline, checks: {}, createdBy: f.ownerId });
  await expect(regression.saveCase({ agentId: f.agentId, title: 'Overflow', subject: f.c.subject, sourceJobId: f.c.sourceJobId!, baseline: f.c.baseline, checks: {}, createdBy: f.ownerId })).rejects.toThrow(/40/);
  await agents.updateAgent(f.agentId, { state: 'PAUSED' });
  const run = await runtime.runRegression({ agentId: f.agentId, trigger: 'MANUAL' });
  const view = (await runtime.regressionRunView(run.id))!;
  expect(view.results).toHaveLength(12);
  expect(view.results.every(r => r.error?.includes('agent_paused'))).toBe(true);
});
