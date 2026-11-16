import { beforeEach, expect, it, vi } from 'vitest';
import { NormalizedEvent, PolicyConfig } from '@xbam/shared/contracts';
import { accounts as accountsRepo, agents, events as eventsRepo, narrativePulseRepo, query, withTransaction } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture, type Fixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

const studio = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../packages/runtime/src/studioLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/runtime/src/studioLink')>()),
  studioInstallationRequest: studio.request,
}));
import { NARRATIVE_PULSE_IDEA_SOURCE, proposeNarrativePulse } from '../../packages/runtime/src/narrativePulse';
import { narrativeWorkFor } from '../../packages/runtime/src/growth';

installHarness();
const SOL = 'So11111111111111111111111111111111111111112';
const NOW = new Date('2026-11-15T12:30:00.000Z');
const HOUR = 3_600_000;
let f: Fixture;
let accountId: string;

async function optIn(post: boolean, contribute = false) {
  const policy = PolicyConfig.parse((await agents.getActivePolicy(f.agentId))!.config);
  policy.studio.postNarrativePulse = post;
  policy.studio.contributeNarrativeTerms = contribute;
  await agents.savePolicyVersion(f.agentId, policy, 'opt in', f.ownerId);
}

/** A post the radar stored for its own work. Nothing here goes near an adapter: it is a row. */
async function seen(handle: string, text: string, hoursAgo: number, authorId: string | null = `id-${handle}`) {
  await withTransaction(async (tx) => {
    await eventsRepo.ingestEvent(tx, accountId, NormalizedEvent.parse({
      channel: 'mock', type: 'MENTION', remoteEventId: `ev-${uniqueSuffix()}`,
      remoteAuthorHandle: handle, remoteAuthorId: authorId, remoteAuthorDisplayName: handle,
      text, occurredAt: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
    }));
  });
}

/**
 * Thirty authors in the window; the first `n` of them say `subject`. Every other word is the author's own
 * and unique, so the only subject several accounts share is the one the test is about.
 */
async function crowd(subject: string, n: number, hoursAgo = 1) {
  for (let i = 0; i < 30; i += 1) {
    const handle = `u${i}h${Math.round(hoursAgo * 10)}`;
    await seen(handle, i < n ? `${handle} ${subject}` : handle, hoursAgo + (i % 3) * 0.1);
  }
}

const checks = (rows: unknown[] | null) => (rows === null
  ? { ok: false, why: 'Studio could not be reached.' }
  : { ok: true, status: 200, sentence: '', body: { protocol: 1, generated_at: NOW.toISOString(), window_hours: 24, min_askers: 3, rows } });

beforeEach(async () => {
  f = await createFixture();
  studio.request.mockReset();
  const account = await accountsRepo.createAccount({ ownerId: f.ownerId, channel: 'mock', handle: `pulse_${uniqueSuffix()}` });
  accountId = account.id;
  await accountsRepo.linkAgentAccount({ agentId: f.agentId, accountId, actionType: 'REPLY' });
});

const ideas = () => query<{ source: string; summary: string; detail: string }>('SELECT source, summary, detail FROM content_ideas WHERE agent_id=$1', [f.agentId]);

it('adds no read: the work is built from stored posts and the Studio call is the only request made', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await optIn(true);
  studio.request.mockResolvedValue(checks([{ chain: 'solana', mint: SOL, askers: 5, readings: [] }]));
  const before = await query<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE account_id=$1', [accountId]);
  const outcome = await proposeNarrativePulse(f.agentId, accountId, NOW);
  expect(outcome).toMatchObject({ proposed: true });
  expect(await query<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE account_id=$1', [accountId])).toEqual(before);
  expect(studio.request).toHaveBeenCalledTimes(1);
  expect(studio.request.mock.calls[0]![0]).toBe('/api/v1/installation/narrative-pulse');
  expect(studio.request.mock.calls[0]![1].method).toBe('GET');
  const [idea] = await ideas();
  expect(idea).toMatchObject({ source: NARRATIVE_PULSE_IDEA_SOURCE });
  expect(idea!.summary).toMatch(/not endorsed/);
  expect(idea!.summary).toMatch(/restaking \d+\.\d% of posts \(n = 8 authors, present\)/);
  expect(idea!.summary).toContain(SOL);
  // No before existed, so nothing may be called rising.
  expect(idea!.summary).not.toMatch(/rising/);
  expect(idea!.summary).not.toMatch(/@/);
});

it('keeps the posts it read beside the reading so a pulse never asks for more', async () => {
  await crowd('restaking', 8);
  const work = await narrativeWorkFor(accountId, { now: NOW, limit: 40 });
  expect(work.posts).toHaveLength(30);
  expect(work.reading.narratives.map((n) => n.term)).toContain('restaking');
});

it('is off by default: nothing is made, Studio is not asked', async () => {
  await crowd('restaking', 8);
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).why).toBe('The narrative pulse is off.');
  expect(studio.request).not.toHaveBeenCalled();
  expect(await ideas()).toHaveLength(0);
});

it('posts the narrative half alone and says the checks half was not read when Studio is unreachable', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await optIn(true);
  studio.request.mockResolvedValue(checks(null));
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).proposed).toBe(true);
  const [idea] = await ideas();
  expect(idea!.summary).toMatch(/The checks half was not read\./);
  expect(idea!.summary).not.toContain(SOL);
});

it('treats a malformed or stale Studio answer as not read', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await optIn(true);
  studio.request.mockResolvedValue({ ok: true, status: 200, sentence: '', body: { protocol: 1, rows: 'nope' } });
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).proposed).toBe(true);
  expect((await ideas())[0]!.summary).toMatch(/checks half was not read/);
});

it('posts nothing when the narrative half is below the floor, even with checks to show', async () => {
  // Thirty posts, but each subject has only two authors: under the distinct author floor.
  await crowd('restaking', 2);
  await optIn(true);
  studio.request.mockResolvedValue(checks([{ chain: 'solana', mint: SOL, askers: 5, readings: [] }]));
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).proposed).toBe(false);
  expect(await ideas()).toHaveLength(0);
  expect(studio.request).not.toHaveBeenCalled();
});

it('posts nothing with too few posts read, and does not read more', async () => {
  for (let i = 0; i < 5; i += 1) await seen(`few${i}`, 'restaking again today', 1);
  await optIn(true);
  const outcome = await proposeNarrativePulse(f.agentId, accountId, NOW);
  expect(outcome.proposed).toBe(false);
  expect(outcome.why).toMatch(/fewest worth drawing anything from/);
  expect(await ideas()).toHaveLength(0);
});

it('leaves out a subject reticence refuses, and one posted in copied wording, before the idea is built', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await crowd('election', 9);
  const copied = 'gm frens the moonrocket token is about to change everything for all of us today';
  for (let i = 0; i < 9; i += 1) await seen(`copy${i}`, copied, 1.2);
  await optIn(true);
  studio.request.mockResolvedValue(checks([]));
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).proposed).toBe(true);
  const [idea] = await ideas();
  expect(idea!.summary).not.toMatch(/election|moonrocket/);
  expect(idea!.detail).toMatch(/subjects were left out because the posts about them used near-identical wording/);
  expect(idea!.detail).not.toMatch(/election|moonrocket/);
});

it('calls a subject rising only with an earlier snapshot, and absent from the snapshot is present', async () => {
  await crowd('restaking', 9);
  await crowd('bridging', 6);
  await optIn(true);
  // Yesterday's snapshot measured restaking at a low share; it did not carry bridging at all.
  await narrativePulseRepo.saveSnapshot({
    agentId: f.agentId, windowEnd: new Date(NOW.getTime() - 24 * HOUR), posts: 40,
    terms: [{ term: 'restaking', share: 0.05, authors: 4 }],
  });
  studio.request.mockResolvedValue(checks([]));
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).proposed).toBe(true);
  const [idea] = await ideas();
  expect(idea!.summary).toMatch(/restaking [\d.]+% of posts \(n = 9 authors, rising, was 5\.0%\)/);
  expect(idea!.summary).toMatch(/bridging [\d.]+% of posts \(n = 6 authors, present\)/);
  // This run left its own snapshot for tomorrow, without any author or text in it.
  const rows = await query<Record<string, unknown>>('SELECT * FROM narrative_pulse_snapshots WHERE agent_id=$1 AND window_end=$2', [f.agentId, NOW.toISOString()]);
  expect(rows.map((r) => r.term).sort()).toEqual(['bridging', 'restaking']);
  expect(Object.keys(rows[0]!).sort()).toEqual(['agent_id', 'authors', 'posts', 'share', 'term', 'window_end']);
});

it('ignores a snapshot that is too recent or too old to be a before', async () => {
  await crowd('restaking', 9);
  await crowd('bridging', 6);
  await optIn(true);
  await narrativePulseRepo.saveSnapshot({ agentId: f.agentId, windowEnd: new Date(NOW.getTime() - 2 * HOUR), posts: 40, terms: [{ term: 'restaking', share: 0.01, authors: 4 }] });
  await narrativePulseRepo.saveSnapshot({ agentId: f.agentId, windowEnd: new Date(NOW.getTime() - 80 * HOUR), posts: 40, terms: [{ term: 'restaking', share: 0.01, authors: 4 }] });
  studio.request.mockResolvedValue(checks([]));
  await proposeNarrativePulse(f.agentId, accountId, NOW);
  expect((await ideas())[0]!.summary).not.toMatch(/rising/);
});

it('proposes once a day and does not ask Studio again within the hour limits', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await optIn(true);
  studio.request.mockResolvedValue(checks([]));
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).proposed).toBe(true);
  expect((await proposeNarrativePulse(f.agentId, accountId, new Date(NOW.getTime() + 4 * HOUR))).why).toBe('Already done today.');
  expect(await ideas()).toHaveLength(1);
  expect(studio.request).toHaveBeenCalledTimes(1);
});

it('sends only term, share, distinct authors and window end, and only when the owner opted in to that', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await optIn(true, false);
  studio.request.mockResolvedValue(checks([]));
  await proposeNarrativePulse(f.agentId, accountId, NOW);
  expect(studio.request.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);

  await query(`DELETE FROM app_settings WHERE key LIKE 'studio.narrative_pulse.%'`);
  await optIn(false, true);
  studio.request.mockReset();
  studio.request.mockResolvedValue({ ok: true, status: 200, body: { protocol: 1, accepted: true }, sentence: '' });
  const outcome = await proposeNarrativePulse(f.agentId, accountId, NOW);
  expect(outcome).toMatchObject({ contributed: true, proposed: false });
  const [path, init] = studio.request.mock.calls[0]!;
  expect(path).toBe('/api/v1/installation/narrative-pulse');
  expect(init.method).toBe('POST');
  expect(init.json.protocol).toBe(1);
  expect(init.json.terms.map((t: { term: string }) => t.term).sort()).toEqual(['bridging', 'restaking']);
  for (const t of init.json.terms) expect(Object.keys(t).sort()).toEqual(['distinctAuthors', 'share', 'term', 'windowEnd']);
  expect(init.json.terms[0].windowEnd).toBe('2026-11-15T12:00:00.000Z');
  expect(JSON.stringify(init.json)).not.toMatch(/u\d+h\d+|id-|agent|owner/);
  // Posting is off now, so contributing added no second idea beyond the one the first half made.
  expect(await ideas()).toHaveLength(1);
});

it('keeps a contribution unsent when Studio does not acknowledge it, and tries again later', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await optIn(false, true);
  studio.request.mockResolvedValue({ ok: false, why: 'Studio could not be reached.' });
  expect((await proposeNarrativePulse(f.agentId, accountId, NOW)).contributed).toBe(false);
  studio.request.mockResolvedValue({ ok: true, status: 200, body: { protocol: 1, accepted: true }, sentence: '' });
  expect((await proposeNarrativePulse(f.agentId, accountId, new Date(NOW.getTime() + 4 * HOUR))).contributed).toBe(true);
});

it('adds the idea as unused, for the posting engine and its gates to decide', async () => {
  await crowd('restaking', 8);
  await crowd('bridging', 6);
  await optIn(true);
  studio.request.mockResolvedValue(checks([]));
  await proposeNarrativePulse(f.agentId, accountId, NOW);
  const rows = await query<{ status: string }>('SELECT status FROM content_ideas WHERE agent_id=$1', [f.agentId]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('unused');
});

it('rejects a snapshot row with a zero share, too few authors or a thin sample', async () => {
  const insert = (share: number, authors: number, posts: number) => query(
    `INSERT INTO narrative_pulse_snapshots(agent_id, window_end, term, share, authors, posts) VALUES($1, now(), 'restaking', $2, $3, $4)`,
    [f.agentId, share, authors, posts]);
  await expect(insert(0, 3, 12)).rejects.toThrow(/check constraint/);
  await expect(insert(0.1, 2, 12)).rejects.toThrow(/check constraint/);
  await expect(insert(0.1, 3, 11)).rejects.toThrow(/check constraint/);
  await insert(0.1, 3, 12);
});
