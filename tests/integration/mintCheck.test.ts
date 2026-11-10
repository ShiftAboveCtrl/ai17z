import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "@agent check <mint>", through the whole pipeline on the mock channel.
 *
 * The network is the one thing replaced: `undici` answers from a table, so the
 * real Jupiter family, the real capability, the real permission check and the
 * real invocation record all run. Nothing here can reach the X adapter, which
 * is why every request arrives as a mock-channel mention.
 */
let replies: Record<string, { status?: number; body: string }> = {};
let requested: string[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    requested.push(url);
    const key = Object.keys(replies)
      .filter((candidate) => url.includes(candidate))
      .sort((a, b) => b.length - a.length)[0];
    const reply = key ? replies[key]! : { status: 404, body: '{}' };
    return new Response(reply.body, { status: reply.status ?? 200, headers: new Headers({ 'content-type': 'application/json' }) });
  },
}));

import { z } from 'zod';
import { accounts as accountsRepo, actions as actionsRepo, capabilityInvocations, jobs as jobsRepo, mintChecks, notifications, observability, query, radar } from '@xbam/database';
import { DEFAULT_POLICY, EasySetup, PolicyConfig } from '@xbam/shared/contracts';
import { defineCapability, registerCapability, resetCapabilitiesForTest } from '@xbam/tools';
import {
  registerJupiterUpstreams,
  resetBreakerForTest,
  resetCacheForTest,
  resetLimiterForTest,
  resetUpstreamsForTest,
} from '@xbam/upstream';
import { mockAdapter } from '@xbam/channels';
import * as runtime from '@xbam/runtime';
import { createFixture } from '../support/fixtures';
import { installHarness, mockEvent } from '../support/harness';
import { drainJobs } from '../support/runner';

installHarness();

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const EVM = '0x2222222222222222222222222222222222222222';

function record(mint: string, over: Record<string, unknown> = {}) {
  return {
    id: mint,
    name: 'Token',
    symbol: 'TKN',
    decimals: 6,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    firstPool: { id: 'p', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 41.04 },
    liquidity: 52_100,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function serve(mint: string, body: unknown = [record(mint)], status = 200) {
  replies[`/tokens/v2/search?query=${mint}`] = { status, body: JSON.stringify(body) };
}
const readsOf = (mint: string) => requested.filter((url) => url.includes(`/tokens/v2/search?query=${mint}`)).length;

/** The shape `token.inspect_risk` returns, standing in for its two paid-for services. */
function registerFakeRiskInspect(output: Record<string, unknown>, onRun: () => void = () => undefined) {
  registerCapability(
    defineCapability({
      id: 'token.inspect_risk',
      name: 'What security services observe about a token',
      description: 'A stand-in with the real output shape.',
      category: 'READ',
      effect: 'READ',
      risk: 'LOW',
      input: z.object({ chain: z.string(), address: z.string() }),
      output: z.looseObject({ observations: z.array(z.unknown()), notChecked: z.array(z.string()), sourcesAnswering: z.number() }),
      modelCallable: true,
      timeoutMs: 5_000,
      async run() {
        onRun();
        return output as never;
      },
    }),
  );
}

/** Both services answering just now, which is what the real capability reports. */
function freshReadings(known: string[] = ['More can be minted']) {
  const readAt = new Date().toISOString();
  return {
    analysis: { source: 'token_security.goplus', readAt, found: true, known },
    simulation: { source: 'token_tradeable.honeypotis', readAt },
  };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerJupiterUpstreams();
  runtime.registerMarketIntelCapabilities();
  replies = {};
  requested = [];
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
  vi.restoreAllMocks();
});

/** The policy Easy Mode produces with its control on, which is the only way most owners reach this. */
function easyPolicy(over: Partial<PolicyConfig['tools']['mintCheck']> = {}, engagement: Partial<PolicyConfig['engagement']> = {}): PolicyConfig {
  const base = toPolicyFromEasy(true);
  return PolicyConfig.parse({
    ...base,
    tools: { ...base.tools, mintCheck: { ...base.tools.mintCheck, ...over } },
    engagement: { ...base.engagement, strategy: 'ALWAYS_REPLY', maxRepliesPerPersonPerHour: 50, maxRepliesPerThread: 20, maxThreadDepth: 50, ...engagement },
    automation: { ...base.automation, mode: 'AUTONOMOUS' },
    // The fixture agent's open rate, so a second action in one test is not held
    // back by the default spacing between actions. Rate has its own tests.
    rate: { ...base.rate, minSecondsBetweenActions: 0, maxActionsPerHour: 0, maxActionsPerDay: 0 },
  });
}
function toPolicyFromEasy(mintCheck: boolean): PolicyConfig {
  return runtime.toPolicy(EasySetup.parse({ character: { name: 'Ada' }, replies: { mintCheck }, operation: 'AUTOMATIC' }), DEFAULT_POLICY);
}

async function ask(
  agentId: string,
  text: string,
  who = 'alice',
  extra: { dryRun?: boolean; type?: 'MENTION' | 'KEYWORD_MATCH' } = {},
) {
  const outcome = await runtime.ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: agentId,
    ...(extra.dryRun === undefined ? {} : { dryRun: extra.dryRun }),
    event: mockEvent(text, {
      remoteAuthorHandle: who,
      remoteAuthorId: `mock-user-${who}`,
      type: extra.type ?? 'MENTION',
    }),
  });
  await drainJobs();
  const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
  const actions = await actionsRepo.listJobActions(job.id);
  const sent = actions.find((a) => a.status === 'EXECUTED' && !a.dryRun) ?? null;
  const trace = await observability.listTrace(job.id);
  const modelCalls = Number((await query<{ n: string }>('SELECT count(*)::text AS n FROM model_calls WHERE job_id = $1', [job.id]))[0]!.n);
  return { job, sent, text: sent ? String(sent.payload.text ?? '') : null, trace, modelCalls, actions };
}

const decided = (r: { trace: { type: string; message: string }[] }) => r.trace.find((t) => t.type === 'ENGAGEMENT_DECIDED')?.message ?? '';
const FORBIDDEN = /\b(?:safe|unsafe|rug|scam|buy|sell|bullish|bearish|moon|price|legit)\b/i;

describe('off until the owner turns it on', () => {
  it('reads nothing and answers like any other mention', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: { tools: DEFAULT_POLICY.tools } });
    const r = await ask(fixture.agentId, `@agent check ${BONK}`);

    // The mock model echoes the address back, which the validator rightly sends
    // to review, so the status is not the point here: the ordinary path ran.
    expect(r.modelCalls).toBeGreaterThan(0);
    expect(requested).toEqual([]);
    expect(await mintChecks.forJob(r.job.id)).toBeNull();
    expect(r.job.validatedOutput ?? '').not.toContain('Not a verdict');
    expect(r.text ?? '').not.toContain('Not a verdict');
  });

  it('is what the Easy Mode control switches on, and nothing else does', () => {
    expect(toPolicyFromEasy(true).tools.mintCheck.enabled).toBe(true);
    expect(toPolicyFromEasy(false).tools.mintCheck.enabled).toBe(false);
  });
});

describe('the card', () => {
  it('is fixed text from the evidence read, with no model call, and is what is sent', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `@agent check ${BONK}`);

    expect(r.job.status).toBe('EXECUTED');
    expect(r.modelCalls).toBe(0);
    expect(r.text).toMatch(/^Evidence:\nLiquidity: \$52\.1K \(Jupiter \d\d:\d\dZ\)\nTop holders: 41% of supply \(Jupiter \d\d:\d\dZ\)\nMint authority: disabled \(Jupiter \d\d:\d\dZ\)\nFreeze authority: still set \(Jupiter \d\d:\d\dZ\)\nFirst pool: 3d ago \(Jupiter \d\d:\d\dZ\)\nNot a verdict\. Reads can be wrong or late\.$/);
    expect(r.text).not.toMatch(FORBIDDEN);
    expect(r.job.validatedOutput).toBe(r.text);
    expect(readsOf(BONK)).toBe(1);

    // The audit trail says what was read for it.
    const invocations = await capabilityInvocations.listForJob(r.job.id);
    expect(invocations.map((i) => i.capabilityId)).toEqual(['token.solana_profile']);
    expect(invocations[0]!.outcome).toBe('SUCCEEDED');
    expect((await mintChecks.forJob(r.job.id))!.outcome).toBe('CARD');
  });

  it('tells the owner a card went out and how to confirm a watch, and watches nothing yet', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `@agent check ${BONK}`);
    const row = (await mintChecks.forJob(r.job.id))!;

    const open = (await notifications.listOpen()).filter((n) => n.kind === 'MINT_CHECK_ANSWERED');
    expect(open).toHaveLength(1);
    expect(open[0]!.body).toContain(`/watch ${row.id.slice(0, 8)}`);
    expect(open[0]!.body).toContain('Nothing is watched until you do.');
    expect(row.watchState).toBeNull();
    expect(await query('SELECT id FROM radar_sources')).toHaveLength(0);
  });

  it('says what could not be read as unavailable when the source fails, and never as clear', async () => {
    serve(BONK, {}, 500);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `@agent check ${BONK}`);

    expect(r.job.status).toBe('EXECUTED');
    expect(r.text).toMatch(/^Evidence unavailable right now: the source did not answer \(Jupiter \d\d:\d\dZ\)\. Try again shortly\. Not a verdict\./);
    expect(r.text).not.toMatch(FORBIDDEN);
    const invocations = await capabilityInvocations.listForJob(r.job.id);
    expect(invocations[0]!.outcome).not.toBe('SUCCEEDED');
  });

  it('says a token the index does not hold is not found, and that this proves nothing', async () => {
    serve(BONK, []);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `@agent check ${BONK}`);
    expect(r.text).toMatch(/^Not found in the token index \(Jupiter \d\d:\d\dZ\)\. That says nothing about the token either way\. Not a verdict\./);
  });

  it('reads an EVM contract through token.inspect_risk once the chain is named', async () => {
    runtime.registerTokenRiskCapabilities();
    resetCapabilitiesForTest();
    registerFakeRiskInspect({
      observations: [
        { what: 'Holders', detail: '1,204', source: 'contract analysis', kind: 'FACT' },
        { what: 'Sell tax', detail: '15%', source: 'contract analysis', kind: 'FLAG' },
      ],
      notChecked: [],
      sourcesAnswering: 2,
      ...freshReadings(),
    });
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `check ${EVM} on base`);

    expect(r.text).toContain('Holders: 1,204 (GoPlus ');
    expect(r.text).toContain('Exit tax: 15% (GoPlus ');
    expect(r.text).toContain('Supply: cannot be increased');
    expect(r.text).toContain('Creator holds: unavailable');
    expect(r.text).not.toMatch(FORBIDDEN);
    expect((await capabilityInvocations.listForJob(r.job.id)).map((i) => i.capabilityId)).toEqual(['token.inspect_risk']);
    expect(requested).toEqual([]);
  });
});

describe('what it refuses to guess', () => {
  it.each([
    ['two addresses', `check ${BONK} and ${USDC}`, /^I read one token at a time, so send a single address\.$/],
    ['a bare ticker', 'check $BONK please', /^A ticker can belong to many tokens, so send the exact address and I will read it\.$/],
    ['a 0x address with no chain', `check ${EVM}`, /^I need the chain for that 0x address, for example base or ethereum\.$/],
  ])('answers %s in one sentence and reads nothing', async (_name, text, expected) => {
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, text);

    expect(r.job.status).toBe('EXECUTED');
    expect(r.text).toMatch(expected);
    expect(r.modelCalls).toBe(0);
    expect(requested).toEqual([]);
    expect((await mintChecks.forJob(r.job.id))!.outcome).toBe('REFUSED');
    expect(await capabilityInvocations.listForJob(r.job.id)).toHaveLength(0);
  });
});

describe('the limits', () => {
  it('reads once and points the next four askers at the first card', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const answers = [];
    for (const who of ['alice', 'bob', 'carol', 'dave', 'erin']) answers.push(await ask(fixture.agentId, `@agent check ${BONK}`, who));

    expect(readsOf(BONK)).toBe(1);
    expect(answers[0]!.text).toContain('Liquidity:');
    for (const pointer of answers.slice(1)) {
      expect(pointer.job.status).toBe('EXECUTED');
      expect(pointer.text).toMatch(/^Already read that address \d+ min ago, the evidence card is (?:in my earlier reply|here: \S+)\.$/);
      expect(pointer.text).not.toContain('Liquidity');
      expect(pointer.modelCalls).toBe(0);
    }
    const rows = await query<{ outcome: string }>('SELECT outcome FROM mint_check_requests ORDER BY created_at');
    expect(rows.map((r) => r.outcome)).toEqual(['CARD', 'POINTER', 'POINTER', 'POINTER', 'POINTER']);
  });

  it('reads again once the cooldown has passed', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy({ mintCooldownSeconds: 30 }) });
    await ask(fixture.agentId, `check ${BONK}`, 'alice');
    await query(`UPDATE mint_check_requests SET created_at = now() - interval '2 minutes'`);
    resetCacheForTest();
    const again = await ask(fixture.agentId, `check ${BONK}`, 'bob');
    expect(again.text).toContain('Liquidity:');
    expect(readsOf(BONK)).toBe(2);
  });

  it('stops one asker at their hourly limit and sends them nothing more', async () => {
    serve(BONK);
    serve(USDC);
    serve(WSOL);
    const fixture = await createFixture({ policy: easyPolicy({ maxPerAskerPerHour: 2 }) });
    const first = await ask(fixture.agentId, `check ${BONK}`, 'mallory');
    const second = await ask(fixture.agentId, `check ${USDC}`, 'mallory');
    const third = await ask(fixture.agentId, `check ${WSOL}`, 'mallory');

    expect(first.job.status).toBe('EXECUTED');
    expect(second.job.status).toBe('EXECUTED');
    expect(third.job.status).toBe('CANCELLED');
    expect(decided(third)).toMatch(/already asked for 2 checks in the last hour/);
    expect(third.sent).toBeNull();
    expect(readsOf(WSOL)).toBe(0);

    // Someone else is unaffected.
    const other = await ask(fixture.agentId, `check ${WSOL}`, 'nina');
    expect(other.job.status).toBe('EXECUTED');
  });

  it('counts a refusal against the hour as well', async () => {
    const fixture = await createFixture({ policy: easyPolicy({ maxPerAskerPerHour: 2 }) });
    await ask(fixture.agentId, `check ${BONK} ${USDC}`, 'mallory');
    await ask(fixture.agentId, 'check $BONK', 'mallory');
    const third = await ask(fixture.agentId, `check ${BONK} ${USDC}`, 'mallory');
    expect(third.job.status).toBe('CANCELLED');
  });

  it('gives a retried job back its first answer instead of a second place', async () => {
    const fixture = await createFixture({ policy: easyPolicy({ maxPerAskerPerHour: 1 }) });
    const r = await ask(fixture.agentId, `check ${BONK} ${USDC}`, 'mallory');
    const again = await mintChecks.claim({
      agentId: fixture.agentId,
      jobId: r.job.id,
      channel: 'mock',
      askerKey: 'mock:mock-user-mallory',
      askerHandle: 'mallory',
      mint: null,
      chain: null,
      askerCap: 1,
      cooldownMs: 300_000,
    });
    expect(again.capped).toBe(false);
    expect((await query('SELECT id FROM mint_check_requests'))).toHaveLength(1);
  });

  it('still obeys the exchange limits, which no request buys its way past', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy({}, { maxRepliesPerPersonPerHour: 1 }) });
    const first = await ask(fixture.agentId, `check ${BONK}`, 'oscar');
    const second = await ask(fixture.agentId, `check ${BONK}`, 'oscar');
    expect(first.job.status).toBe('EXECUTED');
    expect(second.job.status).toBe('CANCELLED');
    expect(decided(second)).toMatch(/limit for one person/);
  });
});

/** Takes a job's place without running the pipeline, so its state can be set by hand. */
async function queued(agentId: string, text: string, who: string) {
  const outcome = await runtime.ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: agentId,
    event: mockEvent(text, { remoteAuthorHandle: who, remoteAuthorId: `mock-user-${who}`, type: 'MENTION' }),
  });
  return outcome.jobs[0]!.job;
}

function claimFor(agentId: string, jobId: string, mint: string | null, chain: string | null, who = 'asker', cooldownMs = 300_000) {
  return mintChecks.claim({ agentId, jobId, channel: 'mock', askerKey: `mock:${who}`, askerHandle: who, mint, chain, askerCap: 50, cooldownMs });
}

/** Leaves the job with an executed, non-rehearsal action: the card really went out. */
async function publish(job: { id: string; agentId: string; accountId: string | null; actionType: string }) {
  const claim = await actionsRepo.claimAction({
    jobId: job.id,
    agentId: job.agentId,
    accountId: job.accountId,
    channel: 'mock',
    type: job.actionType as never,
    dryRun: false,
    idempotencyKey: `test:${job.id}`,
    payload: { text: 'card', targetRef: null },
    targetRef: null,
  });
  await actionsRepo.completeAction(claim.action.id, { status: 'EXECUTED', remoteActionId: 'remote-1', remoteActionUrl: 'https://example.invalid/status/1' });
  await jobsRepo.updateJob(job.id, { status: 'EXECUTED' });
}

describe('only a card that really went out can be pointed at', () => {
  // The review finding: a card held for the owner (or still being sent) counted as
  // an earlier card, so the next asker was pointed at a reply that never publishes.
  it('reads for itself when the earlier card is held for the owner, rather than pointing at it', async () => {
    serve(BONK);
    const policy = easyPolicy();
    const fixture = await createFixture({ policy: { ...policy, automation: { ...policy.automation, mode: 'REVIEW_BEFORE_ACTION' } } });
    const first = await ask(fixture.agentId, `check ${BONK}`, 'alice');
    const second = await ask(fixture.agentId, `check ${BONK}`, 'bob');

    expect(first.job.status).toBe('WAITING_FOR_APPROVAL');
    expect(second.job.validatedOutput).toContain('Liquidity:');
    expect(second.job.validatedOutput).not.toContain('Already read that address');
    const rows = await query<{ outcome: string }>('SELECT outcome FROM mint_check_requests ORDER BY created_at');
    expect(rows.map((r) => r.outcome)).toEqual(['CARD', 'CARD']);
  });

  it('asks the next request to wait while the earlier card is still being sent, and spends nothing on the wait', async () => {
    const fixture = await createFixture({ policy: easyPolicy() });
    const first = await queued(fixture.agentId, `check ${BONK}`, 'alice');
    const second = await queued(fixture.agentId, `check ${BONK}`, 'bob');

    const card = await claimFor(fixture.agentId, first.id, BONK, 'solana', 'alice');
    expect(card).toMatchObject({ capped: false, pending: false });

    const waiting = await claimFor(fixture.agentId, second.id, BONK, 'solana', 'bob');
    expect(waiting).toMatchObject({ capped: false, pending: true });
    expect((waiting as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    // No place was taken, so the asker's hour is untouched and a retry starts clean.
    expect(await mintChecks.forJob(second.id)).toBeNull();
    expect(await mintChecks.askerCountSince(fixture.agentId, 'mock:bob', 3_600_000)).toBe(0);
  });

  it('points at the card once it has been published, with its link', async () => {
    const fixture = await createFixture({ policy: easyPolicy() });
    const first = await queued(fixture.agentId, `check ${BONK}`, 'alice');
    const second = await queued(fixture.agentId, `check ${BONK}`, 'bob');
    await claimFor(fixture.agentId, first.id, BONK, 'solana', 'alice');
    await publish(first);

    const pointed = await claimFor(fixture.agentId, second.id, BONK, 'solana', 'bob');
    expect(pointed).toMatchObject({ capped: false, pending: false, row: { outcome: 'POINTER', pointsTo: (await mintChecks.forJob(first.id))!.id } });
    expect((pointed as { pointer: { url: string } }).pointer.url).toBe('https://example.invalid/status/1');
  });

  it('does not point at a card whose job is parked for review or never sent', async () => {
    const fixture = await createFixture({ policy: easyPolicy() });
    for (const status of ['WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED', 'PERMANENT_FAILURE', 'CANCELLED'] as const) {
      const earlier = await queued(fixture.agentId, `check ${BONK}`, 'alice');
      const later = await queued(fixture.agentId, `check ${BONK}`, 'bob');
      await claimFor(fixture.agentId, earlier.id, BONK, 'solana', 'alice');
      await jobsRepo.updateJob(earlier.id, { status });
      const claim = await claimFor(fixture.agentId, later.id, BONK, 'solana', 'bob');
      expect(claim, status).toMatchObject({ capped: false, pending: false, row: { outcome: 'CARD', pointsTo: null } });
      await query('DELETE FROM mint_check_requests');
    }
  });

  it('does not offer the owner a watch on a card that was never published', async () => {
    const fixture = await createFixture({ policy: easyPolicy() });
    const held = await queued(fixture.agentId, `check ${BONK}`, 'alice');
    await claimFor(fixture.agentId, held.id, BONK, 'solana', 'alice');
    expect(await mintChecks.undecidedCards(null)).toHaveLength(0);
    await publish(held);
    expect(await mintChecks.undecidedCards(null)).toHaveLength(1);
  });
});

describe('the same contract, however it is typed', () => {
  const MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

  function fakeEvm(onRun: () => void) {
    resetCapabilitiesForTest();
    registerFakeRiskInspect(
      { observations: [{ what: 'Holders', detail: '12', source: 'contract analysis', kind: 'FACT' }], notChecked: [], sourcesAnswering: 2, ...freshReadings() },
      onRun,
    );
  }

  // The review finding: the cooldown looked at the address as typed, so a case
  // variant of one contract earned a second card.
  it('answers a case variant of an EVM address with a pointer, from one read', async () => {
    let reads = 0;
    fakeEvm(() => (reads += 1));
    const fixture = await createFixture({ policy: easyPolicy() });
    const first = await ask(fixture.agentId, `check ${MIXED} on base`, 'alice');
    const second = await ask(fixture.agentId, `check ${MIXED.toLowerCase()} on base`, 'bob');

    expect(first.text).toContain('Holders: 12');
    expect(second.text).toMatch(/^Already read that address \d+ min ago/);
    expect(reads).toBe(1);
    const rows = await query<{ outcome: string; mint_key: string }>('SELECT outcome, mint_key FROM mint_check_requests ORDER BY created_at');
    expect(rows.map((r) => r.outcome)).toEqual(['CARD', 'POINTER']);
    expect(new Set(rows.map((r) => r.mint_key))).toEqual(new Set([MIXED.toLowerCase()]));
  });

  // And the mirror: one string on two chains is two contracts.
  it('never points at a card for the same address on another chain', async () => {
    let reads = 0;
    fakeEvm(() => (reads += 1));
    const fixture = await createFixture({ policy: easyPolicy() });
    await ask(fixture.agentId, `check ${MIXED} on base`, 'alice');
    const other = await ask(fixture.agentId, `check ${MIXED} on ethereum`, 'bob');

    expect(other.text).toContain('Holders: 12');
    expect(other.text).not.toContain('Already read that address');
    expect(reads).toBe(2);
    expect((await query<{ outcome: string }>('SELECT outcome FROM mint_check_requests ORDER BY created_at')).map((r) => r.outcome)).toEqual(['CARD', 'CARD']);
  });

  it('keeps a Solana address exactly as written, because its case is part of the value', async () => {
    const fixture = await createFixture({ policy: easyPolicy() });
    const a = await queued(fixture.agentId, `check ${BONK}`, 'alice');
    const b = await queued(fixture.agentId, `check ${BONK}`, 'bob');
    await claimFor(fixture.agentId, a.id, BONK, 'solana', 'alice');
    // Same letters, different case: a different address, so nothing to wait for.
    expect(await claimFor(fixture.agentId, b.id, BONK.toLowerCase(), 'solana', 'bob')).toMatchObject({ pending: false, row: { outcome: 'CARD' } });
  });

  it('computes the same key in the database as the repository looks up', async () => {
    const fixture = await createFixture({ policy: easyPolicy() });
    const evm = await queued(fixture.agentId, `check ${MIXED} on base`, 'alice');
    const sol = await queued(fixture.agentId, `check ${BONK}`, 'bob');
    await claimFor(fixture.agentId, evm.id, MIXED, 'base', 'alice');
    await claimFor(fixture.agentId, sol.id, BONK, 'solana', 'bob');
    const rows = await query<{ mint: string; chain: string; mint_key: string }>('SELECT mint, chain, mint_key FROM mint_check_requests');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.mint_key).toBe(mintChecks.canonicalMint(row.chain, row.mint));
    expect(mintChecks.canonicalMint('base', MIXED)).toBe(MIXED.toLowerCase());
    expect(mintChecks.canonicalMint('solana', BONK)).toBe(BONK);
  });
});

describe('the owner is told only after the card has gone out', () => {
  const open = async () => (await notifications.listOpen()).filter((n) => n.kind === 'MINT_CHECK_ANSWERED');

  // The review finding: the notification was raised when the card was built, so a
  // card waiting for approval (or never approved) already offered a watch on it.
  it('raises nothing while the card waits for approval, and exactly one notice once it is sent', async () => {
    serve(BONK);
    const policy = easyPolicy();
    const fixture = await createFixture({ policy: { ...policy, automation: { ...policy.automation, mode: 'REVIEW_BEFORE_ACTION' } } });
    const held = await ask(fixture.agentId, `check ${BONK}`);
    expect(held.job.status).toBe('WAITING_FOR_APPROVAL');
    expect(await open()).toHaveLength(0);

    const bundle = await runtime.loadJobBundle(await jobsRepo.requireJob(held.job.id));
    await runtime.stepExecute(bundle);
    const row = (await mintChecks.forJob(held.job.id))!;
    const raised = await open();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.body).toContain(`/watch ${row.id.slice(0, 8)}`);

    // A retried execute says it once.
    await runtime.stepExecute(await runtime.loadJobBundle(await jobsRepo.requireJob(held.job.id)));
    expect(await open()).toHaveLength(1);
  });

  describe('when a worker died after the card went out', () => {
    /*
      A worker that dies after X took the card and before the owner was told
      leaves a published card with no notice. Each recovery path has to say it,
      once, because nothing else will. The notice is deleted between the first
      send and the retry to stand for "the worker never got to raise it".
    */
    async function sentCard() {
      serve(BONK);
      const policy = easyPolicy();
      const fixture = await createFixture({ policy: { ...policy, automation: { ...policy.automation, mode: 'REVIEW_BEFORE_ACTION' } } });
      const held = await ask(fixture.agentId, `check ${BONK}`);
      expect(held.job.status).toBe('WAITING_FOR_APPROVAL');
      const run = async () => runtime.stepExecute(await runtime.loadJobBundle(await jobsRepo.requireJob(held.job.id)));
      await run();
      expect(await open()).toHaveLength(1);
      const lostNotice = () => query(`DELETE FROM notifications WHERE kind = 'MINT_CHECK_ANSWERED'`);
      await lostNotice();
      expect(await open()).toHaveLength(0);
      return { fixture, held, run, lostNotice };
    }

    it('says it when the retry finds the same job\'s action already carrying the text', async () => {
      const { run } = await sentCard();
      await run();
      expect(await open()).toHaveLength(1);
      await run();
      expect(await open()).toHaveLength(1);
    });

    it('says it when the retry finds the action already executed', async () => {
      const { held, run } = await sentCard();
      // No signature recorded, so the text check cannot catch it and the claim does.
      await query(`UPDATE actions SET content_signature = NULL WHERE job_id = $1`, [held.job.id]);
      await run();
      expect(await open()).toHaveLength(1);
      await run();
      expect(await open()).toHaveLength(1);
    });

    it('says it when the action was left EXECUTING and the remote confirms it was sent', async () => {
      const { held, run } = await sentCard();
      await query(`ALTER TABLE actions DISABLE TRIGGER actions_set_updated_at`);
      await query(
        `UPDATE actions SET status = 'EXECUTING', content_signature = NULL, updated_at = now() - interval '30 minutes' WHERE job_id = $1`,
        [held.job.id],
      );
      await query(`ALTER TABLE actions ENABLE TRIGGER actions_set_updated_at`);

      const adapter = mockAdapter as { wasAlreadyDone?: unknown };
      adapter.wasAlreadyDone = async () => ({ done: true, conclusive: true, remoteActionId: 'mock-1', remoteActionUrl: 'mock://message/mock-1', detail: 'Found it.' });
      try {
        await run();
        expect(await open()).toHaveLength(1);
        expect((await actionsRepo.listJobActions(held.job.id)).filter((a) => a.status === 'EXECUTED')).toHaveLength(1);
        // Recovered, so it is executed now and a further retry still says it once.
        await run();
        expect(await open()).toHaveLength(1);
      } finally {
        delete adapter.wasAlreadyDone;
      }
    });

    it('says nothing when the matching text was sent by a different job', async () => {
      const { fixture, held, run } = await sentCard();
      // The text is on record for the agent, but this job never sent it, so there
      // is no evidence that this request's card reached anyone.
      const other = await queued(fixture.agentId, 'a different request', 'bob');
      await query(`UPDATE actions SET job_id = $2 WHERE job_id = $1`, [held.job.id, other.id]);
      await run();
      expect(await open()).toHaveLength(0);
    });

    it('says nothing when the remote says the earlier attempt never arrived, until the resend succeeds', async () => {
      const { held, run } = await sentCard();
      await query(`ALTER TABLE actions DISABLE TRIGGER actions_set_updated_at`);
      await query(
        `UPDATE actions SET status = 'EXECUTING', content_signature = NULL, updated_at = now() - interval '30 minutes' WHERE job_id = $1`,
        [held.job.id],
      );
      await query(`ALTER TABLE actions ENABLE TRIGGER actions_set_updated_at`);

      const adapter = mockAdapter as { wasAlreadyDone?: unknown };
      adapter.wasAlreadyDone = async () => ({ done: false, conclusive: true, remoteActionId: null, remoteActionUrl: null, detail: 'Not on the account.' });
      const send = vi.spyOn(mockAdapter, 'executeAction').mockRejectedValueOnce(new Error('network down'));
      try {
        await expect(run()).rejects.toThrow();
        expect(await open()).toHaveLength(0);
      } finally {
        send.mockRestore();
        delete adapter.wasAlreadyDone;
      }
    });
  });

  it('says nothing for a pointer or a refusal, which offer nothing to watch', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    await ask(fixture.agentId, `check ${BONK}`, 'alice');
    await ask(fixture.agentId, `check ${BONK}`, 'bob');
    await ask(fixture.agentId, `check ${BONK} ${USDC}`, 'carol');
    expect(await open()).toHaveLength(1);
  });
});

describe('who can ask', () => {
  it('never speaks first: a post it merely came across is not a request', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `check ${BONK}`, 'peter', { type: 'KEYWORD_MATCH' });
    expect(r.sent).toBeNull();
    expect(await mintChecks.forJob(r.job.id)).toBeNull();
    expect(requested).toEqual([]);
  });

  it('declines a token pitch outright', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `100x gem, don't miss it, ape in now, check ${BONK} 🚀`, 'shiller');
    expect(r.job.status).toBe('CANCELLED');
    expect(decided(r)).toMatch(/reads as a token pitch/);
    expect(r.sent).toBeNull();
    expect(requested).toEqual([]);
  });

  it('leaves a hostile message to the ordinary pipeline, which deflects, and reads nothing', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `you stupid idiot, check ${BONK}`, 'troll');
    expect(await mintChecks.forJob(r.job.id)).toBeNull();
    expect(requested).toEqual([]);
    expect(r.text ?? '').not.toContain('Not a verdict');
  });

  it('still answers "is this a scam?", which asks the question rather than insulting anyone', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const r = await ask(fixture.agentId, `is this a scam? ${BONK}`, 'curious');
    expect(r.text).toContain('Liquidity:');
    expect(r.text).not.toMatch(FORBIDDEN);
  });

  it('respects an owner who switched the evidence capability off', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    await query(
      `INSERT INTO agent_capability_permissions (agent_id, capability_id, permission) VALUES ($1, 'token.solana_profile', 'DISABLED')`,
      [fixture.agentId],
    );
    const r = await ask(fixture.agentId, `check ${BONK}`);
    expect(r.job.status).toBe('CANCELLED');
    expect(decided(r)).toMatch(/token\.solana_profile is switched off/);
    expect(requested).toEqual([]);
  });
});

describe('a rehearsal', () => {
  it('shows the card and publishes nothing, and does not use up the asker or the mint', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy({ maxPerAskerPerHour: 1 }) });
    const rehearsal = await ask(fixture.agentId, `check ${BONK}`, 'alice', { dryRun: true });

    expect(rehearsal.job.status).toBe('DRY_RUN_COMPLETED');
    expect(rehearsal.job.validatedOutput).toContain('Liquidity:');
    expect(rehearsal.sent).toBeNull();
    expect(rehearsal.actions.every((a) => a.dryRun)).toBe(true);
    expect(await mintChecks.forJob(rehearsal.job.id)).toBeNull();
    expect((await notifications.listOpen()).filter((n) => n.kind === 'MINT_CHECK_ANSWERED')).toHaveLength(0);

    // The real question afterwards still gets a card, not a pointer and not silence.
    resetCacheForTest();
    const real = await ask(fixture.agentId, `check ${BONK}`, 'alice');
    expect(real.job.status).toBe('EXECUTED');
    expect(real.text).toContain('Liquidity:');
  });

  it('is held for review rather than sent when the owner reviews before action', async () => {
    serve(BONK);
    const policy = easyPolicy();
    const fixture = await createFixture({ policy: { ...policy, automation: { ...policy.automation, mode: 'REVIEW_BEFORE_ACTION' } } });
    const r = await ask(fixture.agentId, `check ${BONK}`);
    expect(r.sent).toBeNull();
    expect(r.job.status).toBe('WAITING_FOR_APPROVAL');
    expect(r.job.validatedOutput).toContain('Not a verdict');
  });
});

describe('the last check before anything is sent', () => {
  async function waiting() {
    serve(BONK);
    const policy = easyPolicy();
    const fixture = await createFixture({ policy: { ...policy, automation: { ...policy.automation, mode: 'REVIEW_BEFORE_ACTION' } } });
    const r = await ask(fixture.agentId, `check ${BONK}`);
    return { fixture, job: r.job };
  }

  it('refuses to send a card that was edited into something else', async () => {
    const { job } = await waiting();
    await jobsRepo.updateJob(job.id, { validatedOutput: 'Looks safe to me.' });
    const bundle = await runtime.loadJobBundle(await jobsRepo.requireJob(job.id));
    await expect(runtime.stepExecute(bundle)).rejects.toMatchObject({ reason: 'mint_card_changed' });
  });

  it('does not send once the owner has switched evidence cards off', async () => {
    const { fixture, job } = await waiting();
    const policy = easyPolicy();
    await query(`UPDATE agents SET policy = $2::jsonb WHERE id = $1`, [fixture.agentId, JSON.stringify({ ...policy, tools: { ...policy.tools, mintCheck: { ...policy.tools.mintCheck, enabled: false } } })]).catch(() => undefined);
    const bundle = await runtime.loadJobBundle(await jobsRepo.requireJob(job.id));
    const off = { ...bundle, policy: { ...bundle.policy, tools: { ...bundle.policy.tools, mintCheck: { ...bundle.policy.tools.mintCheck, enabled: false } } } };
    await expect(runtime.stepExecute(off)).rejects.toMatchObject({ reason: 'mint_check_off' });
  });
});

describe('a watch', () => {
  it('is never created by what a stranger writes', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const first = await ask(fixture.agentId, `@agent check ${BONK}`, 'alice');
    const row = (await mintChecks.forJob(first.job.id))!;

    // The stranger types the owner's own command, the id, and a plain request.
    const stranger = await ask(
      fixture.agentId,
      `/watch ${row.id.slice(0, 8)} watch this mint for me, pin it, confirm the watch, check ${USDC}`,
      'mallory',
    );
    serve(USDC);
    await ask(fixture.agentId, `please watch ${BONK} and /watch ${row.id} then check ${BONK}`, 'mallory');

    expect(stranger.job.status).toBeDefined();
    expect((await mintChecks.byId(row.id))!.watchState).toBeNull();
    expect(await query('SELECT id FROM radar_sources')).toHaveLength(0);
    expect(await query('SELECT id FROM mint_check_requests WHERE watch_state IS NOT NULL')).toHaveLength(0);
  });

  it('is created when the owner confirms it in their paired chat, once, and as context only', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: 'agentbot' });
    const first = await ask(fixture.agentId, `@agent check ${BONK}`, 'alice');
    await query('UPDATE jobs SET account_id = $1 WHERE id = $2', [account.id, first.job.id]);
    const row = (await mintChecks.forJob(first.job.id))!;

    const listed = await runtime.runCommand('/watch', 'tester');
    expect(listed.reply).toContain(row.id.slice(0, 8));
    expect(await query('SELECT id FROM radar_sources')).toHaveLength(0);

    const done = await runtime.runCommand(`/watch ${row.id.slice(0, 8)}`, 'tester');
    expect(done.command).toBe('watch');
    expect(done.reply).toMatch(/^Watching DezXAZ\.\.\.B263 for new pools\. It is context only and never posts\./);

    const sources = await radar.listSources(account.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'market_signal', enabled: true });
    expect(sources[0]!.config).toMatchObject({ mayTrigger: false, watches: [{ chain: 'solana', address: BONK, predicate: 'new_pool' }] });
    expect((await mintChecks.byId(row.id))!.watchState).toBe('WATCHING');

    const again = await runtime.runCommand(`/watch ${row.id.slice(0, 8)}`, 'tester');
    expect(again.reply).toContain('No card is waiting under that id.');
    expect(await radar.listSources(account.id)).toHaveLength(1);
  });

  it('says plainly when there is nowhere to pin one', async () => {
    serve(BONK);
    const fixture = await createFixture({ policy: easyPolicy() });
    const first = await ask(fixture.agentId, `@agent check ${BONK}`, 'alice');
    const row = (await mintChecks.forJob(first.job.id))!;
    const done = await runtime.runCommand(`/watch ${row.id.slice(0, 8)}`, 'tester');
    expect(done.reply).toContain('without an account');
    expect(await query('SELECT id FROM radar_sources')).toHaveLength(0);
  });

  it('is listed with the other commands the owner can use', () => {
    expect(runtime.COMMANDS.map((c) => c.name)).toContain('watch');
    expect(runtime.helpText()).toContain('/watch');
  });
});
