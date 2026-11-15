import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { accounts, agents, cadences, capabilities, jobs, actions, query, observability, ops, capabilityPermissions } from '@xbam/database';
import { DEFAULT_POLICY, defaultCadence, PolicyConfig, type ResolvedContext } from '@xbam/shared/contracts';
import { renderEvidenceCard, type CardReading, type DeployerHistory, type MintExtensions } from '@xbam/prompts';
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
let unknown = false;
let liquidity = 12000;
const creator = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let chainRead = false;
let rpcMethods: string[] = [];
/** The mint account the mocked node returns, as base64, and its owner. Null is an account that does not exist. */
let mintAccount: { owner: string; data: string } | null = null;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const feeMint = (bps: number, delegateKey: string, scheduled?: { epoch: number; bps: number }) => {
  // A padded mint, the account type, then a transfer fee and a permanent delegate entry, as the program lays them out.
  // The mocked node is at slot 469,812,667, which is epoch 1087, so a `scheduled` epoch above that has not begun.
  const fee = new Uint8Array(108); const view = new DataView(fee.buffer);
  view.setBigUint64(72, 0n, true); view.setBigUint64(80, 1_000_000n, true); view.setUint16(88, bps, true);
  view.setBigUint64(90, BigInt(scheduled?.epoch ?? 0), true); view.setBigUint64(98, 1_000_000n, true); view.setUint16(106, scheduled?.bps ?? bps, true);
  const key = new Uint8Array(32);
  let n = 0n; for (const ch of delegateKey) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(ch));
  for (let i = 31; i >= 0; i--) { key[i] = Number(n & 0xffn); n >>= 8n; }
  const entries = [[1, fee], [12, key]] as const;
  const tlv = entries.flatMap(([t, b]) => [t, 0, b.length, 0, ...b]);
  const out = new Uint8Array(166 + tlv.length); out[45] = 1; out[165] = 1; out.set(tlv, 166);
  return Buffer.from(out).toString('base64');
};
import { resetDeployerCacheForTest } from '../../packages/runtime/src/deployerHistory';
vi.mock('undici', () => ({
  Agent: class { async close() {} },
  fetch: async (input: unknown, init?: RequestInit) => {
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(input))) {
      const local = { ...init } as RequestInit & { dispatcher?: unknown };
      delete local.dispatcher;
      return globalThis.fetch(String(input), local);
    }
    if (String(input).includes('api.mainnet-beta.solana.com')) {
      if (!chainRead) throw new Error('Unexpected network host');
      const { method } = JSON.parse(String(init?.body));
      rpcMethods.push(method);
      const result = method === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
        : method === 'getAccountInfo' ? { context: { slot: 469_812_667 },
          value: mintAccount && { owner: mintAccount.owner, data: [mintAccount.data, 'base64'], lamports: 1, executable: false } }
        : method === 'getSignaturesForAddress' ? [{ signature: 'newer', err: null }, { signature: 'oldest', err: null }]
        : { blockTime: Math.floor(Date.now() / 1000) - 7200, meta: { err: null, innerInstructions: [] },
          transaction: { message: { accountKeys: [{ pubkey: creator, signer: true }],
            instructions: [{ parsed: { type: 'initializeMint2', info: { mint } } }] } } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    }
    if (!String(input).includes('jup.ag')) throw new Error('Unexpected network host');
    calls++;
    const queried = new URL(String(input)).searchParams.get('query') ?? mint;
    if (unknown) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify([{ id: queried, liquidity, updatedAt: new Date(Date.now() - (stale ? 86400_000 : 0)).toISOString(),
      firstPool: { createdAt: new Date(Date.now() - 3600_000).toISOString() }, ...(chainRead ? { dev: creator } : {}),
      audit: { topHoldersPercentage: 20, mintAuthorityDisabled: true, freezeAuthorityDisabled: false, ...(chainRead ? { devMints: 4 } : {}) } }]), { status: 200 });
  },
}));

beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => { await truncateAll(); await seedCatalogue(); calls = 0; stale = false; unknown = false; liquidity = 12000; chainRead = false; rpcMethods = []; mintAccount = null; resetDeployerCacheForTest();
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
async function ageApprovedCard(jobId: string, opts: { dropExtensions?: boolean; extensionsLaterMs?: number } = {}): Promise<string> {
  const job = await jobs.requireJob(jobId);
  const context = job.resolvedContext as ResolvedContext & { meta: { evidenceCard: { text: string; readings: CardReading[]; cardJobId: string | null; deployer: DeployerHistory | null; extensions?: MintExtensions | null } } };
  const seenAt = Date.now() - 6 * 60_000;
  const stamp = new Date(seenAt).toISOString();
  const readings = context.meta.evidenceCard.readings.map(reading => ({ ...reading, fetchedAt: stamp, observedAt: stamp }));
  const offer = context.meta.evidenceCard.text.split('\n').find(line => line.startsWith('Owner:')) ?? '';
  const before = context.meta.evidenceCard.deployer;
  const aged = before && { ...before, launchesFetchedAt: stamp, launchesObservedAt: stamp };
  const extBefore = opts.dropExtensions ? null : context.meta.evidenceCard.extensions ?? null;
  // The mint read happens after the index reading, so it can carry a later time; the card was rendered once both existed.
  const extLater = opts.extensionsLaterMs ?? 0;
  const agedExt = extBefore && { ...extBefore, fetchedAt: new Date(seenAt + extLater).toISOString() };
  const text = renderEvidenceCard(readings, offer, seenAt + extLater, '', aged, agedExt);
  const resolvedContext = { ...context, meta: { ...context.meta, evidenceCard: { ...context.meta.evidenceCard, text, readings, deployer: aged, extensions: agedExt } } };
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

// The check page link: a separate owner opt-in, built only from the linked Studio, only for a token that was read.
const STUDIO = 'https://studio.example.invalid';
async function linkStudio(origin = STUDIO) {
  await ops.setSetting('plugins.registry.url', origin);
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(newInstallationKey())));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin, linkedAt: new Date().toISOString(), revokedAt: null });
}
async function unlinkStudio() {
  await ops.setSetting('plugins.registry.url', null);
  await ops.setSetting('studio.link', null);
}
const linking = (on: boolean) => ({ tools: { ...DEFAULT_POLICY.tools, evidenceCards: true, evidenceCardLink: on } as typeof DEFAULT_POLICY.tools });

it('ends the card with the linked Studio check page only when the owner opted in, and keeps the inline text', async () => {
  await linkStudio();
  const off = await ask(await fixture(linking(false)), undefined, true);
  expect(off.validatedOutput).toContain('Liquidity: 12000 USD');
  expect(off.validatedOutput).not.toMatch(/https?:/);
  const on = await ask(await fixture(linking(true)), undefined, true);
  const lines = on.validatedOutput!.split('\n');
  expect(lines.at(-1)).toBe(`Full check: ${STUDIO}/check/solana/${mint}`);
  expect(on.validatedOutput).toContain('Liquidity: 12000 USD');
  expect(on.validatedOutput).toContain('not a verdict, reads can be wrong');
  expect(on.validatedOutput!.match(/https?:\/\/\S+/g)).toHaveLength(1);
  expect(on.validatedOutput).not.toMatch(/\b(?:watch|follow|trade)\b.*https?:/i);
  await unlinkStudio();
});

it('produces no link without a Studio link, for a mint that was not read, or when the link would overflow the length policy', async () => {
  await unlinkStudio();
  const unlinked = await ask(await fixture(linking(true)), undefined, true);
  expect(unlinked.validatedOutput).toContain('Liquidity: 12000 USD');
  expect(unlinked.validatedOutput).not.toMatch(/https?:/);
  await linkStudio();
  unknown = true;
  // The ask above still holds this mint in the upstream cache, so a second ask
  // would serve those readings and never see the empty result. Drop the cache so
  // the "not read" mint is actually answered with no data.
  (await import('@xbam/upstream')).resetCacheForTest();
  const unresolved = await ask(await fixture(linking(true)), undefined, true);
  expect(unresolved.validatedOutput).toContain('evidence not found');
  expect(unresolved.validatedOutput).not.toMatch(/https?:/);
  unknown = false;
  // The empty answer above is now cached too, so drop it before the overflow
  // scenario reads the mint again with data present.
  (await import('@xbam/upstream')).resetCacheForTest();
  // Fits without the link, not with it: the card is sent as text, never held for a link.
  const textOnly = (await ask(await fixture(linking(false)), undefined, true)).validatedOutput!;
  const tight = await fixture({ ...linking(true), output: { ...DEFAULT_POLICY.output, maxCharacters: textOnly.length + 10 } });
  const fitted = await ask(tight, undefined, true);
  expect(fitted.status).toBe('DRY_RUN_COMPLETED');
  expect(fitted.validatedOutput!.length).toBeLessThanOrEqual(textOnly.length + 10);
  expect(fitted.validatedOutput).toContain('Liquidity: 12000 USD');
  expect(fitted.validatedOutput).not.toMatch(/https?:/);
  await unlinkStudio();
});

it('holds a queued card for review when its link no longer matches the linked Studio or the owner setting', async () => {
  await linkStudio();
  const f = await fixture(linking(true));
  const job = await ask(f, undefined, true);
  expect(job.validatedOutput).toContain(`${STUDIO}/check/solana/${mint}`);
  // A card pointing at another host, with its text kept consistent, is still refused.
  const context = job.resolvedContext as ResolvedContext & { meta: { evidenceCard: { text: string; link: string } } };
  const evil = 'https://evil.example';
  const text = context.meta.evidenceCard.text.replace(STUDIO, evil);
  const forged = { ...context, meta: { ...context.meta, evidenceCard: { ...context.meta.evidenceCard, text, link: context.meta.evidenceCard.link.replace(STUDIO, evil) } } };
  await jobs.updateJob(job.id, { resolvedContext: forged as ResolvedContext, generatedOutput: text, validatedOutput: text });
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/check page link/);
  // Restore the card, then re-point Studio, then switch the link off.
  await jobs.updateJob(job.id, { resolvedContext: context as ResolvedContext, generatedOutput: context.meta.evidenceCard.text, validatedOutput: context.meta.evidenceCard.text });
  await linkStudio('https://other-studio.example.invalid');
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/check page link/);
  await linkStudio();
  const policy = PolicyConfig.parse((await agents.getActivePolicy(f.agentId))!.config);
  policy.tools.evidenceCardLink = false;
  await agents.savePolicyVersion(f.agentId, policy, 'link off', f.ownerId);
  await expect(stepExecute(await loadJobBundle(await jobs.requireJob(job.id)))).rejects.toThrow(/check page link/);
  await unlinkStudio();
});

it('adds the deployer read from the chain, with sources, and keeps every existing line', async () => {
  chainRead = true;
  const job = await ask(await fixture(), undefined, true);
  const out = job.validatedOutput!;
  expect(out).toMatch(new RegExp(`Deployer \\(creation fee payer\\): ${creator} \\[solana_mainnet\\.official; created \\d{4}-.+; fetched \\d{4}-`));
  expect(out).toMatch(/Launches by this address, index count: 4 \[solana_tokens\.jupiter; fetched \d{4}-/);
  expect(out).toContain('Liquidity: 12000 USD');
  expect(out).toContain('not a verdict, reads can be wrong');
  expect(out).not.toMatch(/\b(?:rug|scam|serial|dev dumped|safe|avoid)\b/i);
  // The mint read runs beside the deployer reads, so only the set of reads is fixed, not their order.
  expect(rpcMethods.filter(m => m !== 'getGenesisHash').sort()).toEqual(['getAccountInfo', 'getSignaturesForAddress', 'getTransaction']);
  expect(await query('SELECT * FROM evidence_card_requests')).toHaveLength(1);
});

it('says unavailable, never zero, when the chain cannot be read, and the rest of the card stands', async () => {
  const job = await ask(await fixture(), undefined, true);
  expect(job.validatedOutput).toContain('Deployer (creation fee payer): unavailable');
  expect(job.validatedOutput).toContain('Launches by this address, index count: unavailable');
  expect(job.validatedOutput).toContain('Liquidity: 12000 USD');
});

it('leaves the deployer lines off rather than holding a card the length policy cannot fit', async () => {
  chainRead = true;
  const roomy = await ask(await fixture(), undefined, true);
  const base = roomy.validatedOutput!.split('\n').filter(l => !/^(Deployer|Launches by)/.test(l)).join('\n');
  const tight = await ask(await fixture({ output: { ...DEFAULT_POLICY.output, maxCharacters: base.length } }), `@agent check ${mint2}`, true);
  expect(tight.status).toBe('DRY_RUN_COMPLETED');
  expect(tight.validatedOutput).not.toContain('Deployer');
  expect(tight.validatedOutput).toContain('Liquidity:');
});

const DELEGATE = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

it('adds the Token-2022 transfer fee and delegate read from the mint account, and the validator lets the exact lines through', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(500, DELEGATE) };
  const job = await ask(await fixture(), undefined, true);
  const out = job.validatedOutput!;
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  expect(out).toMatch(/Token-2022: extensions read \[solana_mainnet\.official; fetched \d{4}-/);
  expect(out).toContain('transfer fee: 500 bps (5%)');
  expect(out).toContain('transfer fee cap: 1000000 base units');
  expect(out).toContain(`permanent delegate: ${DELEGATE}`);
  expect(out).toContain('transfer hook: none');
  // It sits before the disclaimer, and every earlier line is still there.
  expect(out.indexOf('transfer fee: 500')).toBeLessThan(out.indexOf('not a verdict, reads can be wrong'));
  expect(out).toContain('Liquidity: 12000 USD');
  expect(out).not.toMatch(/honeypot|scam|\brug\b|\bsafe\b|avoid/i);
  expect(rpcMethods.filter(m => m === 'getAccountInfo')).toHaveLength(1);
});

it('says the original Token program has no extensions, and unread when the mint cannot be read, never zero bps', async () => {
  chainRead = true;
  const base = new Uint8Array(82); base[45] = 1;
  mintAccount = { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: Buffer.from(base).toString('base64') };
  const plain = await ask(await fixture(), undefined, true);
  expect(plain.validatedOutput).toMatch(/Token-2022: not applicable \(SPL Token\) \[solana_mainnet\.official/);
  mintAccount = null;
  const missing = await ask(await fixture(), `@agent check ${mint2}`, true);
  expect(missing.validatedOutput).toContain('Token-2022: extensions unread');
  expect(missing.validatedOutput).not.toMatch(/\bbps\b/);
  expect(missing.validatedOutput).toContain('Liquidity: 12000 USD');
});

it('sends an approved card with extension lines after its readings expire when the fresh read has the same fee', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(500, DELEGATE) };
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const waiting = await ask(f);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  const approved = await ageApprovedCard(waiting.id);
  expect(approved).toContain('transfer fee: 500 bps (5%)');
  (await import('@xbam/upstream')).resetCacheForTest();
  await runtime.approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
  await drainJobs();
  expect((await jobs.requireJob(waiting.id)).status).toBe('EXECUTED');
});

it('holds an approved card for review when the fee changed since the owner looked', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(500, DELEGATE) };
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const waiting = await ask(f);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  await ageApprovedCard(waiting.id);
  mintAccount = { owner: TOKEN_2022, data: feeMint(9900, DELEGATE) };
  (await import('@xbam/upstream')).resetCacheForTest();
  await runtime.approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
  await drainJobs();
  const held = await jobs.requireJob(waiting.id);
  expect(held.status).not.toBe('EXECUTED');
  expect((await actions.listJobActions(waiting.id)).filter(a => !a.dryRun && a.status === 'EXECUTED')).toHaveLength(0);
});

it('shows a fee scheduled for a later epoch as its own line and never as the current fee', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(100, DELEGATE, { epoch: 1100, bps: 9900 }) };
  const out = (await ask(await fixture(), undefined, true)).validatedOutput!;
  expect(out).toContain('transfer fee: 100 bps (1%)');
  expect(out).toContain('transfer fee scheduled: 9900 bps (99%), cap 1000000 base units, from epoch 1100');
  expect(out).not.toContain('transfer fee: 9900');
});

it('holds an approved card for review when a fee change was scheduled since the owner looked', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(100, DELEGATE) };
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const waiting = await ask(f);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  await ageApprovedCard(waiting.id);
  // The fee in effect is unchanged; only a pending change appeared.
  mintAccount = { owner: TOKEN_2022, data: feeMint(100, DELEGATE, { epoch: 1100, bps: 9900 }) };
  (await import('@xbam/upstream')).resetCacheForTest();
  await runtime.approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
  await drainJobs();
  expect((await jobs.requireJob(waiting.id)).status).not.toBe('EXECUTED');
  expect((await actions.listJobActions(waiting.id)).filter(a => !a.dryRun && a.status === 'EXECUTED')).toHaveLength(0);
});

it('does not hold an approved card that never carried extension lines because a fresh read now has some', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(500, DELEGATE) };
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const waiting = await ask(f);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  const approved = await ageApprovedCard(waiting.id, { dropExtensions: true });
  expect(approved).not.toContain('Token-2022');
  (await import('@xbam/upstream')).resetCacheForTest();
  await runtime.approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
  await drainJobs();
  expect((await jobs.requireJob(waiting.id)).status).toBe('EXECUTED');
});

it('still matches the stored card when the mint read came more than thirty seconds after the index reading', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(500, DELEGATE) };
  const f = await fixture({ automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } });
  const waiting = await ask(f);
  expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
  const approved = await ageApprovedCard(waiting.id, { extensionsLaterMs: 90_000 });
  expect(approved).toContain('transfer fee: 500 bps (5%)');
  (await import('@xbam/upstream')).resetCacheForTest();
  await runtime.approveJob({ jobId: waiting.id, decidedBy: f.ownerId });
  await drainJobs();
  expect((await jobs.requireJob(waiting.id)).status).toBe('EXECUTED');
});

it('leaves the Token-2022 lines off last, after the link and the deployer, rather than holding a card the length policy cannot fit', async () => {
  chainRead = true;
  mintAccount = { owner: TOKEN_2022, data: feeMint(500, DELEGATE) };
  const roomy = await ask(await fixture(), undefined, true);
  const base = roomy.validatedOutput!.split('\n').filter(l => !/^(Deployer|Launches by|Token-2022|transfer fee|permanent delegate|transfer hook)/.test(l)).join('\n');
  const tight = await ask(await fixture({ output: { ...DEFAULT_POLICY.output, maxCharacters: base.length } }), `@agent check ${mint2}`, true);
  expect(tight.status).toBe('DRY_RUN_COMPLETED');
  expect(tight.validatedOutput).not.toContain('Token-2022');
  expect(tight.validatedOutput).toContain('Liquidity:');
});
