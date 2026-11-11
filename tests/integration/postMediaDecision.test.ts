import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, agents, content, jobs, observability, query } from '@xbam/database';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { mockAdapter } from '@xbam/channels';
import { originatePost } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';
import { fixtureBytes } from '../support/imageFixtures';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepGenerate, stepResolveContext } from '../../packages/runtime/src/steps';
import * as mediaDecision from '../../packages/runtime/src/postMediaDecision';

installHarness();
let storage: string;
let previousStorage: string | undefined;
beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'post-media-decision-'));
  previousStorage = process.env.AI17Z_STORAGE_DIR;
  process.env.AI17Z_STORAGE_DIR = storage;
});
afterAll(async () => {
  if (previousStorage === undefined) delete process.env.AI17Z_STORAGE_DIR;
  else process.env.AI17Z_STORAGE_DIR = previousStorage;
  await rm(storage, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); delete (mockAdapter as { capturePostMedia?: unknown }).capturePostMedia; });

async function post(summary: string, allowed = true, source = 'manual', dryRun = false) {
  const f = await createFixture({ policy: { media: { ...DEFAULT_POLICY.media, allowedCaptureHosts: allowed ? ['example.test'] : [] } } });
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  const a = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'poster' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: a.id, actionType: 'POST' });
  await content.addIdea({ agentId: f.agentId, summary, score: 90, source });
  const result = await originatePost({ agentId: f.agentId, accountId: a.id, dryRun });
  expect(result.jobId).toBeTruthy();
  return { ...f, jobId: result.jobId! };
}

async function decision(jobId: string) {
  const trace = await observability.listTrace(jobId);
  return trace.find(t => t.data.phase === 'post_media');
}

describe('media for original posts on the mock channel', () => {
  it('keeps the prompt, output, context and event byte-identical to the old path when off', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'false');
    const f = await post('The release page shows the new review screen: https://example.test/releases/one');
    await stepResolveContext(await loadJobBundle(await jobs.requireJob(f.jobId)));
    const bundle = await loadJobBundle(await jobs.requireJob(f.jobId));
    const input = JSON.stringify({ context: bundle.job.resolvedContext, event: bundle.event });
    // The old path is the same generation function with the newly added seam absent.
    const seam = vi.spyOn(mediaDecision, 'preparePostMedia').mockResolvedValueOnce(undefined);
    await stepGenerate(bundle);
    const baseline = await jobs.requireJob(f.jobId);
    const baselineCalls = await observability.listModelCalls(f.jobId);
    expect(baselineCalls.length).toBeGreaterThan(0);
    expect(baselineCalls.every(c => typeof c.promptText === 'string' && c.promptText.length > 0)).toBe(true);
    seam.mockRestore();
    await stepGenerate(bundle);
    const current = await jobs.requireJob(f.jobId);
    const calls = await observability.listModelCalls(f.jobId);
    expect(Buffer.from(current.generatedOutput!)).toEqual(Buffer.from(baseline.generatedOutput!));
    expect(calls.slice(baselineCalls.length).map(c => c.promptText)).toEqual(baselineCalls.map(c => c.promptText));
    expect(JSON.stringify({ context: bundle.job.resolvedContext, event: bundle.event })).toBe(input);
    expect(current.resolvedContext).toEqual(baseline.resolvedContext);
  });
  it('regression: persists the off decision without traces or capture, including retries after enablement', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'false');
    const capture = vi.fn(async () => fixtureBytes('png'));
    Object.assign(mockAdapter, { capturePostMedia: capture });
    const f = await post('The release page shows the new review screen: https://example.test/releases/one');
    await drainAgentJobs(f.agentId);
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    await mediaDecision.preparePostMedia(await loadJobBundle(await jobs.requireJob(f.jobId)));
    expect(await decision(f.jobId)).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    expect(await query("SELECT id FROM artifacts WHERE kind = 'POST_MEDIA' AND agent_id = $1", [f.agentId])).toHaveLength(0);
  });

  it('chooses a live release screenshot and sends its bytes through POST_MEDIA', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    const png = fixtureBytes('png');
    const capture = vi.fn(async () => png);
    Object.assign(mockAdapter, { capturePostMedia: capture });
    const real = mockAdapter.executeAction.bind(mockAdapter);
    const sent = vi.spyOn(mockAdapter, 'executeAction').mockImplementation(real);
    const f = await post('The release page shows the new review screen: https://example.test/releases/one');
    await drainAgentJobs(f.agentId);
    expect(await decision(f.jobId)).toMatchObject({ data: { chosen: true, reason: 'release page screenshot' } });
    const job = await jobs.requireJob(f.jobId);
    expect(job.status, job.lastError ?? '').toBe('EXECUTED');
    expect(sent.mock.calls[0]?.[1].media).toEqual([expect.objectContaining({ mime: 'image/png', bytes: png.length })]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await observability.listTrace(f.jobId)).filter(t => t.type === 'POST_MEDIA_DECIDED')).toHaveLength(1);
    expect(await query("SELECT id FROM artifacts WHERE kind = 'POST_MEDIA' AND job_id = $1", [f.jobId])).toHaveLength(1);
  });

  it('regression: persists a negative decision once across reloads and retries', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    const f = await post('The release page: https://example.test/releases/one', false);
    await drainAgentJobs(f.agentId);
    await mediaDecision.preparePostMedia(await loadJobBundle(await jobs.requireJob(f.jobId)));
    const traces = (await observability.listTrace(f.jobId)).filter(t => t.type === 'POST_MEDIA_DECIDED');
    expect(traces).toHaveLength(1);
    expect(traces[0]?.data.reason).toContain('owner capture host allowlist');
  });

  it.each(['conversation', 'model', 'research'])('regression: never captures URLs from %s ideas or generated text', async source => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    const capture = vi.fn(async () => fixtureBytes('png'));
    Object.assign(mockAdapter, { capturePostMedia: capture });
    const f = await post('The release page: https://example.test/releases/one', true, source);
    await stepResolveContext(await loadJobBundle(await jobs.requireJob(f.jobId)));
    const bundle = await loadJobBundle(await jobs.requireJob(f.jobId));
    bundle.job.generatedOutput = 'https://example.test/model';
    await mediaDecision.preparePostMedia(bundle);
    expect(capture).not.toHaveBeenCalled();
  });

  it('records why a post without a URL needs no picture', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    const f = await post('Fees are a design choice, not a law of nature.');
    await drainAgentJobs(f.agentId);
    expect(await decision(f.jobId)).toMatchObject({ data: { chosen: false, reason: 'no URL to show' } });
  });

  it('regression: a dry run captures once but never publishes', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    const capture = vi.fn(async () => fixtureBytes('png'));
    Object.assign(mockAdapter, { capturePostMedia: capture });
    const sent = vi.spyOn(mockAdapter, 'executeAction');
    const f = await post('The release page: https://example.test/releases/one', true, 'manual', true);
    await drainAgentJobs(f.agentId);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls.every(([, request]) => request.dryRun)).toBe(true);
    expect((await jobs.requireJob(f.jobId)).status).toBe('DRY_RUN_COMPLETED');
  });

  it('regression: concurrent stale bundles capture and trace only once', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    const capture = vi.fn(async () => fixtureBytes('png'));
    Object.assign(mockAdapter, { capturePostMedia: capture });
    const f = await post('The release page: https://example.test/releases/one');
    await stepResolveContext(await loadJobBundle(await jobs.requireJob(f.jobId)));
    const a = await loadJobBundle(await jobs.requireJob(f.jobId));
    const b = await loadJobBundle(await jobs.requireJob(f.jobId));
    await Promise.all([mediaDecision.preparePostMedia(a), mediaDecision.preparePostMedia(b)]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(mediaDecision.decidedPostMedia(b)).toHaveLength(1);
    expect((await observability.listTrace(f.jobId)).filter(t => t.type === 'POST_MEDIA_DECIDED')).toHaveLength(1);
  });
});
