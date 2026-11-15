import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { accounts, capabilities, jobs, query, observability, capabilityPermissions, agents } from '@xbam/database';
import { DEFAULT_POLICY, PolicyConfig, type ResolvedContext } from '@xbam/shared/contracts';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepExecute } from '../../packages/runtime/src/steps/execute';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';
import { TX_SIGNATURE, failedTransaction, successfulTransaction } from '../support/transactionFixtures';

const BANNED = /whale|insider|smart money|dump|bought|sold|profit|loss|rug|swap/i;
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
let methods: { method: string; commitment: string }[] = [];
let hosts: string[] = [];
let answers: Record<string, unknown> = {};
let rpcDown = false;

// The cluster is answered from recorded results; nothing reaches a network.
vi.mock('undici', () => ({
  Agent: class { async close() {} },
  fetch: async (input: unknown, init?: RequestInit) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) {
      const local = { ...init } as RequestInit & { dispatcher?: unknown };
      delete local.dispatcher;
      return globalThis.fetch(String(input), local);
    }
    hosts.push(new URL(String(input)).hostname);
    const request = JSON.parse(String(init?.body ?? '{}')) as { method: string; params?: unknown[] };
    const options = (request.params?.[1] ?? {}) as { commitment?: string };
    methods.push({ method: request.method, commitment: options.commitment ?? '' });
    if (rpcDown) return new Response('{}', { status: 503 });
    const result = request.method === 'getGenesisHash' ? GENESIS : request.method === 'getTransaction' ? answers[options.commitment ?? ''] ?? null : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
}));

beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => {
  await truncateAll(); await seedCatalogue(); methods = []; hosts = []; rpcDown = false;
  answers = { finalized: successfulTransaction() };
  const u = await import('@xbam/upstream'); u.resetCacheForTest(); u.resetLimiterForTest(); u.resetBreakerForTest();
});

async function fixture(policy: Partial<PolicyConfig> = {}) {
  const f = await createFixture({ policy: { tools: { ...DEFAULT_POLICY.tools, evidenceCards: true } as typeof DEFAULT_POLICY.tools,
    output: { ...DEFAULT_POLICY.output, maxCharacters: 2000 }, ...policy } });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'agent' });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  for (const grant of ['READ', 'GENERATE', 'REPLY'] as const) await capabilities.grant(f.agentId, account.id, grant);
  return { ...f, accountId: account.id };
}
async function ask(f: Awaited<ReturnType<typeof fixture>>, text: string, dryRun = true, author = 'alice') {
  const id = uniqueSuffix();
  const result = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId, dryRun,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: author,
      remoteAuthorHandle: author, remoteAuthorDisplayName: author, remoteConversationId: id, parentRemoteMessageId: null,
      remoteUrl: `mock://${id}`, text, occurredAt: new Date().toISOString(), raw: {} } });
  await drainJobs();
  return jobs.requireJob(result.jobs[0]!.job.id);
}
const readsOf = () => methods.filter(m => m.method === 'getTransaction');

it('explains a signature through the real pipeline with only what was read, and no X or web read', async () => {
  const f = await fixture();
  const job = await ask(f, `@agent what did this transaction do? ${TX_SIGNATURE}`);
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  const out = job.validatedOutput!;
  expect(out).toMatch(/^Transaction reading, .+ on solana/);
  expect(out).toContain('Status: succeeded, finalized, slot 446036119');
  expect(out).toContain('fee 5000 lamports');
  expect(out).toContain('not decoded');
  expect(out).toContain('(-5005000)');
  expect(out).not.toMatch(BANNED);
  expect(readsOf()).toEqual([{ method: 'getTransaction', commitment: 'finalized' }]);
  expect(new Set(hosts).size).toBeGreaterThan(0);
  expect((await observability.listTrace(job.id)).map(t => t.type)).toEqual(expect.arrayContaining(['RESEARCH_DONE', 'VALIDATION_PASSED']));
  expect(await query('SELECT reads FROM evidence_transaction_requests WHERE job_id=$1', [job.id])).toEqual([{ reads: 1 }]);
});

it('reports a failed transaction as failed, and a not yet finalized one as confirmed', async () => {
  const f = await fixture();
  answers = { finalized: failedTransaction() };
  expect((await ask(f, `explain ${TX_SIGNATURE}`)).validatedOutput).toContain('Status: failed, finalized');
  (await import('@xbam/upstream')).resetCacheForTest();
  answers = { confirmed: successfulTransaction() };
  const out = (await ask(await fixture(), `@agent what happened here ${TX_SIGNATURE}`, true, 'bob')).validatedOutput!;
  expect(out).toContain('confirmed (not yet finalized)');
  expect(methods.filter(m => m.method === 'getTransaction').map(m => m.commitment)).toEqual(['finalized', 'finalized', 'confirmed']);
});

it('says nothing was found when neither commitment has it, and nothing when the source is down', async () => {
  const f = await fixture();
  answers = {};
  expect((await ask(f, `explain ${TX_SIGNATURE}`)).validatedOutput).toMatch(/No transaction was found .* This is not a verdict\./);
  rpcDown = true;
  (await import('@xbam/upstream')).resetCacheForTest();
  expect((await ask(await fixture(), `explain ${TX_SIGNATURE}`, true, 'bob')).validatedOutput).toMatch(/did not answer/);
});

it('refuses a signature that is not 64 bytes, a pair, and a whose-is-it question, and reads nothing', async () => {
  const f = await fixture();
  expect((await ask(f, `explain ${TX_SIGNATURE}${TX_SIGNATURE.slice(0, 8)}`)).validatedOutput).toMatch(/does not decode/);
  expect((await ask(f, `explain ${TX_SIGNATURE} and ${TX_SIGNATURE.slice(0, 87)}1`)).validatedOutput).toMatch(/One transaction at a time/);
  expect((await ask(f, `whose is this tx ${TX_SIGNATURE}`)).validatedOutput).toMatch(/do not say who an address belongs to/);
  expect(readsOf()).toEqual([]);
  expect(await query('SELECT 1 FROM evidence_transaction_requests')).toEqual([]);
});

it('reuses a recent answer for the same signature and spends no read', async () => {
  const f = await fixture();
  await ask(f, `explain ${TX_SIGNATURE}`);
  const before = methods.length;
  const again = await ask(f, `what did this do ${TX_SIGNATURE}`, true, 'bob');
  expect(again.validatedOutput).toMatch(/^Recent reading: .*no new read was made\.$/);
  expect(methods.length).toBe(before);
  expect(await query('SELECT reads FROM evidence_transaction_requests ORDER BY created_at')).toEqual([{ reads: 1 }, { reads: 0 }]);
});

it('holds an asker who has spent the hourly reads, without reading', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    await query(`INSERT INTO evidence_transaction_requests(job_id,agent_id,requester,signature,reads,dry_run)
      VALUES($1,$2,'mock:alice',$3,2,true)`, [(await ask(f, 'hello there')).id, f.agentId, `sig${i}`]);
  }
  const held = await ask(f, `explain ${TX_SIGNATURE}`);
  expect(held.validatedOutput).toContain('hourly transaction reading limit');
  expect(readsOf()).toEqual([]);
});

it('is off by default and stops at the capability permission', async () => {
  const off = await fixture({ tools: { ...DEFAULT_POLICY.tools, evidenceCards: false } as typeof DEFAULT_POLICY.tools });
  expect((await ask(off, `explain ${TX_SIGNATURE}`)).validatedOutput ?? '').not.toContain('Transaction reading');
  expect(DEFAULT_POLICY.tools.evidenceCards).toBe(false);
  const f = await fixture();
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'solana.read_transaction', permission: 'DISABLED' });
  expect((await ask(f, `explain ${TX_SIGNATURE}`)).validatedOutput).toContain('unavailable');
  expect(readsOf()).toEqual([]);
});

it('rechecks switches before a queued reply sends and holds text that no longer matches its reading', async () => {
  const f = await fixture();
  const job = await ask(f, `explain ${TX_SIGNATURE}`);
  const context = job.resolvedContext as ResolvedContext & { meta: { evidenceCard: { text: string } } };
  const forged = context.meta.evidenceCard.text.replace('fee 5000 lamports', 'fee 1 lamports');
  await jobs.updateJob(job.id, { resolvedContext: { ...context, meta: { ...context.meta, evidenceCard: { ...context.meta.evidenceCard, text: forged } } } as ResolvedContext,
    generatedOutput: forged, validatedOutput: forged });
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/transaction reading/);
  await jobs.updateJob(job.id, { resolvedContext: context as ResolvedContext, generatedOutput: context.meta.evidenceCard.text, validatedOutput: context.meta.evidenceCard.text });
  const policy = PolicyConfig.parse((await agents.getActivePolicy(f.agentId))!.config);
  policy.tools.evidenceCards = false;
  await agents.savePolicyVersion(f.agentId, policy, 'disable evidence', f.ownerId);
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/switched off/);
});
