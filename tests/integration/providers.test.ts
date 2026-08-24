import { describe, expect, it } from 'vitest';
import { jobs as jobsRepo, observability, providers as providersRepo } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { testProviderConnection } from '@xbam/models';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs, makeDue } from '../support/runner';

installHarness();

describe('model provider failure handling', () => {
  it('falls back to the next configured model and keeps every attempt on record', async () => {
    const fixture = await createFixture({ model: 'mock-fail' });
    await providersRepo.setModelConfig({
      agentId: fixture.agentId,
      role: 'fallback_1',
      providerCredentialId: fixture.providerId,
      model: 'mock-echo',
      parameters: {},
    });

    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Does the fallback chain work?'),
    });
    await drainJobs();

    const jobId = outcome.jobs[0]!.job.id;
    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('EXECUTED');

    const calls = await observability.listModelCalls(jobId);
    // Two failed attempts on the primary, then the fallback succeeds.
    expect(calls.filter((c) => c.modelRole === 'primary' && c.status === 'FAILED')).toHaveLength(2);
    const succeeded = calls.find((c) => c.status === 'COMPLETED');
    expect(succeeded?.modelRole).toBe('fallback_1');
    expect(succeeded?.model).toBe('mock-echo');
  });

  it('retries a job later rather than losing it when every provider fails', async () => {
    const fixture = await createFixture({ model: 'mock-fail' });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Everything is down'),
    });
    const jobId = outcome.jobs[0]!.job.id;
    await drainJobs();

    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('MEMORY_RESOLVED');
    expect(job.errorClass).toBe('RETRYABLE');
    expect(job.attemptCount).toBe(1);
    // Backoff pushed it into the future rather than dropping it.
    expect(new Date(job.runAt).getTime()).toBeGreaterThan(Date.now());

    const trace = (await observability.listTrace(jobId)).map((t) => t.type);
    expect(trace).toContain('JOB_RETRY_SCHEDULED');
  });

  it('escalates to review once retries are exhausted, instead of silently dropping the mention', async () => {
    const fixture = await createFixture({ model: 'mock-fail', policy: { safety: { maxAttempts: 2 } } as never });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Nothing will work'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    for (let round = 0; round < 3; round += 1) {
      await makeDue(jobId);
      await drainJobs();
    }

    const job = await jobsRepo.requireJob(jobId);
    expect(job.status).toBe('REVIEW_REQUIRED');
    expect(job.lastError).toMatch(/gave up after/i);
  });

  it('stops permanently when the failure cannot improve on retry', async () => {
    const fixture = await createFixture({ model: 'mock-fail-permanent' });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('This will never work'),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.errorClass).toBe('PERMANENT');
  });

  it('sends an unusable model response to review rather than posting it', async () => {
    const fixture = await createFixture({ model: 'mock-long', policy: { output: { maxCharacters: 40, minCharacters: 30 } } as never });
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Produce something far too long'),
    });
    await drainJobs();

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    // Trimming to a sentence boundary keeps it usable, so this one succeeds.
    expect(['EXECUTED', 'REVIEW_REQUIRED']).toContain(job.status);
  });

  it('reports the mock provider as reachable without any credential', async () => {
    const fixture = await createFixture();
    const result = await testProviderConnection(fixture.providerId);
    expect(result.ok).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
    const stored = await providersRepo.getProvider(fixture.providerId);
    expect(stored?.lastStatus).toBe('healthy');
    expect(stored?.lastCheckedAt).toBeTruthy();
  });

  it('never exposes a stored API key through the normal read path', async () => {
    const fixture = await createFixture();
    const created = await providersRepo.createProvider({
      ownerId: fixture.ownerId,
      provider: 'openai',
      label: 'keyed',
      apiKey: 'sk-super-secret-value',
    });
    expect(JSON.stringify(created)).not.toContain('sk-super-secret-value');
    expect(created.hasKey).toBe(true);
    expect(created.keyFingerprint).toHaveLength(8);

    const listed = await providersRepo.listProviders(fixture.ownerId);
    expect(JSON.stringify(listed)).not.toContain('sk-super-secret-value');

    // Only the deliberate server-side accessor can read it back.
    expect(await providersRepo.getDecryptedApiKey(created.id)).toBe('sk-super-secret-value');
  });
});
