import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { accounts, capabilities, jobs, ops, query } from '@xbam/database';
import { DEFAULT_POLICY, type PolicyConfig } from '@xbam/shared/contracts';
import { sealSecret } from '@xbam/shared';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { EvidenceCardImageRequest } from '../../packages/runtime/src/studioEvidenceCardImage';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { cardImageStudioServer } from '../support/cardImageStudioServer';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';

const mint = 'So11111111111111111111111111111111111111112';
vi.mock('undici', () => ({
  Agent: class { async close() {} },
  fetch: async (input: unknown, init?: RequestInit) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) {
      const local = { ...init } as RequestInit & { dispatcher?: unknown };
      delete local.dispatcher;
      return globalThis.fetch(String(input), local);
    }
    if (!String(input).includes('jup.ag')) throw new Error('Unexpected network host');
    const queried = new URL(String(input)).searchParams.get('query') ?? mint;
    return new Response(JSON.stringify([{ id: queried, liquidity: 12000, updatedAt: new Date().toISOString(),
      firstPool: { createdAt: new Date(Date.now() - 3600_000).toISOString() },
      audit: { topHoldersPercentage: 20, mintAuthorityDisabled: true, freezeAuthorityDisabled: false } }]), { status: 200 });
  },
}));

let studio: Awaited<ReturnType<typeof cardImageStudioServer>>;
beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => {
  await truncateAll(); await seedCatalogue();
  const u = await import('@xbam/upstream'); u.resetCacheForTest(); u.resetLimiterForTest(); u.resetBreakerForTest();
  const key = newInstallationKey();
  studio = await cardImageStudioServer(key);
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
});
afterEach(async () => { delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN; await studio.close(); });

async function fixture(image: boolean) {
  const tools = { ...DEFAULT_POLICY.tools, evidenceCards: true, evidenceCardImage: image } as PolicyConfig['tools'];
  const f = await createFixture({ policy: { tools, output: { ...DEFAULT_POLICY.output, maxCharacters: 2000 } } });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'agent' });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  for (const grant of ['READ', 'GENERATE', 'REPLY'] as const) await capabilities.grant(f.agentId, account.id, grant);
  return { ...f, accountId: account.id };
}
async function ask(f: Awaited<ReturnType<typeof fixture>>, dryRun = false) {
  const id = uniqueSuffix();
  const result = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId, dryRun,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: 'alice-7731',
      remoteAuthorHandle: 'alice', remoteAuthorDisplayName: 'Alice Example', remoteConversationId: id, parentRemoteMessageId: null,
      remoteUrl: `mock://${id}`, text: `@agent please check ${mint} for me`, occurredAt: new Date().toISOString(), raw: {} } });
  await drainJobs();
  return jobs.requireJob(result.jobs[0]!.job.id);
}
async function sentEvidence(jobId: string) {
  const [row] = await query<{ verification: { evidence?: Record<string, unknown> }; payload: { text?: string } }>(
    'SELECT verification, payload FROM actions WHERE job_id=$1', [jobId]);
  return row!;
}
const plain = (text: string | undefined) => text?.replace(/fetched [^\]]+/g, '').replace(/\/watch [0-9a-f]+/g, '/watch X');
const pictures = (agentId: string) => query("SELECT id FROM artifacts WHERE kind='POST_MEDIA' AND agent_id=$1", [agentId]);

it('is off by default: Studio is never asked and the reply is the text card', async () => {
  const f = await fixture(false);
  const job = await ask(f);
  expect(job.status).toBe('EXECUTED');
  expect(studio.imageRequests()).toHaveLength(0);
  expect((await sentEvidence(job.id)).verification.evidence?.media).toBeUndefined();
  expect(await pictures(f.agentId)).toHaveLength(0);
});

it('attaches the Studio picture through the media path and sends only the frozen card fields', async () => {
  const f = await fixture(true);
  const job = await ask(f);
  expect(job.status).toBe('EXECUTED');
  const requests = studio.imageRequests();
  expect(requests).toHaveLength(1);
  expect(requests.every(r => r.valid)).toBe(true);
  const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
  expect(EvidenceCardImageRequest.parse(body)).toEqual(body);
  // Nothing about the asker, the post or this installation's own records.
  for (const secret of ['alice', 'Alice Example', 'please check', job.id, f.agentId, f.accountId]) expect(requests[0]!.body).not.toContain(secret);
  const sent = await sentEvidence(job.id);
  expect(sent.verification.evidence?.media).toEqual([expect.objectContaining({ kind: 'IMAGE', mime: 'image/png' })]);
  expect(sent.verification.evidence?.mediaConfirmed).toBe(true);
  expect(sent.payload.text).toContain('Liquidity: 12000 USD');
  expect(sent.payload.text).toContain('not a verdict, reads can be wrong');
  expect(await pictures(f.agentId)).toHaveLength(1);
});

it('sends the text card unchanged when Studio answers badly, is slow, or is not linked', async () => {
  const baseline = (await sentEvidence((await ask(await fixture(false))).id)).payload.text;
  for (const mode of ['html', 'svg', 'status500'] as const) {
    studio.state.mode = mode;
    const f = await fixture(true);
    const job = await ask(f);
    expect(job.status, mode).toBe('EXECUTED');
    const sent = await sentEvidence(job.id);
    expect(sent.verification.evidence?.media, mode).toBeUndefined();
    // Fetch times and the job id in the owner line differ per run; everything else is the same card.
    expect(plain(sent.payload.text)).toBe(plain(baseline));
    expect(await pictures(f.agentId), mode).toHaveLength(0);
  }
  await ops.setSetting('studio.link', null);
  const unlinked = await fixture(true);
  const job = await ask(unlinked);
  expect(job.status).toBe('EXECUTED');
  expect((await sentEvidence(job.id)).verification.evidence?.media).toBeUndefined();
});

it('gives up on a slow Studio within the bounded deadline and replies with text', async () => {
  studio.state.mode = 'slow';
  const f = await fixture(true);
  const started = Date.now();
  const job = await ask(f);
  expect(Date.now() - started).toBeLessThan(14_000);
  expect(job.status).toBe('EXECUTED');
  expect((await sentEvidence(job.id)).verification.evidence?.media).toBeUndefined();
  expect(await pictures(f.agentId)).toHaveLength(0);
}, 30_000);

it('asks nobody for a dry run', async () => {
  const f = await fixture(true);
  const job = await ask(f, true);
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  expect(studio.imageRequests()).toHaveLength(0);
});
