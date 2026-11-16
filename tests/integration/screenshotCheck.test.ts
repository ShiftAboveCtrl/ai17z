import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { accounts, capabilities, jobs, providers, query } from '@xbam/database';
import { DEFAULT_POLICY, type PolicyConfig } from '@xbam/shared/contracts';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';
import { IMAGE_FIXTURES } from '../support/imageFixtures';

/**
 * "Check from a screenshot": the address is read out of a picture with the
 * vision role, echoed back, and then the ordinary card runs. The mock model
 * named `mock-fixed:<text>` is the vision model, so the "OCR" is exactly what
 * each case says it is and nothing here touches a network or the X adapter.
 */
const mint = 'So11111111111111111111111111111111111111112';
const mint2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const evm = '0x1111111111111111111111111111111111111111';
const picture = { kind: 'image', sourceUrl: `data:image/png;base64,${IMAGE_FIXTURES.png}` };
let jupiterReads = 0;

vi.mock('undici', () => ({
  Agent: class { async close() {} },
  fetch: async (input: unknown, init?: RequestInit) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) {
      const local = { ...init } as RequestInit & { dispatcher?: unknown };
      delete local.dispatcher;
      return globalThis.fetch(String(input), local);
    }
    if (!String(input).includes('jup.ag')) throw new Error('Unexpected network host');
    jupiterReads++;
    const queried = new URL(String(input)).searchParams.get('query') ?? mint;
    return new Response(JSON.stringify([{ id: queried, liquidity: 12000, updatedAt: new Date().toISOString(),
      firstPool: { createdAt: new Date(Date.now() - 3600_000).toISOString() },
      audit: { topHoldersPercentage: 20, mintAuthorityDisabled: true, freezeAuthorityDisabled: false } }]), { status: 200 });
  },
}));

beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => {
  await truncateAll(); await seedCatalogue(); jupiterReads = 0;
  const u = await import('@xbam/upstream'); u.resetCacheForTest(); u.resetLimiterForTest(); u.resetBreakerForTest();
});

/** `ocr` is what the vision model "reads"; undefined configures no vision model at all. */
async function fixture(ocr: string | undefined, policy: Partial<PolicyConfig> = {}) {
  const f = await createFixture({ policy: { tools: { ...DEFAULT_POLICY.tools, evidenceCards: true } as typeof DEFAULT_POLICY.tools,
    output: { ...DEFAULT_POLICY.output, maxCharacters: 2000 }, ...policy } });
  if (ocr !== undefined) {
    await providers.setModelConfig({ agentId: f.agentId, role: 'vision', providerCredentialId: f.providerId,
      model: `mock-fixed:${ocr}`, parameters: {} });
  }
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'agent' });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  for (const grant of ['READ', 'GENERATE', 'REPLY'] as const) await capabilities.grant(f.agentId, account.id, grant);
  return { ...f, accountId: account.id };
}

async function ask(f: Awaited<ReturnType<typeof fixture>>, text: string,
  raw: Record<string, unknown> = { inventory: { media: [picture] } }, author = 'alice') {
  const id = uniqueSuffix();
  const result = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId, dryRun: true,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: author,
      remoteAuthorHandle: author, remoteAuthorDisplayName: author, remoteConversationId: id, parentRemoteMessageId: null,
      remoteUrl: `mock://${id}`, text, occurredAt: new Date().toISOString(), raw } });
  await drainJobs();
  return jobs.requireJob(result.jobs[0]!.job.id);
}
const visionCalls = async (jobId: string) =>
  (await query<{ n: number }>(`SELECT count(*)::int AS n FROM model_calls WHERE job_id=$1 AND purpose='media.read_address'`, [jobId]))[0]!.n;

it('checks the address read from a screenshot and says where it read it from', async () => {
  const f = await fixture(`ADDRESS: ${mint}`);
  const job = await ask(f, '@agent check this');
  expect(job.lastError).toBeNull();
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  expect(job.validatedOutput!.split('\n')[0]).toBe(`read from your image: ${mint}`);
  expect(job.validatedOutput).toContain('Liquidity: 12000 USD');
  expect(job.validatedOutput).toContain('not a verdict, reads can be wrong');
  expect(jupiterReads).toBe(1);
  expect(await visionCalls(job.id)).toBe(1);
});

it('reads the picture on the post above when the mention carries none', async () => {
  const f = await fixture(`ADDRESS: ${mint}`);
  const job = await ask(f, '@agent check this token', { parentText: 'new gem', parentInventory: { media: [picture] } });
  expect(job.validatedOutput!.split('\n')[0]).toBe(`read from the image above: ${mint}`);
  expect(job.validatedOutput).toContain('Liquidity: 12000 USD');
});

it('uses a base chain named in the words with an address read from the picture', async () => {
  const f = await fixture(`ADDRESS: ${evm}`);
  expect((await ask(f, '@agent check this')).validatedOutput).toMatch(/^Please .*chain/);
  const based = await ask(f, '@agent check this token on base');
  expect(based.validatedOutput!.split('\n')[0]).toBe(`read from your image: ${evm}`);
});

it('refuses two addresses in one image and checks neither', async () => {
  const f = await fixture(`ADDRESS: ${mint}\nADDRESS: ${mint2}`);
  const job = await ask(f, '@agent check this token');
  expect(job.validatedOutput).toMatch(/more than one address in your image/);
  expect(job.validatedOutput).not.toContain('Liquidity');
  expect(jupiterReads).toBe(0);
});

it('never guesses or fixes a misread, a shortened address or an address that fails the strict shape', async () => {
  for (const ocr of [`ADDRESS: ${mint.slice(0, 20)}`, `PARTIAL: ${mint.slice(0, 4)}...${mint.slice(-4)}`,
    `ADDRESS: ${mint}0`, 'ADDRESS: 0x12345', `ADDRESS: ${mint.replace('S', '0')}`]) {
    const job = await ask(await fixture(ocr), '@agent check this token');
    expect(job.validatedOutput).toMatch(/shortened or unclear address|could not find/);
    expect(job.validatedOutput).not.toContain('Liquidity');
    expect(job.validatedOutput).not.toContain('read from your image');
  }
  expect(jupiterReads).toBe(0);
});

it('accepts a shortened copy printed beside the same full address, but not beside a different one', async () => {
  const same = await ask(await fixture(`ADDRESS: ${mint}\nPARTIAL: ${mint.slice(0, 4)}...${mint.slice(-4)}`), '@agent check this');
  expect(same.validatedOutput).toContain(`read from your image: ${mint}`);
  const other = await ask(await fixture(`ADDRESS: ${mint}\nPARTIAL: ${mint2.slice(0, 4)}...${mint2.slice(-4)}`), '@agent check this');
  expect(other.validatedOutput).toMatch(/one address or two/);
});

it('states an unreadable picture as a gap for a token ask, and leaves a loose "check this" alone', async () => {
  const none = await ask(await fixture(undefined), '@agent check this token');
  expect(none.validatedOutput).toMatch(/could not read your image because this agent has no vision model/);
  expect(none.validatedOutput).not.toContain('Liquidity');
  const off = await fixture(`ADDRESS: ${mint}`, { media: { ...DEFAULT_POLICY.media, analyzeImages: false } });
  expect((await ask(off, '@agent check this token')).validatedOutput).toMatch(/image reading is turned off/);
  const loose = await ask(await fixture(undefined), '@agent check this');
  expect(loose.validatedOutput ?? '').not.toContain('Token evidence');
  const noAddress = await ask(await fixture('NONE'), '@agent check this');
  expect(noAddress.validatedOutput ?? '').not.toContain('Liquidity');
});

it('keeps the text of the ask in charge: an address in the words is never read from the picture', async () => {
  const f = await fixture(`ADDRESS: ${mint2}`);
  const job = await ask(f, `@agent check ${mint}`);
  expect(job.validatedOutput).toContain('Liquidity');
  expect(job.validatedOutput).not.toContain('read from your image');
  expect(await visionCalls(job.id)).toBe(0);
});

it('does not look at a picture for ordinary speech, a pitch, or a reply the agent will not give', async () => {
  const f = await fixture(`ADDRESS: ${mint}`);
  for (const text of ['@agent please check your DMs', '@agent nice pic', '@agent check this, buy now, join the presale']) {
    const job = await ask(f, text);
    expect(await visionCalls(job.id)).toBe(0);
    expect(job.validatedOutput ?? '').not.toContain('Liquidity');
  }
  expect(jupiterReads).toBe(0);
});

it('applies the same Easy Mode switch, hourly cap and permission as a text ask', async () => {
  const off = await fixture(`ADDRESS: ${mint}`, { tools: { ...DEFAULT_POLICY.tools, evidenceCards: false } as typeof DEFAULT_POLICY.tools });
  const quiet = await ask(off, '@agent check this token');
  expect(await visionCalls(quiet.id)).toBe(0);
  expect(quiet.validatedOutput ?? '').not.toContain('Liquidity');

  const f = await fixture(`ADDRESS: ${mint}`);
  for (let i = 0; i < 10; i++) await ask(f, '@agent check this');
  const last = await ask(f, '@agent check this');
  expect(last.validatedOutput).toContain('hourly token evidence limit');
  expect(last.validatedOutput).not.toContain('Liquidity');
  expect(await query('SELECT * FROM evidence_card_requests WHERE dry_run')).toHaveLength(10);

  await (await import('@xbam/database')).capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'token.inspect_risk', permission: 'DISABLED' });
  expect((await ask(f, '@agent check this', undefined, 'bob')).validatedOutput).toContain('unavailable');
});

it('reuses one read when the job is retried', async () => {
  const f = await fixture(`ADDRESS: ${mint}`);
  const job = await ask(f, '@agent check this');
  const { researchEvidenceCard } = await import('../../packages/runtime/src/evidenceCard');
  const { loadJobBundle } = await import('../../packages/runtime/src/loadJob');
  expect(await researchEvidenceCard(await loadJobBundle(await jobs.requireJob(job.id)))).toBe(true);
  expect(await visionCalls(job.id)).toBe(1);
});

it('lets an owner approve the card with its echo line, and still holds the address anywhere else', async () => {
  const { approveJob } = await import('@xbam/runtime');
  const f = await fixture(`ADDRESS: ${mint}`, { automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } as typeof DEFAULT_POLICY.automation });
  const id = uniqueSuffix();
  const made = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: 'alice', remoteAuthorHandle: 'alice',
      remoteAuthorDisplayName: 'alice', remoteConversationId: id, parentRemoteMessageId: null, remoteUrl: `mock://${id}`,
      text: '@agent check this', occurredAt: new Date().toISOString(), raw: { inventory: { media: [picture] } } } });
  await drainJobs();
  const waiting = await jobs.requireJob(made.jobs[0]!.job.id);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  expect(waiting.validatedOutput).toContain(`read from your image: ${mint}`);
  await expect(approveJob({ jobId: waiting.id, decidedBy: f.ownerId, editedOutput: `${waiting.validatedOutput}\nit is ${mint}` }))
    .rejects.toThrow(/cannot be approved/);
  await approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
});
