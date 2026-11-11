import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, agents, content, jobs, observability, query } from '@xbam/database';
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

async function post(summary: string) {
  const f = await createFixture();
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  const a = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'poster' });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: a.id, actionType: 'POST' });
  await content.addIdea({ agentId: f.agentId, summary, score: 90 });
  const result = await originatePost({ agentId: f.agentId, accountId: a.id });
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
  it('records an off decision without capturing or adding an artifact', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'false');
    const capture = vi.fn(async () => fixtureBytes('png'));
    Object.assign(mockAdapter, { capturePostMedia: capture });
    const f = await post('The release page shows the new review screen: https://example.test/releases/one');
    await drainAgentJobs(f.agentId);
    expect(await decision(f.jobId)).toMatchObject({ data: { chosen: false, reason: 'feature off' } });
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
    expect(await query("SELECT id FROM artifacts WHERE kind = 'POST_MEDIA' AND job_id = $1", [f.jobId])).toHaveLength(1);
  });

  it('records why a post without a URL needs no picture', async () => {
    vi.stubEnv('AI17Z_POST_MEDIA_ENABLED', 'true');
    const f = await post('Fees are a design choice, not a law of nature.');
    await drainAgentJobs(f.agentId);
    expect(await decision(f.jobId)).toMatchObject({ data: { chosen: false, reason: 'no URL to show' } });
  });
});
