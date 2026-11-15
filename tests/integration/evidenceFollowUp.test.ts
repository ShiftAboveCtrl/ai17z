import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { accounts, actions, agents, capabilities, jobs, ops, query, radar } from '@xbam/database';
import { DEFAULT_POLICY, PolicyConfig, type SignalObservation } from '@xbam/shared/contracts';
import { ingestNormalizedEvent } from '@xbam/runtime';
import * as runtime from '@xbam/runtime';
import { sealSecret } from '@xbam/shared';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';
import type { CardReading } from '@xbam/prompts';
import { checkEvidenceFollowUpAtSend, evidenceFollowUpText } from '../../packages/runtime/src/evidenceFollowUp';
import type { FollowUpObservation } from '../../packages/runtime/src/evidenceFollowUpOffer';
import { riskStudioServer } from '../support/riskStudioServer';
import { setupTestDatabase, teardownTestDatabase, truncateAll, uniqueSuffix } from '../support/db';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';

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

let studio: Awaited<ReturnType<typeof riskStudioServer>> | undefined;
const originalOrigin = process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
beforeAll(async () => { await setupTestDatabase(); const r = await import('@xbam/runtime'); await r.bootstrapRuntime(); });
afterAll(teardownTestDatabase);
beforeEach(async () => {
  await truncateAll(); await seedCatalogue();
  const u = await import('@xbam/upstream'); u.resetCacheForTest(); u.resetLimiterForTest(); u.resetBreakerForTest();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await studio?.close(); studio = undefined;
  if (originalOrigin === undefined) delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
  else process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = originalOrigin;
});

let clock = Date.now();
const read = (value: number | null, over: Partial<SignalObservation> = {}): SignalObservation =>
  ({ value, source: 'jupiter', observedAt: new Date(clock += 10).toISOString(), definition: 'Index liquidity in USD; not a safety rating.', ...over });

async function setPolicy(agentId: string, ownerId: string, change: (p: PolicyConfig) => void) {
  const policy = PolicyConfig.parse((await agents.getActivePolicy(agentId))!.config);
  change(policy);
  await agents.savePolicyVersion(agentId, policy, 'test', ownerId);
}

/** A published card, an owner-confirmed liquidity watch on it, and the Studio-run source for that watch. */
async function setup(options: { followUps?: boolean } = {}) {
  const f = await createFixture({ policy: { tools: { ...DEFAULT_POLICY.tools, evidenceCards: true, evidenceFollowUps: options.followUps ?? true } as typeof DEFAULT_POLICY.tools,
    output: { ...DEFAULT_POLICY.output, maxCharacters: 2000 } } });
  const account = await accounts.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: 'agent' });
  await accounts.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accounts.linkAgentAccount({ agentId: f.agentId, accountId: account.id });
  for (const grant of ['READ', 'GENERATE', 'REPLY', 'POST'] as const) await capabilities.grant(f.agentId, account.id, grant);
  await agents.updateAgent(f.agentId, { state: 'ACTIVE' });
  const key = newInstallationKey();
  studio = await riskStudioServer(key);
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
  expect((await runtime.setStudioRiskWatches({ agentId: f.agentId, ownerId: f.ownerId, accountId: account.id, enabled: true })).ok).toBe(true);
  const card = await ask({ ...f, accountId: account.id });
  expect(card.status).toBe('EXECUTED');
  expect(card.validatedOutput).toContain('Liquidity: 12000 USD');
  expect(await runtime.confirmEvidenceRiskWatch({ agentId: f.agentId, ownerId: f.ownerId, jobId: card.id, kind: 'LIQUIDITY_BELOW', threshold: 1000 })).toMatchObject({ ok: true });
  await runtime.syncStudioRiskWatches();
  const [source] = await radar.listSources(account.id);
  expect(source).toMatchObject({ kind: 'market_signal', enabled: true });
  return { ...f, accountId: account.id, card, source: source!, askerEventId: card.eventId };
}
async function ask(f: { agentId: string; accountId: string }, author = 'alice') {
  const id = uniqueSuffix();
  const result = await ingestNormalizedEvent({ accountId: f.accountId, onlyAgentId: f.agentId, dryRun: false,
    event: { channel: 'mock', type: 'MENTION', remoteEventId: id, remoteMessageId: id, remoteAuthorId: author, remoteAuthorHandle: author,
      remoteAuthorDisplayName: author, remoteConversationId: id, parentRemoteMessageId: null, remoteUrl: `mock://${id}`,
      text: `@agent check ${mint}`, occurredAt: new Date().toISOString(), raw: {} } });
  await drainAgentJobs(f.agentId);
  return jobs.requireJob(result.jobs[0]!.job.id);
}
type Setup = Awaited<ReturnType<typeof setup>>;
/** Baseline above the threshold, then a crossing below it. Returns the crossing read. */
async function cross(f: Setup, value = 500, source = f.source) {
  await runtime.pollSignalSource(source, async () => read(5000));
  const after = read(value);
  await runtime.pollSignalSource((await radar.getSource(source.id))!, async () => after);
  return after;
}
const cardReadings = (card: { resolvedContext: unknown }): CardReading[] =>
  (card.resolvedContext as unknown as { meta: { evidenceCard: { readings: CardReading[] } } }).meta.evidenceCard.readings;
const followUps = () => query('SELECT * FROM evidence_followups ORDER BY created_at');

it('is off by default: a confirmed crossing offers nothing until the owner opts in', async () => {
  const f = await setup({ followUps: false });
  await cross(f);
  expect(await followUps()).toHaveLength(0);
  // The owner was still told, which is the ordinary notification.
  expect(await query("SELECT id FROM notifications WHERE kind='STUDIO_RISK_WATCH'")).toHaveLength(1);
  await setPolicy(f.agentId, f.ownerId, p => { p.tools.evidenceFollowUps = true; });
  // Switching it on later does not resurrect a crossing nobody was offered at the time.
  await runtime.processEvidenceFollowUps(f.agentId);
  expect(await followUps()).toHaveLength(0);
});

it('offers one follow-up per card per crossing, however often the same batch or poll repeats', async () => {
  const f = await setup();
  await runtime.pollSignalSource(f.source, async () => read(5000));
  const after = read(500);
  await Promise.all([runtime.pollSignalSource(f.source, async () => after), runtime.pollSignalSource(f.source, async () => after)]);
  await runtime.pollSignalSource((await radar.getSource(f.source.id))!, async () => after);
  const rows = await followUps();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ card_job_id: f.card.id, agent_id: f.agentId, status: 'pending' });
  expect(rows[0]!.observation).toMatchObject({ kind: 'LIQUIDITY_BELOW', mint, now: { value: 500 }, before: { value: 5000 } });
  expect(JSON.stringify(rows[0]!.observation)).not.toMatch(/alice|guidance|verdict/);
  // A later card for the same mint is a pointer to the first, so it has no confirmed watch and never gets one.
  const pointer = await ask({ agentId: f.agentId, accountId: f.accountId }, 'bob');
  expect(pointer.validatedOutput).toContain('Recent evidence');
  await cross(f, 400);
  expect((await query('SELECT DISTINCT card_job_id FROM evidence_followups')).map(r => r.card_job_id)).toEqual([f.card.id]);
});

it('queues one ordinary reply under the asker\'s post and publishes the fixed text, once, across restarts', async () => {
  const f = await setup();
  const after = await cross(f);
  const before = await query('SELECT id FROM jobs');
  await runtime.processEvidenceFollowUps(f.agentId);
  await runtime.processEvidenceFollowUps(f.agentId);
  const [row] = await followUps();
  expect(row).toMatchObject({ status: 'queued' });
  expect(row!.job_id).toBeTruthy();
  expect(await query('SELECT id FROM jobs')).toHaveLength(before.length + 1);
  await drainAgentJobs(f.agentId);
  const job = await jobs.requireJob(row!.job_id as string);
  expect(job.status).toBe('EXECUTED');
  expect(job.actionType).toBe('REPLY');
  const expected = evidenceFollowUpText({ watch: { kind: 'LIQUIDITY_BELOW', threshold: 1000 }, observation: row!.observation as FollowUpObservation, cardReadings: cardReadings(f.card) });
  expect(job.validatedOutput).toBe(expected);
  expect(job.validatedOutput).toContain('Before: 5000 USD (jupiter,');
  expect(job.validatedOutput).toContain('At card: 12000 USD (solana_tokens.jupiter,');
  expect(job.validatedOutput).toContain(`Now: 500 USD (jupiter, ${after.observedAt.slice(0, 16)}Z)`);
  expect(job.validatedOutput).not.toMatch(/\b(?:safe|rug|buy|sell|bullish|prediction)\b/i);
  const sent = (await actions.listJobActions(job.id)).filter(a => a.status === 'EXECUTED' && !a.dryRun);
  expect(sent).toHaveLength(1);
  // The reply goes under the asker's own post: an adapter refuses to answer the agent's own.
  expect(sent[0]!.payload).toMatchObject({ targetRef: (await query('SELECT remote_message_id FROM events WHERE id=$1', [f.askerEventId]))[0]!.remote_message_id });
  await runtime.processEvidenceFollowUps(f.agentId);
  await drainAgentJobs(f.agentId);
  expect((await actions.listJobActions(job.id)).filter(a => a.status === 'EXECUTED')).toHaveLength(1);
  expect(await query("SELECT id FROM jobs WHERE event_id IN (SELECT id FROM events WHERE payload->>'origin'='evidence-follow-up')")).toHaveLength(1);
});

it('rehearses under dry run, publishing nothing and spending none of the daily cap', async () => {
  const f = await setup();
  await setPolicy(f.agentId, f.ownerId, p => { p.automation.dryRunDefault = true; });
  await cross(f);
  await runtime.processEvidenceFollowUps(f.agentId);
  const [row] = await followUps();
  expect(row).toMatchObject({ status: 'rehearsed' });
  await drainAgentJobs(f.agentId);
  const job = await jobs.requireJob(row!.job_id as string);
  expect(job.status).toBe('DRY_RUN_COMPLETED');
  expect(job.dryRun).toBe(true);
  expect((await actions.listJobActions(job.id)).every(a => a.dryRun)).toBe(true);
});

it('stops at the gates: pause, automation off, exchange limits and a reading that is no longer news', async () => {
  const f = await setup();
  await cross(f);
  const [row] = await followUps();
  const reset = () => query("UPDATE evidence_followups SET status='pending', reason=NULL, job_id=NULL, next_attempt_at=now() - interval '1 hour' WHERE id=$1", [row!.id]);
  const stateOf = async () => (await query('SELECT status, reason FROM evidence_followups WHERE id=$1', [row!.id]))[0]!;
  const replyJobs = async () => (await query("SELECT id FROM jobs WHERE event_id IN (SELECT id FROM events WHERE payload->>'origin'='evidence-follow-up')")).length;

  await setPolicy(f.agentId, f.ownerId, p => { p.automation.mode = 'MONITOR_ONLY'; });
  await runtime.processEvidenceFollowUps(f.agentId);
  expect(await stateOf()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/automation is off/i) });
  await setPolicy(f.agentId, f.ownerId, p => { p.automation.mode = 'AUTONOMOUS'; p.engagement.maxRepliesPerPersonPerHour = 1; });
  await reset(); await runtime.processEvidenceFollowUps(f.agentId);
  expect(await stateOf()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/Already answered them/) });
  await setPolicy(f.agentId, f.ownerId, p => { p.engagement.maxRepliesPerPersonPerHour = 50; p.tools.evidenceFollowUps = false; });
  await reset(); await runtime.processEvidenceFollowUps(f.agentId);
  expect(await stateOf()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/switched off/) });
  await setPolicy(f.agentId, f.ownerId, p => { p.tools.evidenceFollowUps = true; });
  await query("UPDATE evidence_followups SET observation = jsonb_set(observation, '{now,observedAt}', to_jsonb($2::text)) WHERE id=$1", [row!.id, new Date(Date.now() - 2 * 3600_000).toISOString()]);
  await reset(); await runtime.processEvidenceFollowUps(f.agentId);
  expect(await stateOf()).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/older than thirty minutes/) });
  expect(await replyJobs()).toBe(0);
});

it('sends nothing while Studio is unreachable or unlinked, at the sweep and again at send', async () => {
  const f = await setup();
  await cross(f);
  const link = (await ops.getSetting('studio.link')) as Record<string, unknown>;
  await ops.setSetting('studio.link', { ...link, revokedAt: new Date().toISOString() });
  await runtime.processEvidenceFollowUps(f.agentId);
  expect((await followUps())[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/Studio/) });
  expect(await query("SELECT id FROM jobs WHERE event_id IN (SELECT id FROM events WHERE payload->>'origin'='evidence-follow-up')")).toHaveLength(0);

  // A job queued while linked, then the link goes before it sends.
  await ops.setSetting('studio.link', link);
  await query("UPDATE evidence_followups SET status='pending', reason=NULL, next_attempt_at=now() - interval '1 hour'");
  await runtime.processEvidenceFollowUps(f.agentId);
  const [row] = await followUps();
  expect(row).toMatchObject({ status: 'queued' });
  await ops.setSetting('studio.link', { ...link, revokedAt: new Date().toISOString() });
  await drainAgentJobs(f.agentId);
  const job = await jobs.requireJob(row!.job_id as string);
  expect(job.status).not.toBe('EXECUTED');
  expect((await actions.listJobActions(job.id)).filter(a => a.status === 'EXECUTED')).toHaveLength(0);
});

it('holds an edited follow-up and refuses one whose reading has aged out', async () => {
  const f = await setup();
  await cross(f);
  await runtime.processEvidenceFollowUps(f.agentId);
  const [row] = await followUps();
  const job = await jobs.requireJob(row!.job_id as string);
  const bundle = await loadJobBundle(job);
  const text = evidenceFollowUpText({ watch: { kind: 'LIQUIDITY_BELOW', threshold: 1000 }, observation: row!.observation as FollowUpObservation,
    cardReadings: cardReadings(f.card) })!;
  await expect(checkEvidenceFollowUpAtSend(bundle, text)).resolves.toBeUndefined();
  // A rewrite that drops a number is never sent.
  await expect(checkEvidenceFollowUpAtSend(bundle, text.replace('Before: 5000 USD', 'Before: it was higher'))).rejects.toThrow(/never sent edited/);
  await query("UPDATE evidence_followups SET observation = jsonb_set(observation, '{now,observedAt}', to_jsonb($2::text)) WHERE id=$1", [row!.id, new Date(Date.now() - 3 * 3600_000).toISOString()]);
  await expect(checkEvidenceFollowUpAtSend(bundle, text)).rejects.toThrow(/history, not news/);
});

it('applies a daily cap of three real follow-ups per agent', async () => {
  const f = await setup();
  await cross(f);
  const [row] = await followUps();
  for (let i = 0; i < 3; i++) {
    await query(`INSERT INTO evidence_followups(card_job_id,agent_id,source_id,observation_id,crossing_key,observation,status,queued_at)
      VALUES($1,$2,$3,$4,$5,$6,'queued',now())`, [f.card.id, f.agentId, f.source.id, `old-${i}`, `old-key-${i}`, row!.observation]);
  }
  await runtime.processEvidenceFollowUps(f.agentId);
  expect((await query('SELECT status, reason FROM evidence_followups WHERE id=$1', [row!.id]))[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/Daily evidence follow-up cap/) });
});
