import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { accounts, capabilities, jobs, query, observability, ops, capabilityPermissions, agents } from '@xbam/database';
import { DEFAULT_POLICY, PolicyConfig, type ResolvedContext } from '@xbam/shared/contracts';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import { stepExecute } from '../../packages/runtime/src/steps/execute';
import { randomUUID } from 'node:crypto';
import { sealSecret } from '@xbam/shared';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';

const mintA = 'So11111111111111111111111111111111111111112';
const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const mintC = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BANNED = /\b(?:safe|safer|better|best|worse|winner|beats|rug|buy|sell|bullish|price|moon|prediction)\b/i;
let calls: string[] = [];
let failFor: string | null = null;
const liquidity: Record<string, number> = { [mintA]: 12000, [mintB]: 9000, [mintC]: 500 };
vi.mock('undici', () => ({
  Agent: class { async close() {} },
  fetch: async (input: unknown, init?: RequestInit) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) {
      const local = { ...init } as RequestInit & { dispatcher?: unknown };
      delete local.dispatcher;
      return globalThis.fetch(String(input), local);
    }
    if (!String(input).includes('jup.ag')) throw new Error('Unexpected network host');
    const queried = new URL(String(input)).searchParams.get('query') ?? mintA;
    calls.push(queried);
    if (queried === failFor) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify([{ id: queried, liquidity: liquidity[queried] ?? 1, updatedAt: new Date().toISOString(),
      firstPool: { createdAt: new Date(Date.now() - 3600_000).toISOString() },
      audit: { topHoldersPercentage: 20, mintAuthorityDisabled: true, freezeAuthorityDisabled: false } }]), { status: 200 });
  },
}));

beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => { await truncateAll(); await seedCatalogue(); calls = []; failFor = null;
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

it('answers two mints side by side through the real pipeline, with source and time and no winner', async () => {
  const f = await fixture();
  const job = await ask(f, `@agent ${mintA} vs ${mintB}`);
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  const out = job.validatedOutput!;
  expect(out).toContain('Liquidity: A 12000 USD | B 9000 USD');
  expect(out).toContain('Mint authority: A disabled | B disabled');
  expect(out).toMatch(/A read: solana_tokens\.jupiter; fetched \d{4}-/);
  expect(out).toMatch(/B read: solana_tokens\.jupiter; fetched \d{4}-/);
  expect(out).toContain('no ranking, not a verdict, reads can be wrong');
  expect(out).not.toMatch(BANNED);
  expect(out).not.toContain(mintA);
  expect(calls.sort()).toEqual([mintA, mintB].sort());
  expect((await observability.listTrace(job.id)).map(t => t.type)).toEqual(expect.arrayContaining(['RESEARCH_DONE', 'VALIDATION_PASSED']));
  expect(await query('SELECT side, address FROM evidence_compare_requests WHERE job_id=$1 ORDER BY side', [job.id]))
    .toEqual([{ side: 0, address: mintA }, { side: 1, address: mintB }]);
});

it('orders the columns by the asker and never by a value', async () => {
  const f = await fixture();
  const swapped = await ask(f, `@agent ${mintB} vs ${mintA}`);
  expect(swapped.validatedOutput).toContain('Liquidity: A 9000 USD | B 12000 USD');
});

it('says unavailable for the side whose read failed and still renders the other', async () => {
  failFor = mintB;
  const job = await ask(await fixture(), `@agent ${mintA} vs ${mintB}`);
  expect(job.validatedOutput).toContain('Liquidity: A 12000 USD | B unavailable');
  expect(job.validatedOutput).toContain('evidence not found for B');
  expect(job.validatedOutput).not.toContain('evidence not found for A');
  expect(job.validatedOutput).not.toMatch(/\bB 0\b/);
});

it('refuses three mints and a mixed pair with a sentence and reads nothing', async () => {
  const f = await fixture();
  const three = await ask(f, `@agent ${mintA} ${mintB} ${mintC}`);
  expect(three.validatedOutput).toMatch(/^Please .+\.$/);
  const mixed = await ask(f, `@agent ${mintA} vs 0x1111111111111111111111111111111111111111`);
  expect(mixed.validatedOutput).toMatch(/^Please .+\.$/);
  expect(calls).toEqual([]);
});

it('counts mints, not mentions, against the asker cap: a pair spends two and a sixth pair is held', async () => {
  const f = await fixture();
  const results = [];
  // Distinct pairs of the same two mints are cooled down, so alternate fresh asker identities only for the cap check.
  for (let i = 0; i < 5; i++) results.push(await ask(f, `@agent ${mintA} vs ${mintB}`, true, 'alice'));
  // The first pair read both mints; the repeats inside the cooldown are answered without a read.
  expect(results[0]!.validatedOutput).toContain('Liquidity: A 12000 USD');
  expect(results.slice(1).every(j => /read a moment ago/.test(j.validatedOutput ?? ''))).toBe(true);
  expect(calls).toHaveLength(2);
  expect(await query('SELECT * FROM evidence_compare_requests')).toHaveLength(2);
});

it('shares one hourly cap with single cards, and a pair that would pass it is held without a read', async () => {
  const f = await fixture();
  // Nine single reads leave room for one more mint, not for a pair.
  for (let i = 0; i < 9; i++) {
    const mint = `${mintC.slice(0, 40)}${String(1000 + i)}`;
    await query(`INSERT INTO evidence_card_requests(job_id,agent_id,requester,chain,address,dry_run,card_job_id)
      VALUES($1,$2,'mock:alice','solana',$3,true,NULL)`, [(await ask(f, 'hello there')).id, f.agentId, mint]);
  }
  const before = calls.length;
  const held = await ask(f, `@agent ${mintA} vs ${mintB}`);
  expect(held.validatedOutput).toContain('hourly token evidence limit');
  expect(calls.length).toBe(before);
  expect(await query('SELECT * FROM evidence_compare_requests')).toHaveLength(0);
});

it('stops at the same gates as a single card: switch off, permission off, pitch', async () => {
  const f = await fixture();
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'token.inspect_risk', permission: 'DISABLED' });
  expect((await ask(f, `@agent ${mintA} vs ${mintB}`)).validatedOutput).toContain('unavailable');
  expect(calls).toEqual([]);
  const pitch = await ask(await fixture(), `@agent ${mintA} vs ${mintB} buy now guaranteed 100x join our presale`);
  expect(pitch.validatedOutput ?? '').not.toContain('Liquidity:');
  const off = await fixture({ tools: { ...DEFAULT_POLICY.tools, evidenceCards: false } as typeof DEFAULT_POLICY.tools });
  expect((await ask(off, `@agent ${mintA} vs ${mintB}`)).validatedOutput ?? '').not.toContain('side by side');
  expect(calls).toEqual([]);
});

it('rechecks the owner switches before a queued pair sends', async () => {
  const f = await fixture();
  const job = await ask(f, `@agent ${mintA} vs ${mintB}`);
  expect(job.validatedOutput).toContain('side by side');
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'token.inspect_risk', permission: 'DISABLED' });
  await expect(stepExecute(await loadJobBundle(job))).rejects.toThrow(/switched off/);
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'token.inspect_risk', permission: 'ALLOWED' });
  const policy = PolicyConfig.parse((await agents.getActivePolicy(f.agentId))!.config);
  policy.tools.evidenceCards = false;
  await agents.savePolicyVersion(f.agentId, policy, 'disable evidence', f.ownerId);
  await expect(stepExecute(await loadJobBundle(job))).rejects.toThrow(/switched off/);
});

it('holds a pair whose text no longer matches its readings', async () => {
  const f = await fixture();
  const job = await ask(f, `@agent ${mintA} vs ${mintB}`);
  const context = job.resolvedContext as ResolvedContext & { meta: { evidenceCard: { text: string } } };
  const text = context.meta.evidenceCard.text.replace('A 12000 USD', 'A 1 USD');
  const forged = { ...context, meta: { ...context.meta, evidenceCard: { ...context.meta.evidenceCard, text } } };
  await jobs.updateJob(job.id, { resolvedContext: forged as ResolvedContext, generatedOutput: text, validatedOutput: text });
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/complete sourced evidence card/);
});

const STUDIO = 'https://studio.example.invalid';
async function linkStudio(origin = STUDIO) {
  await ops.setSetting('plugins.registry.url', origin);
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(newInstallationKey())));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin, linkedAt: new Date().toISOString(), revokedAt: null });
}
const linking = (on: boolean) => ({ tools: { ...DEFAULT_POLICY.tools, evidenceCards: true, evidenceCardLink: on } as typeof DEFAULT_POLICY.tools });

it('links each side to its own check page only with the owner opt-in, and holds the pair if the link changes', async () => {
  await linkStudio();
  const off = await ask(await fixture(linking(false)), `@agent ${mintA} vs ${mintB}`);
  expect(off.validatedOutput).not.toMatch(/https?:/);
  expect(off.status).toBe('DRY_RUN_COMPLETED');
  const f = await fixture(linking(true));
  const on = await ask(f, `@agent ${mintC} vs ${mintB}`);
  const lines = on.validatedOutput!.split('\n');
  expect(lines.at(-2)).toBe(`Check A: ${STUDIO}/check/solana/${mintC}`);
  expect(lines.at(-1)).toBe(`Check B: ${STUDIO}/check/solana/${mintB}`);
  expect(on.status).toBe('DRY_RUN_COMPLETED');
  await linkStudio('https://other-studio.example.invalid');
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(on.id)))).rejects.toThrow(/check page link/);
  await ops.setSetting('plugins.registry.url', null);
  await ops.setSetting('studio.link', null);
});
