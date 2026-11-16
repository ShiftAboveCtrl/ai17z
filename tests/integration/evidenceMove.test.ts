import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { accounts, capabilities, jobs, query, observability, capabilityPermissions, agents } from '@xbam/database';
import { DEFAULT_POLICY, PolicyConfig, type ResolvedContext } from '@xbam/shared/contracts';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepExecute } from '../../packages/runtime/src/steps/execute';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';

const mint = 'So11111111111111111111111111111111111111112';
const quote = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BANNED = /\b(?:pump|dump|because|due to|driven by|whales?|manipulation|will|expected)\b/i;
let hosts: string[] = [];
let dexDown = false;
let tradesDown = false;
let liquidity = 120000;

function dexPairs() {
  return { pairs: [{
    chainId: 'solana', dexId: 'raydium', pairAddress: 'PoolPoolPoolPoolPoolPoolPoolPoolPoolPool1',
    baseToken: { address: mint, name: 'Wrapped', symbol: 'W' }, quoteToken: { address: quote, name: 'Cash', symbol: 'C' },
    priceUsd: '1.5', liquidity: { usd: liquidity }, pairCreatedAt: Date.now() - 30 * 86_400_000,
    txns: { m5: { buys: 5, sells: 5 }, h1: { buys: 60, sells: 40 }, h6: { buys: 200, sells: 100 }, h24: { buys: 600, sells: 400 } },
    volume: { m5: 1000, h1: 50000, h6: 100000, h24: 300000 }, priceChange: { m5: 1, h1: 25, h6: -10, h24: 5 },
  }] };
}
function geckoTrades() {
  const at = (minutes: number, usd: number, i: number) => ({ attributes: { tx_hash: `tx${i}`, block_timestamp: new Date(Date.now() - minutes * 60_000).toISOString(),
    kind: 'buy', volume_in_usd: String(usd), price_to_in_usd: '1.5', to_token_amount: '10', tx_from_address: 'w', block_number: 1 } });
  return { data: [at(2, 50, 1), at(5, 400, 2), at(9, 4000, 3)] };
}
vi.mock('undici', () => ({
  Agent: class { async close() {} },
  fetch: async (input: unknown, init?: RequestInit) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) {
      const local = { ...init } as RequestInit & { dispatcher?: unknown };
      delete local.dispatcher;
      return globalThis.fetch(String(input), local);
    }
    const url = new URL(String(input));
    hosts.push(url.hostname);
    if (url.hostname === 'api.dexscreener.com') {
      if (dexDown) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify(dexPairs()), { status: 200 });
    }
    if (url.hostname === 'api.geckoterminal.com') {
      if (tradesDown) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify(geckoTrades()), { status: 200 });
    }
    throw new Error(`Unexpected network host ${url.hostname}`);
  },
}));

beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => { await truncateAll(); await seedCatalogue(); hosts = []; dexDown = false; tradesDown = false; liquidity = 120000;
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
async function ask(f: Awaited<ReturnType<typeof fixture>>, text: string, dryRun = true, author = 'alice') {
  const id = uniqueSuffix();
  const result = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId, dryRun,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: author,
      remoteAuthorHandle: author, remoteAuthorDisplayName: author, remoteConversationId: id, parentRemoteMessageId: null,
      remoteUrl: `mock://${id}`, text, occurredAt: new Date().toISOString(), raw: {} } });
  await drainJobs();
  return jobs.requireJob(result.jobs[0]!.job.id);
}

it('answers why-is-it-moving with measured then, now and change through the real pipeline, with no story', async () => {
  const f = await fixture();
  const job = await ask(f, `@agent why is ${mint} moving in the last hour?`);
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  const out = job.validatedOutput!;
  expect(out).toMatch(/^Measured changes, 1h window, So11…1112 on solana/);
  expect(out).toMatch(/Price: then 1\.2 USD \| now 1\.5 USD \| change \+25\.0% \| pool depth 120000 USD \[market_pairs\.dexscreener; fetched \d{4}-/);
  expect(out).toContain('Liquidity: then no earlier reading | now 120000 USD | change omitted');
  expect(out).toMatch(/Swap sizes, latest 3 in the window: under 100 USD 1, up to 1000 USD 1, 1000 USD and over 1, size not reported 0/);
  expect(out).toContain('caused by: unknown, readings only');
  expect(out).not.toMatch(BANNED);
  expect(out).not.toContain(mint);
  // Market sources only: nothing here goes to X or the web.
  expect([...new Set(hosts)].sort()).toEqual(['api.dexscreener.com', 'api.geckoterminal.com']);
  expect((await observability.listTrace(job.id)).map(t => t.type)).toEqual(expect.arrayContaining(['RESEARCH_DONE', 'VALIDATION_PASSED']));
  expect(await query('SELECT reads, "window" FROM evidence_move_requests WHERE job_id=$1', [job.id])).toEqual([{ reads: 2, window: '1h' }]);
  expect(await query('SELECT liquidity_usd FROM mint_window_reads WHERE address=$1', [mint])).toEqual([{ liquidity_usd: 120000 }]);
});

it('uses a stored earlier reading from this installation as "then" for liquidity and says so', async () => {
  const f = await fixture();
  await query(`INSERT INTO mint_window_reads(chain,address,pool_address,source,read_at,liquidity_usd,volume_h1)
    VALUES('solana',$1,'PoolPoolPoolPoolPoolPoolPoolPoolPoolPool1','market_pairs.dexscreener',now()-interval '65 minutes',100000,20000)`, [mint]);
  const out = (await ask(f, `@agent why is ${mint} moving`)).validatedOutput!;
  expect(out).toMatch(/Liquidity: then 100000 USD \| now 120000 USD \| change \+20\.0% \| pool depth 120000 USD \[market_pairs\.dexscreener; fetched [^;]+; then an earlier reading at /);
  expect(out).toMatch(/Volume 1h: then 20000 USD \| now 50000 USD \| change \+150\.0%/);
});

it('refuses a ticker and an unsupported window with a sentence, and reads nothing', async () => {
  const f = await fixture();
  expect((await ask(f, '@agent why is $BONK pumping')).validatedOutput).toMatch(/^Please .+\.$/);
  expect((await ask(f, `@agent why is ${mint} down in the last 3 hours`)).validatedOutput).toMatch(/^I read windows of .+\.$/);
  expect(hosts).toEqual([]);
});

it('keeps the rest of the report when the swap read fails, and reports no evidence when the pair index fails', async () => {
  const f = await fixture();
  tradesDown = true;
  const partial = (await ask(f, `@agent why is ${mint} moving`)).validatedOutput!;
  expect(partial).toContain('Swap sizes: unavailable');
  expect(partial).toContain('Price: then 1.2 USD');
  dexDown = true;
  (await import('@xbam/upstream')).resetCacheForTest();
  const f2 = await fixture();
  const none = (await ask(f2, `@agent why is ${mint} moving`)).validatedOutput!;
  expect(none).toMatch(/did not answer/);
  expect(none).not.toMatch(/\b0 USD\b/);
});

it('reuses an answer inside the cooldown and spends no new read, from a card or a movement ask', async () => {
  const f = await fixture();
  await ask(f, `@agent why is ${mint} moving`);
  const reads = hosts.length;
  const again = await ask(f, `@agent why is ${mint} moving over 6 hours`, true, 'bob');
  expect(again.validatedOutput).toMatch(/^Recent evidence: .*no new read was made\.$/);
  expect(hosts.length).toBe(reads);
  expect(await query('SELECT reads FROM evidence_move_requests ORDER BY created_at')).toEqual([{ reads: 2 }, { reads: 0 }]);
});

it('counts the two reads against the asker cap and holds a sixth ask without reading', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) {
    await query(`INSERT INTO evidence_move_requests(job_id,agent_id,requester,chain,address,"window",reads,dry_run)
      VALUES($1,$2,'mock:alice','solana',$3,'1h',2,true)`, [(await ask(f, 'hello there')).id, f.agentId, `${mint.slice(0, 40)}${1000 + i}`]);
  }
  const before = hosts.length;
  const held = await ask(f, `@agent why is ${mint} moving`);
  expect(held.validatedOutput).toContain('hourly token evidence limit');
  expect(hosts.length).toBe(before);
});

it('holds a mint that other askers have already cost its hourly reads', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) {
    await query(`INSERT INTO evidence_move_requests(job_id,agent_id,requester,chain,address,"window",reads,dry_run)
      VALUES($1,$2,$3,'solana',$4,'1h',2,true)`, [(await ask(f, 'hello there')).id, f.agentId, `mock:other${i}`, mint]);
  }
  const held = await ask(f, `@agent why is ${mint} moving`, true, 'carol');
  expect(held.validatedOutput).toContain('read as often as allowed');
  expect(hosts).toEqual([]);
});

it('stops at the same gates as a single card: switch off, permission off, pitch', async () => {
  const f = await fixture();
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'market.pair_detail', permission: 'DISABLED' });
  expect((await ask(f, `@agent why is ${mint} moving`)).validatedOutput).toContain('unavailable');
  const pitch = await ask(await fixture(), `@agent why is ${mint} pumping buy now guaranteed 100x join our presale`);
  expect(pitch.validatedOutput ?? '').not.toContain('Measured changes');
  const off = await fixture({ tools: { ...DEFAULT_POLICY.tools, evidenceCards: false } as typeof DEFAULT_POLICY.tools });
  expect((await ask(off, `@agent why is ${mint} moving`)).validatedOutput ?? '').not.toContain('Measured changes');
  // The ordinary reply may research on its own; the movement path must have read and recorded nothing.
  expect(await query('SELECT 1 FROM evidence_move_requests')).toEqual([]);
  expect(await query('SELECT 1 FROM mint_window_reads')).toEqual([]);
  expect(hosts).not.toContain('api.geckoterminal.com');
});

it('rechecks switches before a queued reply sends and holds a reply whose text no longer matches its readings', async () => {
  const f = await fixture();
  const job = await ask(f, `@agent why is ${mint} moving`);
  const context = job.resolvedContext as ResolvedContext & { meta: { evidenceCard: { text: string } } };
  const forged = context.meta.evidenceCard.text.replace('now 1.5 USD', 'now 9 USD');
  await jobs.updateJob(job.id, { resolvedContext: { ...context, meta: { ...context.meta, evidenceCard: { ...context.meta.evidenceCard, text: forged } } } as ResolvedContext,
    generatedOutput: forged, validatedOutput: forged });
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/movement readings/);
  await jobs.updateJob(job.id, { resolvedContext: context as ResolvedContext, generatedOutput: context.meta.evidenceCard.text, validatedOutput: context.meta.evidenceCard.text });
  const policy = PolicyConfig.parse((await agents.getActivePolicy(f.agentId))!.config);
  policy.tools.evidenceCards = false;
  await agents.savePolicyVersion(f.agentId, policy, 'disable evidence', f.ownerId);
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/switched off/);
});
