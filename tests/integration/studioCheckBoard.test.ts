import { beforeEach, expect, it, vi } from 'vitest';
import { agents, query } from '@xbam/database';
import { PolicyConfig } from '@xbam/shared/contracts';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture, type Fixture } from '../support/fixtures';

const studio = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../packages/runtime/src/studioLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/runtime/src/studioLink')>()),
  studioInstallationRequest: studio.request,
}));
import { closedBuckets, proposeMostCheckedPost, sweepCheckContributions, MOST_CHECKED_IDEA_SOURCE } from '../../packages/runtime/src/studioCheckBoard';

installHarness();
const SOL = 'So11111111111111111111111111111111111111112';
const OTHER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const NOW = new Date('2026-11-15T12:30:00.000Z');
let f: Fixture;

async function optIn(contribute: boolean, post = false) {
  const policy = PolicyConfig.parse((await agents.getActivePolicy(f.agentId))!.config);
  policy.studio.contributeChecks = contribute;
  policy.studio.postMostChecked = post;
  await agents.savePolicyVersion(f.agentId, policy, 'opt in', f.ownerId);
}
async function ask(requester: string, address: string, at: string, dryRun = false) {
  const admitted = await ingestNormalizedEvent({ accountId: null, onlyAgentId: f.agentId, event: mockEvent('check one token') });
  const jobId = admitted.jobs[0]!.job.id;
  await query(`INSERT INTO evidence_card_requests(job_id,agent_id,requester,chain,address,dry_run,card_job_id,created_at)
    VALUES($1,$2,$3,'solana',$4,$5,$1,$6)`, [jobId, f.agentId, requester, address, dryRun, at]);
}
beforeEach(async () => { f = await createFixture(); studio.request.mockReset(); });

it('counts distinct askers per mint and hour, once per 24 hours, ignoring dry runs and unknown authors', async () => {
  await ask('x:a', SOL, '2026-11-15T09:05:00Z');
  await ask('x:a', SOL, '2026-11-15T09:20:00Z'); // same asker, same hour
  await ask('x:a', SOL, '2026-11-15T10:20:00Z'); // same asker, later hour: not counted again
  await ask('x:b', SOL, '2026-11-15T09:40:00Z');
  await ask('x:c', SOL, '2026-11-15T09:41:00Z', true); // dry run
  await ask('x:unknown', SOL, '2026-11-15T09:42:00Z'); // not a person
  await ask('x:d', SOL, '2026-11-15T12:10:00Z'); // the current hour is not closed
  await ask('x:a', OTHER, '2026-11-15T10:30:00Z');
  expect(await closedBuckets([f.agentId], NOW)).toEqual([
    { chain: 'solana', mint: SOL, bucket_start: '2026-11-15T09:00:00.000Z', askers: 2 },
    { chain: 'solana', mint: OTHER, bucket_start: '2026-11-15T10:00:00.000Z', askers: 1 },
  ]);
});

it('sends nothing unless the owner opted in', async () => {
  await ask('x:a', SOL, '2026-11-15T09:05:00Z');
  expect(await sweepCheckContributions(NOW)).toEqual({ sent: 0, skipped: 'off' });
  expect(studio.request).not.toHaveBeenCalled();
});

it('sends only mint, bucket and count, records it, and does not resend the same bucket', async () => {
  await optIn(true);
  await ask('x:a', SOL, '2026-11-15T09:05:00Z');
  await ask('x:b', SOL, '2026-11-15T09:06:00Z');
  studio.request.mockResolvedValue({ ok: true, status: 200, body: { protocol: 1, accepted: true }, sentence: '' });
  expect(await sweepCheckContributions(NOW)).toEqual({ sent: 1 });
  const [path, init] = studio.request.mock.calls[0]!;
  expect(path).toBe('/api/v1/installation/check-board/contributions');
  expect(init.json).toEqual({ protocol: 1, contributions: [{ chain: 'solana', mint: SOL, bucket_start: '2026-11-15T09:00:00.000Z', askers: 2 }] });
  expect(JSON.stringify(init.json)).not.toMatch(/x:a|x:b|agent|owner/);
  expect(await query('SELECT askers FROM studio_check_contributions')).toEqual([{ askers: 2 }]);
  await query(`DELETE FROM app_settings WHERE key='studio.check_board.attempt'`);
  expect(await sweepCheckContributions(NOW)).toEqual({ sent: 0, skipped: 'empty' });
});

it('keeps a bucket unsent when Studio does not acknowledge it', async () => {
  await optIn(true);
  await ask('x:a', SOL, '2026-11-15T09:05:00Z');
  studio.request.mockResolvedValue({ ok: false, why: 'Studio could not be reached.' });
  expect((await sweepCheckContributions(NOW)).sent).toBe(0);
  expect(await query('SELECT 1 FROM studio_check_contributions')).toHaveLength(0);
});

it('rejects a ledger row that is not an hour bucket, has no asker or names an unknown chain', async () => {
  const insert = (chain: string, at: string, n: number) => query('INSERT INTO studio_check_contributions(chain,address,bucket_start,askers) VALUES($1,$2,$3,$4)', [chain, 'a', at, n]);
  await expect(insert('solana', '2026-11-15T09:30:00Z', 1)).rejects.toThrow(/check constraint/);
  await expect(insert('solana', '2026-11-15T09:00:00Z', 0)).rejects.toThrow(/check constraint/);
  await expect(insert('dogechain', '2026-11-15T09:00:00Z', 1)).rejects.toThrow(/check constraint/);
});

const board = (askers: number, rows?: unknown[]) => ({ ok: true, status: 200, sentence: '', body: { protocol: 1, generated_at: NOW.toISOString(), window_hours: 24, min_askers: 3,
  rows: rows ?? [{ chain: 'solana', mint: SOL, askers, readings: [] }] } });

it('proposes the digest once a day, only when opted in and Studio answers', async () => {
  studio.request.mockResolvedValue(board(5));
  expect((await proposeMostCheckedPost(f.agentId, NOW)).proposed).toBe(false);
  expect(studio.request).not.toHaveBeenCalled();
  await optIn(false, true);
  expect((await proposeMostCheckedPost(f.agentId, NOW)).proposed).toBe(true);
  expect((await proposeMostCheckedPost(f.agentId, new Date(NOW.getTime() + 4 * 3_600_000))).why).toBe('Already proposed today.');
  const ideas = await query('SELECT source, summary FROM content_ideas WHERE agent_id=$1', [f.agentId]);
  expect(ideas).toHaveLength(1);
  expect(ideas[0]).toMatchObject({ source: MOST_CHECKED_IDEA_SOURCE });
  expect(ideas[0]!.summary).toMatch(/not endorsed/);
});

it('posts nothing when Studio is unreachable or the board is malformed', async () => {
  await optIn(false, true);
  studio.request.mockResolvedValue({ ok: false, why: 'Studio could not be reached.' });
  expect((await proposeMostCheckedPost(f.agentId, NOW)).proposed).toBe(false);
  studio.request.mockResolvedValue({ ok: true, status: 200, sentence: '', body: { protocol: 1, rows: 'nope' } });
  expect((await proposeMostCheckedPost(f.agentId, new Date(NOW.getTime() + 4 * 3_600_000))).proposed).toBe(false);
  expect(await query('SELECT 1 FROM content_ideas WHERE agent_id=$1', [f.agentId])).toHaveLength(0);
});

it('adds no idea for a board with no mint above the floor', async () => {
  await optIn(false, true);
  studio.request.mockResolvedValue(board(5, []));
  expect((await proposeMostCheckedPost(f.agentId, NOW)).why).toMatch(/enough distinct askers/);
});
