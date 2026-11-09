import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountCredentials,
  accounts as accountsRepo,
  actions as actionsRepo,
  cadences as cadencesRepo,
  capabilities,
  jobs as jobsRepo,
  query,
  xCapacity,
} from '@xbam/database';
import { BLUESKY_UNSAFE_DEV_ORIGIN_ENV, blueskyAdapter, resetBlueskySessionsForTest } from '@xbam/channels';
import { buildChannelContext, checkReadCapacity, connectBlueskyAccount, ingestNormalizedEvent } from '@xbam/runtime';
import { buildServer } from '../../apps/api/src/server';
import { ChannelPoller } from '../../apps/worker/src/poller';
import { installHarness } from '../support/harness';
import { createFixture, type Fixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';
import { ALICE, FakeBluesky, ME } from '../support/fakeBluesky';

installHarness();

/**
 * A Bluesky account end to end: linked with an app password, polled through the
 * ordinary cadence, run through the ordinary ten pipeline steps, and answered.
 *
 * The same runtime path the mock channel proves for X, with a Bluesky server on
 * loopback in place of the network. Nothing here reaches bsky.social.
 */

const REPLY_TEXT = 'Thanks @alice.test, that is a fair point.';

let fake: FakeBluesky;
let app: FastifyInstance;
let previousOrigin: string | undefined;

beforeAll(async () => {
  fake = await FakeBluesky.start();
  previousOrigin = process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV];
  process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV] = fake.origin;
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
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
  fake.expireAccessTokens = false;
  fake.dropNextPostResponse = false;
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

function aMention() {
  const root = fake.seedPost({ id: '3kroot', author: { did: ME.did, handle: ME.handle }, text: 'Shipping a small thing today.' });
  const mention = fake.seedPost({ id: '3kment', author: ALICE, text: '@agent.test what made you build it?', replyTo: root.uri });
  fake.notify(mention, 'mention');
  return { root, mention };
}

async function pollOnce(accountId: string) {
  // The poller claims whatever is due; make this account due.
  await query('UPDATE accounts SET next_poll_at = NULL WHERE id = $1', [accountId]);
  await new ChannelPoller().tick();
}

describe('linking an account', () => {
  it('proves the app password before it keeps anything, and keeps it sealed', async () => {
    const fixture = await createFixture();
    const { account, created } = await connectBlueskyAccount({
      ownerId: fixture.ownerId,
      identifier: `@${ME.handle}`,
      appPassword: ME.password,
      serviceUrl: fake.origin,
    });
    expect(created).toBe(true);
    expect(account).toMatchObject({ channel: 'bluesky', status: 'CONNECTED', handle: ME.handle, remoteAccountId: ME.did });

    const [stored] = await query<{ sealed_login_password: string; sealed_login_username: string }>(
      'SELECT sealed_login_username, sealed_login_password FROM account_credentials WHERE account_id = $1',
      [account.id],
    );
    expect(stored!.sealed_login_password).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(stored!.sealed_login_password).not.toContain(ME.password);
    expect(await accountCredentials.getDecryptedLogin(account.id)).toEqual({
      loginUsername: ME.handle,
      loginPassword: ME.password,
    });
  });

  it('is idempotent: linking again refreshes the account and does not make a second', async () => {
    const fixture = await createFixture();
    const first = await connectBlueskyAccount({ ownerId: fixture.ownerId, identifier: ME.handle, appPassword: ME.password, serviceUrl: fake.origin });
    const second = await connectBlueskyAccount({ ownerId: fixture.ownerId, identifier: ME.handle, appPassword: ME.password, serviceUrl: fake.origin });
    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect((await accountsRepo.listAccounts(fixture.ownerId)).filter((a) => a.channel === 'bluesky')).toHaveLength(1);
  });

  it('keeps nothing when the password is wrong', async () => {
    const fixture = await createFixture();
    await expect(
      connectBlueskyAccount({ ownerId: fixture.ownerId, identifier: ME.handle, appPassword: 'zzzz-zzzz-zzzz-zzzz', serviceUrl: fake.origin }),
    ).rejects.toThrow(/did not accept/);
    expect(await accountsRepo.listAccounts(fixture.ownerId)).toHaveLength(0);
    expect(await query('SELECT 1 FROM account_credentials')).toHaveLength(0);
  });

  it('refuses a main password before asking Bluesky anything', async () => {
    const fixture = await createFixture();
    await expect(
      connectBlueskyAccount({ ownerId: fixture.ownerId, identifier: ME.handle, appPassword: 'my real password', serviceUrl: fake.origin }),
    ).rejects.toThrow(/app password/);
    expect(fake.requests).toHaveLength(0);
  });

  it('stops at a security challenge and stores nothing', async () => {
    const fixture = await createFixture();
    fake.challenge = true;
    await expect(
      connectBlueskyAccount({ ownerId: fixture.ownerId, identifier: ME.handle, appPassword: ME.password, serviceUrl: fake.origin }),
    ).rejects.toThrow(/never answers a security challenge/);
    expect(await accountsRepo.listAccounts(fixture.ownerId)).toHaveLength(0);
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(1);
  });

  it('refuses a server that is not https', async () => {
    const fixture = await createFixture();
    const previous = process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV];
    delete process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV];
    try {
      await expect(
        connectBlueskyAccount({ ownerId: fixture.ownerId, identifier: ME.handle, appPassword: ME.password, serviceUrl: fake.origin }),
      ).rejects.toThrow(/https/);
    } finally {
      process.env[BLUESKY_UNSAFE_DEV_ORIGIN_ENV] = previous;
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('is linked through the API without the password coming back, and not through the generic route', async () => {
    const fixture = await createFixture();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
    const auth = { authorization: `Bearer ${(login.json() as { data: { token: string } }).data.token}` };

    const linkedResponse = await app.inject({
      method: 'POST',
      url: '/api/accounts/bluesky',
      headers: auth,
      payload: { identifier: ME.handle, appPassword: ME.password, serviceUrl: fake.origin },
    });
    expect(linkedResponse.statusCode, linkedResponse.body).toBe(200);
    const { data } = linkedResponse.json() as { data: { id: string; channel: string; status: string } };
    expect(data).toMatchObject({ channel: 'bluesky', status: 'CONNECTED' });

    const presence = await app.inject({ method: 'GET', url: `/api/accounts/${data.id}/credentials`, headers: auth });
    const list = await app.inject({ method: 'GET', url: '/api/accounts', headers: auth });
    for (const response of [linkedResponse, presence, list]) {
      expect(response.body).not.toContain(ME.password);
      expect(response.body).not.toMatch(/access-\d|refresh-\d/);
    }

    const generic = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: auth,
      payload: { channel: 'bluesky', handle: 'someone.test' },
    });
    expect(generic.statusCode).toBe(400);
    expect(generic.body).toMatch(/app password/);
  });
});

describe('a mention on Bluesky, answered through the ordinary pipeline', () => {
  const policy = { model: `mock-fixed:${REPLY_TEXT}` };

  it('is polled, run through the ten steps, and replied to with correct refs', async () => {
    const fixture = await createFixture(policy);
    const account = await linked(fixture);
    const { root, mention } = aMention();

    await pollOnce(account.id);

    const events = await query<{ remote_event_id: string; channel: string }>('SELECT remote_event_id, channel FROM events');
    expect(events).toEqual([{ remote_event_id: mention.uri, channel: 'bluesky' }]);

    await drainAgentJobs(fixture.agentId);

    const jobRows = await query<{ id: string }>('SELECT id FROM jobs');
    expect(jobRows).toHaveLength(1);
    const settled = await jobsRepo.requireJob(jobRows[0]!.id);
    expect(settled.status, settled.lastError ?? '').toBe('EXECUTED');
    expect(settled.channel).toBe('bluesky');
    expect(settled.requiresBrowser).toBe(false);

    const written = fake.postsBy(ME.did).filter((post) => post.record.reply);
    expect(written).toHaveLength(1);
    expect(written[0]!.record.text).toBe(REPLY_TEXT);
    expect(written[0]!.record.reply).toEqual({
      root: { uri: root.uri, cid: root.cid },
      parent: { uri: mention.uri, cid: mention.cid },
    });
    expect((written[0]!.record.facets as unknown[]).length).toBeGreaterThan(0);

    const recorded = await actionsRepo.listJobActions(settled.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ channel: 'bluesky', type: 'REPLY', status: 'EXECUTED', remoteActionId: written[0]!.uri });
  });

  it('sees the same mention on the next poll and does not answer it twice', async () => {
    const fixture = await createFixture(policy);
    const account = await linked(fixture);
    aMention();

    await pollOnce(account.id);
    await drainAgentJobs(fixture.agentId);
    await pollOnce(account.id);
    await pollOnce(account.id);
    await drainAgentJobs(fixture.agentId);

    expect(await query('SELECT 1 FROM events')).toHaveLength(1);
    expect(fake.postsBy(ME.did).filter((post) => post.record.reply)).toHaveLength(1);
    // Three polls, one sign-in.
    expect(fake.of('com.atproto.server.createSession').length).toBeLessThanOrEqual(2);
  });

  it('does nothing outside a dry run when it is made one', async () => {
    const fixture = await createFixture({ ...policy, policy: { automation: { mode: 'AUTONOMOUS', dryRunDefault: true } } as never });
    const account = await linked(fixture);
    aMention();
    await pollOnce(account.id);
    await drainAgentJobs(fixture.agentId);
    expect(fake.of('com.atproto.repo.createRecord')).toHaveLength(0);
  });

  it('fails permanently, sending nothing, when the permission is revoked after the job is queued', async () => {
    const fixture = await createFixture(policy);
    const account = await linked(fixture);
    const { mention } = aMention();

    // Ingest has been and gone; only the check before execution can stop this.
    const [event] = await blueskyAdapter.ingestEvents(await buildChannelContext(account, null), { limit: 10 });
    const outcome = await ingestNormalizedEvent({ accountId: account.id, event: event! });
    expect(outcome.jobs).toHaveLength(1);
    expect(event!.remoteEventId).toBe(mention.uri);

    await capabilities.setGrants(fixture.agentId, account.id, ['READ', 'GENERATE'], null);
    await drainAgentJobs(fixture.agentId);

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.lastError).toMatch(/not permitted to REPLY/i);
    expect(await actionsRepo.listJobActions(job.id)).toHaveLength(0);
    expect(fake.of('com.atproto.repo.createRecord')).toHaveLength(0);
  });

  it('queues nothing, but remembers the event, when REPLY is not granted at all', async () => {
    const fixture = await createFixture(policy);
    const account = await linked(fixture);
    await capabilities.setGrants(fixture.agentId, account.id, ['READ', 'GENERATE'], null);
    aMention();

    await pollOnce(account.id);
    await drainAgentJobs(fixture.agentId);

    expect(await query('SELECT 1 FROM events')).toHaveLength(1);
    expect(await query('SELECT 1 FROM jobs')).toHaveLength(0);
    expect(fake.of('com.atproto.repo.createRecord')).toHaveLength(0);
  });

  it('keeps the app password and the session tokens out of every table but the sealed one', async () => {
    const fixture = await createFixture(policy);
    const account = await linked(fixture);
    aMention();
    await pollOnce(account.id);
    await drainAgentJobs(fixture.agentId);
    fake.rateLimitNext = 1;
    await pollOnce(account.id);

    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const leaks: string[] = [];
    for (const { table_name } of tables) {
      if (table_name === 'account_credentials') continue;
      const rows = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table_name}" t WHERE t::text LIKE $1 OR t::text LIKE $2 OR t::text LIKE $3`,
        [`%${ME.password}%`, '%access-%', '%refresh-%'],
      );
      if ((rows[0]?.n ?? 0) > 0) leaks.push(table_name);
    }
    // Every row of every table, as text. A leak arrives through a column or a
    // trace payload somebody added, not through a field anybody meant.
    expect(leaks).toEqual([]);
  });
});

describe('reads spend from the one budget', () => {
  it('counts each poll against the account', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await pollOnce(account.id);
    const usage = await xCapacity.usage(account.id, new Date(Date.now() - 10 * 60_000));
    expect(usage.readsLast10Minutes).toBeGreaterThanOrEqual(1);
  });

  it('does not read at all once the account has spent its budget', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    const budget = (await cadencesRepo.activeCadence(account.id)).capacity.readsPer10Minutes;
    for (let i = 0; i < budget; i += 1) await xCapacity.recordRead(account.id, 'DIRECT');
    expect((await checkReadCapacity(account.id, 'DIRECT')).allowed).toBe(false);

    fake.requests.length = 0;
    await pollOnce(account.id);
    // A runaway Bluesky poll cannot hammer the network: the budget answers first.
    expect(fake.of('app.bsky.notification.listNotifications')).toHaveLength(0);
    const state = await cadencesRepo.pollState(account.id);
    expect(new Date(state!.nextPollAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('records a rate limit as pushback, and keeps the account connected', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await pollOnce(account.id);
    fake.rateLimitNext = 1;
    await pollOnce(account.id);

    const usage = await xCapacity.usage(account.id, new Date(Date.now() - 60 * 60_000));
    expect(usage.rateLimits).toBe(1);
    expect((await accountsRepo.requireAccount(account.id)).status).toBe('CONNECTED');
  });
});

describe('when the sign-in is gone', () => {
  it('moves the account to NEEDS_AUTH and stops signing in', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    await accountCredentials.setCredentials({ accountId: account.id, loginUsername: ME.handle, loginPassword: 'zzzz-zzzz-zzzz-zzzz' });
    resetBlueskySessionsForTest();
    fake.requests.length = 0;

    await pollOnce(account.id);
    expect((await accountsRepo.requireAccount(account.id)).status).toBe('NEEDS_AUTH');

    // Bluesky limits how many sessions an account may make. An account whose
    // password was revoked must not be polled back into that limit.
    const signIns = fake.of('com.atproto.server.createSession').length;
    await pollOnce(account.id);
    await pollOnce(account.id);
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(signIns);
  });

  it('puts a challenge in its own state, and leaves the page alone', async () => {
    const fixture = await createFixture();
    const account = await linked(fixture);
    resetBlueskySessionsForTest();
    fake.challenge = true;
    fake.requests.length = 0;

    await pollOnce(account.id);
    const after = await accountsRepo.requireAccount(account.id);
    expect(after.status).toBe('CHALLENGE_REQUIRES_USER');
    expect(after.challengeKind).toBe('EMAIL_CODE');
    expect(fake.requests).toHaveLength(1);
  });
});
