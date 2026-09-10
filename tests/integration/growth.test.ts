import { describe, expect, it } from 'vitest';
import { NormalizedEvent } from '@xbam/shared/contracts';
import {
  accounts as accountsRepo,
  events as eventsRepo,
  growth as growthRepo,
  postAnalytics,
  query,
  relationships as relationshipsRepo,
  withTransaction,
} from '@xbam/database';
import { bridgesFor, contentSignalsFor, launchesFor, narrativesFor, opportunitiesFor } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The growth screens, against the database they are actually derived from.
 *
 * The judgements are pinned by unit tests, which is where they belong: they are
 * pure and a database proves nothing about them. What is proved here is the
 * other half -- that the SQL these read through returns what the pure functions
 * were designed for. Every one of these queries has a join or a lateral that
 * would silently return nothing, or the wrong thing, and a mock would accept
 * either.
 */

const HOURS = 3_600_000;

async function seedAccount(fixture: { ownerId: string; agentId: string }) {
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `growth_${uniqueSuffix()}`,
  });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    actionType: 'REPLY',
  });
  return account;
}

async function seeEvent(input: {
  accountId: string;
  handle: string;
  text: string;
  agoHours: number;
  conversation?: string;
}) {
  const occurredAt = new Date(Date.now() - input.agoHours * HOURS).toISOString();
  await withTransaction(async (tx) => {
    await eventsRepo.ingestEvent(
      tx,
      input.accountId,
      NormalizedEvent.parse({
        channel: 'x',
        type: 'MENTION',
        remoteEventId: `ev-${uniqueSuffix()}`,
        remoteAuthorHandle: input.handle,
        remoteAuthorDisplayName: input.handle,
        remoteConversationId: input.conversation ?? null,
        text: input.text,
        occurredAt,
      }),
    );
  });
}

/**
 * A job to hang an action off.
 *
 * `actions.job_id` is not null, and deliberately so: every remote action
 * belongs to a durable job, because that is what carries the idempotency key
 * and what a crash is recovered against. So a test that wants an action has to
 * make a real job first.
 */
async function jobFor(agentId: string, text: string): Promise<string> {
  const { ingestNormalizedEvent } = await import('@xbam/runtime');
  const outcome = await ingestNormalizedEvent({
    // Not attached to the account under test: this event exists to give the
    // action a job, and one that turned up in the account's discovered posts
    // would be a candidate the test never meant to create.
    accountId: null,
    onlyAgentId: agentId,
    event: NormalizedEvent.parse({
      channel: 'x',
      type: 'MENTION',
      remoteEventId: `job-ev-${uniqueSuffix()}`,
      remoteAuthorHandle: 'somebody',
      text,
    }),
  });
  return outcome.jobs[0]!.job.id;
}

describe('what the growth screens read', () => {
  it('finds a narrative several accounts are saying, and not one account repeating itself', async () => {
    const fixture = await createFixture();
    const account = await seedAccount(fixture);
    for (let i = 0; i < 14; i += 1) {
      await seeEvent({
        accountId: account.id,
        handle: `voice${i}`,
        text: 'sequencer downtime again this morning',
        agoHours: 1,
      });
    }
    for (let i = 0; i < 6; i += 1) {
      await seeEvent({ accountId: account.id, handle: 'loudone', text: 'restaking restaking restaking', agoHours: 1 });
    }

    const reading = await narrativesFor(account.id, { windowHours: 6 });
    expect(reading.narratives.find((n) => n.term === 'sequencer')).toBeDefined();
    // One account saying a thing twenty times is not a narrative.
    expect(reading.narratives.find((n) => n.term === 'restaking')).toBeUndefined();
  });

  it('groups an address under the ticker it was posted with, and warns when they disagree', async () => {
    const fixture = await createFixture();
    const account = await seedAccount(fixture);
    const a = '0x1111111111111111111111111111111111111111';
    const b = '0x2222222222222222222222222222222222222222';
    await seeEvent({ accountId: account.id, handle: 'alice', text: `$demo is live ${a}`, agoHours: 1 });
    await seeEvent({ accountId: account.id, handle: 'bob', text: `$demo contract ${b}`, agoHours: 1 });

    const { launches } = await launchesFor(account.id);
    const demo = launches.find((launch) => launch.ticker === '$demo');
    expect(demo!.addresses).toHaveLength(2);
    expect(demo!.warnings[0]).toMatch(/2 different addresses/);
    // No price, no liquidity, no volume -- nothing financial is derived here.
    expect(JSON.stringify(demo)).not.toMatch(/price|liquidity|volume/i);
  });

  it('reads published posts with their freshest reading, and keeps unmeasured ones', async () => {
    // A post nobody has measured is still a post the agent published. A query
    // starting from the readings would make it not exist, which turns "we have
    // not looked" into "it got nothing".
    const fixture = await createFixture();
    const account = await seedAccount(fixture);
    const measured = `2100000000000000${Math.floor(Math.random() * 900 + 100)}`;
    const unmeasured = `2100000000000000${Math.floor(Math.random() * 900 + 100)}1`;

    for (const [remoteId, text] of [
      [measured, 'A measured post about something'],
      [unmeasured, 'A post nobody has looked at yet'],
    ] as const) {
      const jobId = await jobFor(fixture.agentId, text);
      await query(
        `INSERT INTO actions (job_id, agent_id, account_id, channel, type, status, dry_run, payload,
                              target_ref, remote_action_id, idempotency_key, executed_at)
         VALUES ($1, $2, $3, 'x', 'POST', 'EXECUTED', false, $4::jsonb, NULL, $5, $6, now())`,
        [jobId, fixture.agentId, account.id, JSON.stringify({ text }), remoteId, `k-${uniqueSuffix()}`],
      );
    }
    await postAnalytics.record({
      agentId: fixture.agentId,
      accountId: account.id,
      remotePostId: measured,
      source: 'TIMELINE',
      impressions: 1_000,
      likes: 30,
    });

    const rows = await postAnalytics.publishedWithReadings(fixture.agentId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.remote_post_id === measured)!.impressions).toBe(1_000);
    expect(rows.find((row) => row.remote_post_id === unmeasured)!.impressions).toBeNull();

    const signals = await contentSignalsFor(fixture.agentId);
    expect(signals.total).toBe(2);
    expect(signals.measured).toBe(1);
    // Two posts is not a finding, and it says so rather than producing one.
    expect(signals.findings).toHaveLength(0);
    expect(signals.gaps.length).toBeGreaterThan(0);
  });

  it('counts who has been seen around whom, and how many of those are already ours', async () => {
    const fixture = await createFixture();
    const account = await seedAccount(fixture);
    // One conversation with three accounts in it.
    for (const handle of ['alice', 'bob', 'carol']) {
      await seeEvent({ accountId: account.id, handle, text: 'in the same thread', agoHours: 1, conversation: 'c1' });
    }
    await relationshipsRepo.recordInteraction({
      agentId: fixture.agentId,
      channel: 'x',
      handle: 'bob',
      displayName: 'Bob',
      direction: 'INBOUND',
    });

    const rows = await growthRepo.neighbourCounts({ agentId: fixture.agentId, accountId: account.id });
    const alice = rows.find((row) => row.handle === 'alice');
    expect(alice!.neighbours).toBe(2);
    // Bob is known; carol is not.
    expect(alice!.neighbours_we_know).toBe(1);
  });

  it('scores a bridge from relationship memory and says what it could not measure', async () => {
    const fixture = await createFixture();
    const account = await seedAccount(fixture);
    await relationshipsRepo.recordInteraction({
      agentId: fixture.agentId,
      channel: 'x',
      handle: 'alice',
      displayName: 'Alice',
      direction: 'INBOUND',
    });

    const [bridge] = await bridgesFor(fixture.agentId, account.id);
    expect(bridge!.handle).toBe('alice');
    // Nobody read a profile, so reach is unknown -- and that is stated rather
    // than scored as if it were zero.
    expect(bridge!.gaps.join(' ')).toMatch(/follow/i);
    expect(bridge!.factors.every((factor) => factor.detail.length > 0)).toBe(true);
  });

  it('declines an off-topic post and says why', async () => {
    const fixture = await createFixture({ persona: { topics: ['rollups'] } });
    const account = await seedAccount(fixture);
    await seeEvent({
      accountId: account.id,
      handle: 'stranger',
      text: 'Made a genuinely excellent omelette this morning and I am still thinking about it',
      agoHours: 1,
    });
    await seeEvent({
      accountId: account.id,
      handle: 'other',
      text: 'the rollups question nobody wants to answer is who runs the sequencer',
      agoHours: 1,
    });

    const verdict = await opportunitiesFor({
      agentId: fixture.agentId,
      accountId: account.id,
      selfHandles: [account.handle],
      topics: ['rollups'],
    });
    expect(verdict.opportunities.map((o) => o.handle)).toEqual(['other']);
    expect(verdict.declined.find((d) => d.handle === 'stranger')!.reason).toBe('off_topic');
  });

  it('leaves alone somebody the agent has just published to', async () => {
    const fixture = await createFixture({ persona: { topics: ['rollups'] } });
    const account = await seedAccount(fixture);
    await seeEvent({
      accountId: account.id,
      handle: 'alice',
      text: 'another rollups thread that is going nowhere good',
      agoHours: 1,
    });
    const jobId = await jobFor(fixture.agentId, 'a rollups thread worth answering');
    await query(
      `INSERT INTO actions (job_id, agent_id, account_id, channel, type, status, dry_run, payload,
                            target_ref, remote_action_id, idempotency_key, executed_at)
       VALUES ($1, $2, $3, 'x', 'REPLY', 'EXECUTED', false, '{}'::jsonb,
               'https://x.com/alice/status/1900000000000000001', '1900000000000000002', $4, now())`,
      [jobId, fixture.agentId, account.id, `k-${uniqueSuffix()}`],
    );

    const verdict = await opportunitiesFor({
      agentId: fixture.agentId,
      accountId: account.id,
      selfHandles: [account.handle],
      topics: ['rollups'],
    });
    expect(verdict.opportunities).toHaveLength(0);
    expect(verdict.declined.find((d) => d.handle === 'alice')!.reason).toBe('already_engaged');
  });
});
