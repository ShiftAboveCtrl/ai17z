import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  jobs as jobsRepo,
  notifications as notificationsRepo,
  query,
  xCapacity,
} from '@xbam/database';
import { BLUESKY_UNSAFE_DEV_ORIGIN_ENV, resetBlueskySessionsForTest } from '@xbam/channels';
import { collectHealth, connectBlueskyAccount, startPreflight, sweepNotifications } from '@xbam/runtime';
import { ChannelPoller } from '../../apps/worker/src/poller';
import { installHarness } from '../support/harness';
import { createFixture, type Fixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';
import { ALICE, FakeBluesky, ME } from '../support/fakeBluesky';

installHarness();

/**
 * What an owner is told when a Bluesky account stops working, and what the
 * agent does with the things people attach.
 *
 * The same states the X tests cover, in the words they need on a channel that
 * has no browser window to point at.
 */

let fake: FakeBluesky;
let previousOrigin: string | undefined;

beforeAll(async () => {
  fake = await FakeBluesky.start();
  previousOrigin = process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV];
  process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV] = fake.origin;
});

afterAll(async () => {
  if (previousOrigin === undefined) delete process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV];
  else process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV] = previousOrigin;
  await fake.stop();
});

beforeEach(() => {
  resetBlueskySessionsForTest();
  fake.requests.length = 0;
  fake.posts.clear();
  fake.likes.clear();
  fake.notifications = [];
  fake.challenge = false;
  fake.rateLimitNext = 0;
});

async function linked(fixture: Fixture) {
  const { account } = await connectBlueskyAccount({
    ownerId: fixture.ownerId,
    identifier: ME.handle,
    appPassword: ME.password,
    serviceUrl: fake.origin,
  });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  return account;
}

async function pollOnce(accountId: string) {
  await query('UPDATE accounts SET next_poll_at = NULL WHERE id = $1', [accountId]);
  await new ChannelPoller().tick();
}

describe('starting an agent whose Bluesky account has a problem', () => {
  it('has nothing to say about a signed in account', async () => {
    const fixture = await createFixture();
    await linked(fixture);
    const blockers = await startPreflight(fixture.agentId);
    expect(blockers.filter((b) => /bluesky/i.test(b.what))).toEqual([]);
  });

  it('says in plain words that the app password was refused, and what to do', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await accountsRepo.updateAccount(account.id, { status: 'NEEDS_AUTH' });

    const [blocker] = (await startPreflight(fixture.agentId)).filter((b) => /bluesky/i.test(b.what));
    expect(blocker!.what).toMatch(/not signed in/);
    expect(blocker!.what).toMatch(/does not accept the app password/);
    expect(blocker!.fix).toMatch(/Settings, Privacy and security, App passwords/);
    expect(blocker!.where).toBe('account');
    // It is a Bluesky problem. It must not tell anybody to open a browser.
    expect(`${blocker!.what} ${blocker!.fix}`).not.toMatch(/browser|window|session has expired/i);
  });

  it('says a challenge is not something AI17Z answers, and how to avoid it', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await accountsRepo.updateAccount(account.id, { status: 'CHALLENGE_REQUIRES_USER' });

    const [blocker] = (await startPreflight(fixture.agentId)).filter((b) => /bluesky/i.test(b.what));
    expect(blocker!.what).toMatch(/asking for a code it emailed/);
    expect(blocker!.fix).toMatch(/never answers that/);
    expect(blocker!.fix).toMatch(/app password/);
  });

  it('notices a connected account whose stored password has gone', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await query('DELETE FROM account_credentials WHERE account_id = $1', [account.id]);
    const [blocker] = (await startPreflight(fixture.agentId)).filter((b) => /bluesky/i.test(b.what));
    expect(blocker!.what).toMatch(/no app password stored/);
  });

  it('does not ask for a browser worker for a Bluesky account', async () => {
    const fixture = await createFixture();
    await linked(fixture);
    const blockers = await startPreflight(fixture.agentId);
    expect(blockers.filter((b) => b.where === 'worker')).toEqual([]);
  });
});

describe('the Health screen for a Bluesky account', () => {
  it('is healthy when signed in, and does not claim "no session required" when it is not', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);

    const signedIn = (await collectHealth()).components.find((c) => c.name === `bluesky @${ME.handle}`);
    expect(signedIn).toMatchObject({ status: 'healthy' });
    expect(signedIn!.detail).not.toBe('No session required');

    await accountsRepo.updateAccount(account.id, { status: 'NEEDS_AUTH' });
    const lapsed = (await collectHealth()).components.find((c) => c.name === `bluesky @${ME.handle}`);
    expect(lapsed!.status).toBe('degraded');
    expect(lapsed!.detail).toMatch(/does not accept the app password/);
  });
});

/** This account's own open notices; the sweep also raises ones about the worker and the model. */
async function noticesFor(accountId: string) {
  return (await notificationsRepo.listOpen()).filter((n) => n.accountId === accountId);
}

describe('telling the owner', () => {
  it('raises a signed-out notice in Bluesky words, and clears it when the account is well', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await accountsRepo.updateAccount(account.id, { status: 'NEEDS_AUTH', lastHealthStatus: 'poll failed: something technical' });

    await sweepNotifications();
    const [notice] = await noticesFor(account.id);
    expect(notice).toMatchObject({ kind: 'ACCOUNT_SIGNED_OUT', severity: 'CRITICAL' });
    expect(notice!.body).toMatch(/Bluesky does not accept the app password/);
    expect(notice!.body).toMatch(/App passwords/);
    expect(notice!.body).not.toMatch(/something technical/);

    await accountsRepo.updateAccount(account.id, { status: 'CONNECTED' });
    await sweepNotifications();
    expect(await noticesFor(account.id)).toHaveLength(0);
  });

  it('raises a challenge notice that does not point at a browser window that does not exist', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await accountsRepo.updateAccount(account.id, { status: 'CHALLENGE_REQUIRES_USER', challengeKind: 'EMAIL_CODE' });

    await sweepNotifications();
    const [notice] = await noticesFor(account.id);
    expect(notice).toMatchObject({ kind: 'ACCOUNT_NEEDS_USER', severity: 'CRITICAL' });
    expect(notice!.body).toMatch(/asking for a code it emailed/);
    expect(notice!.body).not.toMatch(/browser window is open/i);
  });

  it('keeps X notices as they were', async () => {
    const fixture = await createFixture();
    const x = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'x', handle: 'someone_on_x' });
    await accountsRepo.updateAccount(x.id, { status: 'CHALLENGE_REQUIRES_USER' });
    await sweepNotifications();
    const [notice] = await noticesFor(x.id);
    expect(notice!.body).toMatch(/browser window is open/);
  });
});

describe('a Bluesky account that is slowed down says so in its own words', () => {
  it('names Bluesky in the stored reason', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await pollOnce(account.id);
    fake.rateLimitNext = 1;
    await pollOnce(account.id);

    const [row] = await query<{ health: string; health_reason: string }>('SELECT health, health_reason FROM accounts WHERE id = $1', [account.id]);
    expect(row!.health).toBe('DEGRADED');
    expect(row!.health_reason).toMatch(/^Bluesky asked this account to slow down/);
    expect(row!.health_reason).not.toMatch(/\bX\b/);
    expect((await xCapacity.usage(account.id, new Date(Date.now() - 3_600_000))).rateLimits).toBe(1);
  });
});

describe('notifications that arrive in a burst', () => {
  const BASE = Date.now() - 60 * 60_000;

  function seed(from: number, to: number) {
    for (let i = from; i < to; i += 1) {
      const post = fake.seedPost({
        id: `3kb${String(i).padStart(4, '0')}`,
        author: ALICE,
        text: `a message from the burst, number ${i}`,
        createdAt: new Date(BASE + i * 1_000).toISOString(),
      });
      fake.notify(post, 'mention');
    }
  }

  async function settings(accountId: string) {
    return (await accountsRepo.requireAccount(accountId)).settings.bluesky as Record<string, unknown>;
  }

  it('reads one page on the first poll, then moves its mark and reads only what is new', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    seed(0, 120);

    await pollOnce(account.id);
    expect(await query('SELECT 1 FROM events')).toHaveLength(50);
    // The mark is the newest event taken in, kept on the account.
    expect((await settings(account.id)).notificationsSeenThrough).toBe(new Date(BASE + 119 * 1_000).toISOString());
    // And the server address in the same settings survived being written beside it.
    expect((await settings(account.id)).serviceUrl).toBe(fake.origin);

    // Fifty more arrive. The next poll reads the burst to its end, not the
    // last page of it, and ingests nothing twice.
    seed(120, 170);
    fake.requests.length = 0;
    await pollOnce(account.id);
    const ids = await query<{ remote_event_id: string }>('SELECT remote_event_id FROM events');
    expect(ids).toHaveLength(100);
    expect(new Set(ids.map((r) => r.remote_event_id)).size).toBe(100);
    expect((await settings(account.id)).notificationsSeenThrough).toBe(new Date(BASE + 169 * 1_000).toISOString());
  });

  it('does not move the mark on a poll that failed, so the events are read again', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    seed(0, 5);
    const before = await settings(account.id);
    expect(before.notificationsSeenThrough).toBeUndefined();

    fake.rateLimitNext = 1;
    await pollOnce(account.id);
    expect((await settings(account.id)).notificationsSeenThrough).toBeUndefined();
    expect(await query('SELECT 1 FROM events')).toHaveLength(0);

    await pollOnce(account.id);
    expect(await query('SELECT 1 FROM events')).toHaveLength(5);
  });

  it('never moves the mark backwards', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    const { advanceNotificationWatermark } = await import('@xbam/runtime');
    const at = (ms: number) => ({ raw: { indexedAt: new Date(BASE + ms).toISOString() } });
    const version = async () => ((await settings(account.id)).notificationsVersion as number | undefined) ?? 0;
    await advanceNotificationWatermark(account.id, [at(5_000)], undefined, await version());
    await advanceNotificationWatermark(account.id, [at(1_000)], undefined, await version());
    expect((await settings(account.id)).notificationsSeenThrough).toBe(new Date(BASE + 5_000).toISOString());
    await advanceNotificationWatermark(account.id, [], undefined, await version());
    expect((await settings(account.id)).notificationsSeenThrough).toBe(new Date(BASE + 5_000).toISOString());
  });
});

/** The two MEDIA_RESOLVED traces a job writes: what was found, and what the prompt will admit. */
async function mediaTraces(jobId: string) {
  const rows = await query<{ level: string; message: string; data: Record<string, unknown> }>(
    `SELECT level, message, data FROM trace_events WHERE job_id = $1 AND type = 'MEDIA_RESOLVED' ORDER BY id`,
    [jobId],
  );
  return {
    found: rows.find((row) => 'hasUnderstandingGap' in row.data),
    admission: rows.find((row) => 'visionConfigured' in row.data),
  };
}

describe('a picture the agent cannot read', () => {
  const policy = { model: 'mock-fixed:Not sure I can see what you mean from here, but happy to look again when I can.' };

  it('is recorded as an explicit gap, and the reply goes ahead saying so', async () => {
    const fixture = await createFixture(policy);
    const account = await linked(fixture);
    const post = fake.seedPost({
      id: '3kpic',
      author: ALICE,
      text: '@agent.test what is this?',
      embed: {
        $type: 'app.bsky.embed.images#view',
        images: [{ thumb: 'https://cdn.example.invalid/t', fullsize: 'https://cdn.example.invalid/f', alt: '' }],
      },
    });
    fake.notify(post, 'mention');

    await pollOnce(account.id);
    await drainAgentJobs(fixture.agentId);

    const [job] = await query<{ id: string; status: string }>('SELECT id, status FROM jobs');
    expect(job!.status).toBe('EXECUTED');

    // The attachment is a row, not an absence, and it says why it was not read.
    const media = await query<{ kind: string; status: string; error: string | null; source_url: string | null }>(
      'SELECT kind, status, error, source_url FROM event_media',
    );
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'image', status: 'skipped', source_url: 'https://cdn.example.invalid/f' });
    expect(media[0]!.error).toMatch(/no vision model/i);

    // The trace calls it a gap that mattered, which is what puts the
    // "NOT UNDERSTOOD" block in front of the model, and says the reply will
    // admit it rather than pretend to have looked.
    const { found, admission } = await mediaTraces(job!.id);
    expect(found!.level).toBe('warn');
    expect(found!.data.hasUnderstandingGap).toBe(true);
    expect(admission!.data).toMatchObject({ needsImage: true, visionConfigured: false });
    expect(admission!.message).toMatch(/no vision model/i);
    expect((await jobsRepo.requireJob(job!.id)).status).toBe('EXECUTED');
  });

  it('is not a gap when the words explain themselves', async () => {
    const fixture = await createFixture(policy);
    const account = await linked(fixture);
    const post = fake.seedPost({
      id: '3kpic2',
      author: ALICE,
      text: '@agent.test thanks for the thoughtful write up on retries and idempotency yesterday, it helped our team a lot',
      embed: {
        $type: 'app.bsky.embed.images#view',
        images: [{ thumb: 'https://cdn.example.invalid/t', fullsize: 'https://cdn.example.invalid/f', alt: 'a dog' }],
      },
    });
    fake.notify(post, 'mention');

    await pollOnce(account.id);
    await drainAgentJobs(fixture.agentId);
    const [job] = await query<{ id: string }>('SELECT id FROM jobs');
    const { found } = await mediaTraces(job!.id);
    expect(found!.data.hasUnderstandingGap).toBe(false);
  });
});
