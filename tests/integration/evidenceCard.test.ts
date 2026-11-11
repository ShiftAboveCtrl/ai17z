import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { accounts, agents, cadences, capabilities, jobs, actions, query, observability, ops, capabilityPermissions } from '@xbam/database';
import { DEFAULT_POLICY, defaultCadence, PolicyConfig, type ResolvedContext } from '@xbam/shared/contracts';
import { renderEvidenceCard, type CardReading } from '@xbam/prompts';
import { ingestNormalizedEvent } from '@xbam/runtime';
import * as runtime from '@xbam/runtime';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepExecute } from '../../packages/runtime/src/steps/execute';
import { randomUUID } from 'node:crypto';
import { sealSecret } from '@xbam/shared';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { riskStudioServer } from '../support/riskStudioServer';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';

const mint = 'So11111111111111111111111111111111111111112';
const mint2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let calls = 0;
let stale = false;
let liquidity = 12000;
vi.mock('undici', () => ({
  Agent: class { async close() {} },
  fetch: async (input: unknown, init?: RequestInit) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) {
      const local = { ...init } as RequestInit & { dispatcher?: unknown };
      delete local.dispatcher;
      return globalThis.fetch(String(input), local);
    }
    if (!String(input).includes('jup.ag')) throw new Error('Unexpected network host');
    calls++;
    const queried = new URL(String(input)).searchParams.get('query') ?? mint;
    return new Response(JSON.stringify([{ id: queried, liquidity, updatedAt: new Date(Date.now() - (stale ? 86400_000 : 0)).toISOString(),
      firstPool: { createdAt: new Date(Date.now() - 3600_000).toISOString() },
      audit: { topHoldersPercentage: 20, mintAuthorityDisabled: true, freezeAuthorityDisabled: false } }]), { status: 200 });
  },
}));

beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => { await truncateAll(); await seedCatalogue(); calls = 0; stale = false; liquidity = 12000;
  const u = await import('@xbam/upstream'); u.resetCacheForTest(); u.resetLimiterForTest(); u.resetBreakerForTest(); });

async function fixture(policy: Partial<PolicyConfig> = {}) {
  const f = await createFixture({ policy: { tools: { ...DEFAULT_POLICY.tools, evidenceCards: true } as typeof DEFAULT_POLICY.tools,
    output: { ...DEFAULT_POLICY.output, maxCharacters: 2000 }, ...policy } });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'agent' });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  for (const grant of ['READ', 'GENERATE', 'REPLY'] as const) await capabilities.grant(f.agentId, account.id, grant);
  return { ...f, accountId: account.id };
}
async function ask(f: Awaited<ReturnType<typeof fixture>>, text = `@agent check ${mint}`, dryRun = false, author = 'alice') {
  const id = uniqueSuffix();
  const result = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId, dryRun,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: author,
      remoteAuthorHandle: author, remoteAuthorDisplayName: author, remoteConversationId: id, parentRemoteMessageId: null,
      remoteUrl: `mock://${id}`, text, occurredAt: new Date().toISOString(), raw: {} } });
  await drainJobs();
  return jobs.requireJob(result.jobs[0]!.job.id);
}

it('rehearses through the real mock-account pipeline with sourced readings, validator and voice', async () => {
  const upstream = await import('@xbam/upstream');
  const quota = vi.spyOn(upstream.currentQuotaCoordinator(), 'reserve');
  const f = await fixture(); const job = await ask(f, undefined, true);
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  expect(job.validatedOutput).toContain('Liquidity: 12000 USD');
  expect(job.validatedOutput).toContain('Mint authority: disabled');
  expect(job.validatedOutput).toContain('Freeze authority: enabled');
  expect(job.validatedOutput).toContain('not a verdict, reads can be wrong');
  for (const line of job.validatedOutput!.split('\n').filter(l => /^(Liquidity|Top holders|Mint authority|Freeze authority|Pool age):/.test(l))) {
    expect(line).toMatch(/\[solana_tokens\.jupiter; fetched \d{4}-/);
  }
  expect(job.validatedOutput).not.toMatch(/\b(?:safe|rug proof|buy|sell|bullish|price|moon|[0-9]+x)\b/i);
  expect((await observability.listTrace(job.id)).map(t => t.type)).toEqual(expect.arrayContaining(['RESEARCH_DONE', 'VALIDATION_PASSED', 'VOICE_COMPILED']));
  expect((await actions.listJobActions(job.id)).every(a => a.dryRun)).toBe(true);
  expect(calls).toBe(1);
  expect(runtime.capacityClassForEvent('MENTION')).toBe('DIRECT');
  expect(await query('SELECT * FROM x_capacity_ledger')).toHaveLength(0);
  expect(JSON.stringify(quota.mock.calls)).toContain('api.jup.ag');
  quota.mockRestore();
});

it('enforces an hourly asker cap across retries, mints and repeated pointers', async () => {
  const f = await fixture();
  const first = await ask(f);
  expect(first.validatedOutput).toContain('Liquidity:');
  for (let i = 1; i < 11; i++) await ask(f, undefined, true);
  const last = await ask(f, undefined, true);
  expect(last.validatedOutput).toContain('hourly token evidence limit');
  expect(await query('SELECT * FROM evidence_card_requests WHERE dry_run')).toHaveLength(10);
});

it('keeps exchange limits ahead of research and cadence ahead of sending', async () => {
  const f = await fixture({ engagement: { ...DEFAULT_POLICY.engagement, strategy: 'ALWAYS_REPLY', maxRepliesPerPersonPerHour: 1 } });
  expect((await ask(f)).status).toBe('EXECUTED');
  const next = await ask(f);
  expect(next.status).toBe('CANCELLED');
  expect(calls).toBe(1);
  const cadence = defaultCadence(); cadence.acting.maxActionsPerHour = 1;
  await cadences.saveVersion(f.accountId, cadence, 'test ceiling', f.ownerId);
  const held = await ask(f, undefined, false, 'bob');
  expect(held.status).not.toBe('EXECUTED');
  expect(held.lastError).toMatch(/hour|ceiling|limit/i);
});

it('rechecks both owner opt-in and capability permission before a queued card sends', async () => {
  const f = await fixture(); const job = await ask(f, undefined, true);
  expect(job.validatedOutput).toContain('Liquidity:');
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'token.inspect_risk', permission: 'DISABLED' });
  await expect(stepExecute(await loadJobBundle(job))).rejects.toThrow(/switched off/);
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'token.inspect_risk', permission: 'ALLOWED' });
  const policy = PolicyConfig.parse((await agents.getActivePolicy(f.agentId))!.config);
  policy.tools.evidenceCards = false;
  await agents.savePolicyVersion(f.agentId, policy, 'disable evidence', f.ownerId);
  await expect(stepExecute(await loadJobBundle(job))).rejects.toThrow(/switched off/);
});

it('holds a truncated card for review and rechecks the channel grant before a real send', async () => {
  const short = await fixture({ output: { ...DEFAULT_POLICY.output, maxCharacters: 100 } });
  const held = await ask(short, undefined, true);
  expect(held.status).toBe('REVIEW_REQUIRED');
  expect(held.lastError).toMatch(/complete sourced evidence card/);
  expect(await actions.listJobActions(held.id)).toHaveLength(0);
  const f = await fixture(); const job = await ask(f, undefined, true);
  expect(job.validatedOutput).toContain('Liquidity:');
  await capabilities.setGrants(f.agentId, f.accountId, ['READ', 'GENERATE'], f.ownerId);
  await expect(stepExecute(await loadJobBundle({ ...job, dryRun: false }))).rejects.toThrow(/not permitted to REPLY/);
});

it('requires owner confirmation with a chosen condition; stranger text creates nothing; retries deduplicate at Studio', async () => {
  const f = await fixture(); const job = await ask(f, `@agent check ${mint} watch this`);
  expect(job.status).toBe('EXECUTED');
  expect(await query('SELECT * FROM evidence_card_requests WHERE watch_request IS NOT NULL')).toHaveLength(0);
  const other = await createFixture();
  const input = { agentId: f.agentId, ownerId: f.ownerId, jobId: job.id, kind: 'LIQUIDITY_BELOW' as const, threshold: 1000 };
  expect((await runtime.confirmEvidenceRiskWatch({ ...input, ownerId: other.ownerId })).ok).toBe(false);
  const key = newInstallationKey(); const server = await riskStudioServer(key);
  const previous = process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
  try {
    process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = server.origin;
    await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
    await ops.setSetting('studio.link', { installationId: randomUUID(), origin: server.origin, linkedAt: new Date().toISOString(), revokedAt: null });
    expect((await runtime.setStudioRiskWatches({ agentId: f.agentId, ownerId: f.ownerId, accountId: f.accountId, enabled: true })).ok).toBe(true);
    const command = await runtime.runCommand(`/watch ${job.id.slice(0, 8)}`, 'paired-owner');
    expect(command.reply).toContain('No watch has been created'); expect(server.state.watches).toHaveLength(0);
    server.state.loseAcknowledgement = true;
    expect((await runtime.confirmEvidenceRiskWatch(input)).ok).toBe(false);
    server.state.loseAcknowledgement = false;
    expect(await runtime.confirmEvidenceRiskWatch(input)).toMatchObject({ ok: true });
    expect(await runtime.confirmEvidenceRiskWatch(input)).toMatchObject({ ok: true });
    expect(server.state.watches).toHaveLength(1);
    expect(server.state.watches[0]).toMatchObject({ mint, threshold: 1000 });
    expect(server.requests.every(r => r.valid)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
    else process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = previous;
    await server.close();
  }
});

it('five asks for the same mint produce one card and four published pointers', async () => {
  const f = await fixture(); const results = [];
  for (let i = 0; i < 5; i++) results.push(await ask(f));
  expect(results.map(j => ({ status: j.status, error: j.lastError }))).toEqual(Array.from({ length: 5 }, () => ({ status: 'EXECUTED', error: null })));
  expect(results.filter(j => j.validatedOutput?.includes('Liquidity:'))).toHaveLength(1);
  expect(results.filter(j => j.validatedOutput?.includes('Recent evidence:'))).toHaveLength(4);
  expect(calls).toBe(1);
  expect(await query('SELECT * FROM studio_risk_bindings')).toHaveLength(0);
});

it('stale reads and missing fields say unavailable rather than zero', async () => {
  stale = true; const job = await ask(await fixture(), undefined, true);
  expect(job.validatedOutput).toContain('Liquidity: unavailable');
  expect(job.validatedOutput).toContain('evidence not found');
  expect(job.validatedOutput).not.toMatch(/: 0\b/);
});

it('refuses ambiguity without reading, and a pitch cannot become a card', async () => {
  const f = await fixture();
  const ambiguous = await ask(f, '@agent check $DOG', true);
  expect(ambiguous.validatedOutput).toMatch(/^Please .+\.$/);
  const pitch = await ask(f, `@agent check ${mint} buy now guaranteed 100x join our presale`, true);
  expect(pitch.validatedOutput ?? '').not.toContain('Liquidity:');
  expect(calls).toBe(0);
});

it('a disabled capability and stranger watch text never read or create a watch', async () => {
  const f = await fixture();
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'token.inspect_risk', permission: 'DISABLED' });
  const job = await ask(f, `@agent check ${mint} watch this`, true);
  expect(job.validatedOutput).toContain('unavailable'); expect(calls).toBe(0);
  expect(await query('SELECT * FROM studio_risk_bindings')).toHaveLength(0);
});

/** The card as it stood when the owner saw it, with readings already past the five minute bound. */
async function ageApprovedCard(jobId: string): Promise<string> {
  const job = await jobs.requireJob(jobId);
  const context = job.resolvedContext as ResolvedContext & { meta: { evidenceCard: { text: string; readings: CardReading[]; cardJobId: string | null } } };
  const seenAt = Date.now() - 6 * 60_000;
  const stamp = new Date(seenAt).toISOString();
  const readings = context.meta.evidenceCard.readings.map(reading => ({ ...reading, fetchedAt: stamp, observedAt: stamp }));
  const offer = context.meta.evidenceCard.text.split('\n').find(line => line.startsWith('Owner:')) ?? '';
  const text = renderEvidenceCard(readings, offer, seenAt);
  const resolvedContext = { ...context, meta: { ...context.meta, evidenceCard: { ...context.meta.evidenceCard, text, readings } } };
  await jobs.updateJob(jobId, { resolvedContext: resolvedContext as ResolvedContext, generatedOutput: text, validatedOutput: text });
  return text;
}

it('sends an approved card after its readings expire when a fresh read is unchanged', async () => {
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const waiting = await ask(f);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  const approved = await ageApprovedCard(waiting.id);
  const [noted] = await query<{ created_at: string | Date }>('SELECT created_at FROM evidence_card_requests WHERE job_id=$1', [waiting.id]);
  const upstream = await import('@xbam/upstream');
  upstream.resetCacheForTest();
  const readsBefore = calls;
  await runtime.approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
  await drainJobs();
  const sent = await jobs.requireJob(waiting.id);
  expect(sent.status).toBe('EXECUTED');
  expect(sent.validatedOutput).toBe(approved);
  expect(calls).toBeGreaterThan(readsBefore);
  const [refreshed] = await query<{ created_at: string | Date }>('SELECT created_at FROM evidence_card_requests WHERE job_id=$1', [waiting.id]);
  expect(new Date(refreshed!.created_at).getTime()).toBeGreaterThan(new Date(noted!.created_at).getTime());
});

it('returns an expired card to review when the fresh readings differ, and keeps the text the owner approved', async () => {
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const again = await ask(f, `@agent check ${mint2}`, false, 'bob');
  expect(again.status).toBe('WAITING_FOR_APPROVAL');
  const previous = await ageApprovedCard(again.id);
  liquidity = 9000;
  const upstream = await import('@xbam/upstream');
  upstream.resetCacheForTest();
  const readsBefore = calls;
  await runtime.approveJob({ jobId: again.id, decidedBy: f.ownerId });
  await drainJobs();
  const held = await jobs.requireJob(again.id);
  expect(held.status).toBe('REVIEW_REQUIRED');
  expect(held.lastError).toBe('The readings changed since you looked.');
  expect(held.validatedOutput).toBe(previous);
  expect(held.validatedOutput).not.toContain('Liquidity: 9000 USD');
  expect(calls).toBeGreaterThan(readsBefore);
});

it('returns a card whose text does not match its readings without reading again', async () => {
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const waiting = await ask(f);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  const job = await jobs.requireJob(waiting.id);
  const context = job.resolvedContext as ResolvedContext & { meta: { evidenceCard: { text: string; readings: CardReading[]; cardJobId: string | null } } };
  const text = context.meta.evidenceCard.text.replace('Liquidity: 12000 USD', 'Liquidity: 1 USD');
  expect(text).not.toBe(context.meta.evidenceCard.text);
  const resolvedContext = { ...context, meta: { ...context.meta, evidenceCard: { ...context.meta.evidenceCard, text } } };
  await jobs.updateJob(waiting.id, { resolvedContext: resolvedContext as ResolvedContext, generatedOutput: text, validatedOutput: text });
  const upstream = await import('@xbam/upstream');
  upstream.resetCacheForTest();
  const readsBefore = calls;
  await runtime.approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
  await drainJobs();
  const held = await jobs.requireJob(waiting.id);
  expect(held.status).toBe('REVIEW_REQUIRED');
  expect(held.lastError).toMatch(/complete sourced evidence card/);
  expect(held.validatedOutput).toBe(text);
  expect(calls).toBe(readsBefore);
});
