import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { accounts, capabilities, jobs, ops, query } from '@xbam/database';
import { DEFAULT_POLICY, type PolicyConfig } from '@xbam/shared/contracts';
import { sealSecret } from '@xbam/shared';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { holderMapBannedWord } from '@xbam/prompts';
import { HolderMapImageRequest } from '../../packages/runtime/src/studioEvidenceCardImage';
import type { HolderFundingRead } from '../../packages/runtime/src/solanaCapabilities';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { cardImageStudioServer } from '../support/cardImageStudioServer';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';

const mint = 'So11111111111111111111111111111111111111112';
const addr = (letter: string) => `${letter.repeat(43)}1`;
const FUNDED = (funder: string) => ({ state: 'read' as const, funder, funderIsProgram: false });

// No real RPC: the funding read is replaced, everything else in the module stays real.
const funding = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../packages/runtime/src/solanaCapabilities', async (original) => ({
  ...(await original<typeof import('../../packages/runtime/src/solanaCapabilities')>()),
  readHolderFunding: funding.read,
}));

function sampleRead(): HolderFundingRead {
  const readAt = new Date().toISOString();
  const w = (letter: string, pct: number, f: ReturnType<typeof FUNDED> | { state: 'unavailable'; reason: string } | undefined, kind: 'WALLET' | 'PROGRAM' = 'WALLET') =>
    ({ owner: addr(letter), tokenAccount: addr(letter.toLowerCase()), sharePct: pct, kind, funding: f, readAt });
  return { mint, readAt, source: 'solana_mainnet.test', holders: [
    w('A', 8.42, FUNDED(addr('X'))), w('B', 5.1, FUNDED(addr('Y'))), w('C', 3.2, FUNDED(addr('X'))),
    w('D', 2.8, { state: 'unavailable', reason: 'read failed' }), w('E', 2.1, undefined, 'PROGRAM'),
    { ...w('F', 1, FUNDED(addr('Z'))), sharePct: null },
  ] };
}

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
  funding.read.mockReset();
  funding.read.mockImplementation(async () => sampleRead());
  const u = await import('@xbam/upstream'); u.resetCacheForTest(); u.resetLimiterForTest(); u.resetBreakerForTest();
  const key = newInstallationKey();
  studio = await cardImageStudioServer(key);
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
});
afterEach(async () => { delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN; await studio.close(); });

async function fixture(on: { holderMap?: boolean; image?: boolean; maxCharacters?: number } = {}) {
  const tools = { ...DEFAULT_POLICY.tools, evidenceCards: true, evidenceCardImage: on.image ?? false, holderMap: on.holderMap ?? false } as PolicyConfig['tools'];
  const f = await createFixture({ policy: { tools, output: { ...DEFAULT_POLICY.output, maxCharacters: on.maxCharacters ?? 3000 } } });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'agent' });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  for (const grant of ['READ', 'GENERATE', 'REPLY'] as const) await capabilities.grant(f.agentId, account.id, grant);
  return { ...f, accountId: account.id };
}
async function ask(f: Awaited<ReturnType<typeof fixture>>, text = `@agent please check ${mint} and show the holder map`, dryRun = false) {
  const id = uniqueSuffix();
  const result = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId, dryRun,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: 'alice-7731',
      remoteAuthorHandle: 'alice', remoteAuthorDisplayName: 'Alice Example', remoteConversationId: id, parentRemoteMessageId: null,
      remoteUrl: `mock://${id}`, text, occurredAt: new Date().toISOString(), raw: {} } });
  await drainJobs();
  return jobs.requireJob(result.jobs[0]!.job.id);
}
async function sent(jobId: string) {
  const [row] = await query<{ verification: { evidence?: Record<string, unknown> }; payload: { text?: string } }>(
    'SELECT verification, payload FROM actions WHERE job_id=$1', [jobId]);
  return row!;
}
const media = (row: Awaited<ReturnType<typeof sent>>) => row.verification.evidence?.media as unknown[] | undefined;

it('is off by default: nothing is read, Studio is not asked and the reply is the plain card', async () => {
  const job = await ask(await fixture());
  expect(job.status).toBe('EXECUTED');
  expect(funding.read).not.toHaveBeenCalled();
  expect(studio.holderMapRequests()).toHaveLength(0);
  const row = await sent(job.id);
  expect(row.payload.text).not.toContain('Holder map');
  expect(media(row)).toBeUndefined();
});

it('reads nothing for an ordinary check, even with the switch on', async () => {
  const job = await ask(await fixture({ holderMap: true }), `@agent please check ${mint} for me`);
  expect(job.status).toBe('EXECUTED');
  expect(funding.read).not.toHaveBeenCalled();
  expect((await sent(job.id)).payload.text).not.toContain('Holder map');
});

it('answers a holder map ask with the text twin and one picture, sending only the frozen fields', async () => {
  const f = await fixture({ holderMap: true });
  const job = await ask(f);
  expect(job.status).toBe('EXECUTED');
  expect(funding.read).toHaveBeenCalledTimes(1);
  expect(funding.read).toHaveBeenCalledWith(mint);

  const row = await sent(job.id);
  const text = row.payload.text!;
  expect(text).toContain('Holder map, largest accounts read');
  expect(text).toContain('same first funding address as #3 (group A)');
  expect(text).toContain('funding unavailable');
  expect(text).toContain('Not read: 1 account, supply percent was not available.');
  expect(text).toContain('Same first funding address, read at ');
  expect(text).toContain('This is a reading, not proof of one owner.');
  expect(text).toContain('not a verdict, reads can be wrong');
  expect(holderMapBannedWord(text)).toBeNull();
  expect(text).not.toMatch(/alice/i);

  const requests = studio.holderMapRequests();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.valid).toBe(true);
  const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
  expect(HolderMapImageRequest.parse(body)).toEqual(body);
  for (const secret of ['alice', 'Alice Example', 'holder map', job.id, f.agentId, f.accountId, addr('X'), addr('Y')]) expect(requests[0]!.body).not.toContain(secret);
  // No card picture was asked for, so the only picture is the map.
  expect(studio.cardRequests()).toHaveLength(0);
  expect(media(row)).toEqual([expect.objectContaining({ kind: 'IMAGE', mime: 'image/png' })]);
});

it('keeps the text twin and sends no picture when Studio answers badly, is slow, or is not linked', async () => {
  for (const mode of ['html', 'svg', 'status500'] as const) {
    studio.state.mapMode = mode;
    const job = await ask(await fixture({ holderMap: true }));
    expect(job.status, mode).toBe('EXECUTED');
    const row = await sent(job.id);
    expect(media(row), mode).toBeUndefined();
    expect(row.payload.text, mode).toContain('Holder map, largest accounts read');
  }
  await ops.setSetting('studio.link', null);
  const job = await ask(await fixture({ holderMap: true }));
  expect(job.status).toBe('EXECUTED');
  const row = await sent(job.id);
  expect(media(row)).toBeUndefined();
  expect(row.payload.text).toContain('This is a reading, not proof of one owner.');
});

it('asks nobody for a dry run, but still shows the twin', async () => {
  const job = await ask(await fixture({ holderMap: true }), undefined, true);
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  expect(studio.holderMapRequests()).toHaveLength(0);
});

it('attaches both pictures, the card first, when both owner switches are on', async () => {
  const job = await ask(await fixture({ holderMap: true, image: true }));
  expect(job.status).toBe('EXECUTED');
  expect(studio.cardRequests()).toHaveLength(1);
  expect(studio.holderMapRequests()).toHaveLength(1);
  expect(media(await sent(job.id))).toHaveLength(2);
});

it('says the holder map was not read, and sends no picture, when the holder list cannot be read', async () => {
  funding.read.mockRejectedValue(new Error('cluster down'));
  const job = await ask(await fixture({ holderMap: true }));
  expect(job.status).toBe('EXECUTED');
  const row = await sent(job.id);
  expect(row.payload.text).toContain('Holder map: not read, the holder read did not complete.');
  expect(row.payload.text).not.toContain('Holder map, largest');
  expect(studio.holderMapRequests()).toHaveLength(0);
  expect(media(row)).toBeUndefined();
});

it('falls back to the compact line when the full twin does not fit, and leaves the map off when nothing fits', async () => {
  const plain = await sent((await ask(await fixture(), `@agent please check ${mint} for me`)).id);
  const base = plain.payload.text!.length;
  const compact = await sent((await ask(await fixture({ holderMap: true, maxCharacters: base + 330 }))).id);
  expect(compact.payload.text).toContain('Holder map: 5 accounts read, 1 group sharing a first funding address');
  expect(compact.payload.text).not.toContain('Holder map, largest accounts read');
  const none = await ask(await fixture({ holderMap: true, maxCharacters: base + 20 }));
  const left = await sent(none.id);
  expect(left.payload.text).not.toContain('Holder map');
  expect(studio.holderMapRequests().length).toBeLessThanOrEqual(1);
});
