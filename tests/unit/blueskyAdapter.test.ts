import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@xbam/shared/contracts';
import { PipelineError, redact } from '@xbam/shared';
import {
  BLUESKY_UNSAFE_DEV_ORIGIN_ENV,
  blueskyAdapter,
  blueskyServiceTargetFor,
  resetBlueskySessionsForTest,
  type ChannelContext,
} from '@xbam/channels';
import { classifyXSignal } from '@xbam/runtime';
import { ALICE, FakeBluesky, ME } from '../support/fakeBluesky';

/**
 * The Bluesky adapter against a fixture server.
 *
 * Nothing here reaches the real network: the server is on loopback and the only
 * origin the fetch layer will reach over plain http is the one this file names
 * in AI17Z_BLUESKY_UNSAFE_DEV_ORIGIN.
 */

let fake: FakeBluesky;
let previousOrigin: string | undefined;
const logs: string[] = [];

function account(overrides: Partial<Account> = {}): Account {
  const now = new Date().toISOString();
  return {
    id: '00000000-0000-4000-8000-0000000000b1',
    ownerId: '00000000-0000-4000-8000-0000000000a1',
    channel: 'bluesky',
    remoteAccountId: ME.did,
    handle: ME.handle,
    displayName: ME.handle,
    status: 'CONNECTED',
    enabled: true,
    capabilities: ['REPLY', 'POST', 'LIKE'],
    settings: { bluesky: { serviceUrl: fake.origin } },
    lastHealthCheckAt: null,
    lastHealthStatus: null,
    lastActivityAt: null,
    lastError: null,
    authStartedAt: null,
    authDeadlineAt: null,
    challengeKind: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function context(password: string | null = ME.password, overrides: Partial<Account> = {}): ChannelContext {
  const sink = (level: string) => (message: string, data?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${JSON.stringify(redact(data ?? {}))}`);
  };
  const logger = {
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
    child: () => logger,
  };
  return {
    account: account(overrides),
    session: null,
    storageDir: '.',
    logger: logger as never,
    jobId: null,
    credentials: async () => (password === null ? null : { loginUsername: ME.handle, loginPassword: password }),
  };
}

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
  fake.takendown = false;
  fake.rateLimitNext = 0;
  fake.expireAccessTokens = false;
  fake.dropNextPostResponse = false;
  fake.omitCounts = false;
  fake.hiddenUris.clear();
  fake.staleCursors.clear();
  logs.length = 0;
});

describe('which server an account is reached on', () => {
  it('is bsky.social unless the account says otherwise', () => {
    expect(blueskyServiceTargetFor({})).toEqual({ origin: 'https://bsky.social', allowPrivate: false });
    expect(blueskyServiceTargetFor({ bluesky: { serviceUrl: 'https://pds.example.invalid/some/path' } })).toEqual({
      origin: 'https://pds.example.invalid',
      allowPrivate: false,
    });
  });

  it('refuses anything that is not https, and a name or password in the address', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => blueskyServiceTargetFor({ bluesky: { serviceUrl: 'http://pds.example.invalid' } }, env)).toThrow(/https/);
    expect(() => blueskyServiceTargetFor({ bluesky: { serviceUrl: 'http://127.0.0.1:9' } }, env)).toThrow(/https/);
    expect(() => blueskyServiceTargetFor({ bluesky: { serviceUrl: 'https://u:p@pds.example.invalid' } }, env)).toThrow(/name or password/);
    expect(() => blueskyServiceTargetFor({ bluesky: { serviceUrl: 'not a url' } }, env)).toThrow(/not a server address/);
  });

  it('reaches a plain-http origin only when that exact origin is named', () => {
    const env = { [BLUESKY_UNSAFE_DEV_ORIGIN_ENV]: 'http://127.0.0.1:5555' } as NodeJS.ProcessEnv;
    expect(blueskyServiceTargetFor({ bluesky: { serviceUrl: 'http://127.0.0.1:5555' } }, env).allowPrivate).toBe(true);
    // A different port on the same machine is a different origin.
    expect(() => blueskyServiceTargetFor({ bluesky: { serviceUrl: 'http://127.0.0.1:5556' } }, env)).toThrow(/https/);
  });
});

describe('signing in', () => {
  it('connects with an app password and reports who it is', async () => {
    const result = await blueskyAdapter.connect(context());
    expect(result).toMatchObject({ status: 'CONNECTED', remoteAccountId: ME.did, handle: ME.handle });
  });

  it('says the details were refused, without repeating them', async () => {
    const result = await blueskyAdapter.connect(context('wrong-pass-word-0000'));
    expect(result.status).toBe('NEEDS_AUTH');
    expect(result.detail).not.toContain('wrong-pass-word-0000');
    expect(result.detail).toMatch(/app password/i);
  });

  it('says there is nothing stored when there is nothing stored', async () => {
    const result = await blueskyAdapter.connect(context(null));
    expect(result.status).toBe('NEEDS_AUTH');
    expect(fake.requests).toHaveLength(0);
  });

  it('stops at a security challenge and tries nothing else', async () => {
    fake.challenge = true;
    const result = await blueskyAdapter.connect(context());
    expect(result.status).toBe('CHALLENGE_REQUIRES_USER');
    // One request, and no second attempt with a guessed code or the same
    // details again. The account waits for a person.
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
  });

  it('does not call a taken-down account connected', async () => {
    fake.takendown = true;
    const result = await blueskyAdapter.connect(context());
    expect(result.status).toBe('ERROR');
  });

  it('signs in once however many things ask at the same moment', async () => {
    const ctx = context();
    await Promise.all([1, 2, 3, 4, 5].map(() => blueskyAdapter.healthCheck(ctx)));
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(1);
  });

  it('keeps the session between calls, because sign-ins are rate limited', async () => {
    const ctx = context();
    await blueskyAdapter.ingestEvents(ctx, { limit: 10 });
    await blueskyAdapter.ingestEvents(ctx, { limit: 10 });
    await blueskyAdapter.healthCheck(ctx);
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(1);
    expect(fake.of('app.bsky.notification.listNotifications')).toHaveLength(2);
  });

  it('renews an expired session with the refresh token instead of the password', async () => {
    const ctx = context();
    await blueskyAdapter.ingestEvents(ctx, { limit: 10 });
    fake.expireAccessTokens = true;
    await blueskyAdapter.ingestEvents(ctx, { limit: 10 });
    expect(fake.of('com.atproto.server.refreshSession')).toHaveLength(1);
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(1);
  });

  it('puts the app password on the wire once per sign-in and nowhere else', async () => {
    const ctx = context();
    await blueskyAdapter.ingestEvents(ctx, { limit: 10 });
    fake.expireAccessTokens = true;
    await blueskyAdapter.healthCheck(ctx);
    for (const request of fake.requests) {
      const carries = JSON.stringify(request.body ?? '').includes(ME.password) || (request.authorization ?? '').includes(ME.password);
      expect(carries, request.nsid).toBe(request.nsid === 'com.atproto.server.createSession');
    }
  });

  it('never puts the password or a session token in a log line', async () => {
    const ctx = context();
    await blueskyAdapter.connect(context('wrong-pass-word-0000'));
    await blueskyAdapter.ingestEvents(ctx, { limit: 10 });
    expect(logs.join('\n')).not.toContain(ME.password);
    expect(logs.join('\n')).not.toContain('wrong-pass-word-0000');
    // The logger's own redaction knows what a Bluesky session looks like.
    expect(redact({ accessJwt: 'a', refreshJwt: 'b', note: 'ok' })).toEqual({
      accessJwt: '[redacted]',
      refreshJwt: '[redacted]',
      note: 'ok',
    });
  });
});

describe('reading what people sent', () => {
  it('turns mentions, replies and quotes into events and ignores everything else', async () => {
    const mention = fake.seedPost({ id: '3kmention', author: ALICE, text: '@agent.test are you there?' });
    const mine = fake.seedPost({ id: '3kmine', author: { did: ME.did, handle: ME.handle }, text: 'hello world' });
    const reply = fake.seedPost({ id: '3kreply', author: ALICE, text: 'nice post', replyTo: mine.uri });
    const quote = fake.seedPost({ id: '3kquote', author: ALICE, text: 'look at this' });
    const liked = fake.seedPost({ id: '3klike', author: ALICE, text: 'something' });
    const selfReply = fake.seedPost({ id: '3kself', author: { did: ME.did, handle: ME.handle }, text: 'my own follow-up', replyTo: mine.uri });

    fake.notify(mention, 'mention');
    fake.notify(reply, 'reply');
    fake.notify(quote, 'quote');
    fake.notify(liked, 'like');
    fake.notify(selfReply, 'reply');
    fake.notify(liked, 'follow');

    const events = await blueskyAdapter.ingestEvents(context(), { limit: 10 });

    // Oldest first, so a burst is answered in the order it arrived. The
    // like, the follow and the agent's own reply are not here.
    expect(events.map((e) => [e.type, e.text])).toEqual([
      ['MENTION', '@agent.test are you there?'],
      ['REPLY', 'nice post'],
      ['MENTION', 'look at this'],
    ]);
    const replyEvent = events.find((e) => e.type === 'REPLY')!;
    expect(replyEvent).toMatchObject({
      channel: 'bluesky',
      // The URI is the idempotency anchor and the action target.
      remoteEventId: reply.uri,
      remoteMessageId: reply.uri,
      remoteAuthorId: ALICE.did,
      remoteAuthorHandle: ALICE.handle,
      remoteConversationId: mine.uri,
      parentRemoteMessageId: mine.uri,
      remoteUrl: 'https://bsky.app/profile/alice.test/post/3kreply',
    });
    expect(replyEvent.raw).toMatchObject({ addressedToAgent: true, reason: 'reply' });
    // Seen on a later poll again, it is the same event id.
    const again = await blueskyAdapter.ingestEvents(context(), { limit: 10 });
    expect(again.map((e) => e.remoteEventId)).toEqual(events.map((e) => e.remoteEventId));
  });

  it('fails a poll the way a rate limit should, with the wait the server stated', async () => {
    const ctx = context();
    await blueskyAdapter.healthCheck(ctx);
    fake.rateLimitNext = 1;
    const failure = await blueskyAdapter.ingestEvents(ctx, { limit: 10 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PipelineError);
    const error = failure as PipelineError;
    expect(error.errorClass).toBe('RETRYABLE');
    expect(error.reason).toBe('bluesky_rate_limited');
    expect(error.data.retryAfterMs as number).toBeGreaterThan(60_000);
    // The capacity breaker recognises this sentence as pushback, which is what
    // makes a runaway Bluesky poll slow itself down.
    expect(classifyXSignal(error.message)).toBe('RATE_LIMITED');
  });
});

describe('understanding the thread a mention is in', () => {
  function thread() {
    const root = fake.seedPost({ id: '3kroot', author: { did: ME.did, handle: ME.handle }, text: 'the original' });
    const mid = fake.seedPost({ id: '3kmid', author: ALICE, text: 'a reply', replyTo: root.uri });
    const leaf = fake.seedPost({ id: '3kleaf', author: ALICE, text: '@agent.test what do you think?', replyTo: mid.uri });
    return { root, mid, leaf };
  }

  it('reads the branch root first, and targets the post that was written to the agent', async () => {
    const { root, mid, leaf } = thread();
    fake.notify(leaf, 'mention');
    const [event] = await blueskyAdapter.ingestEvents(context(), { limit: 10 });
    const resolved = await blueskyAdapter.resolveContext(context(), event!);

    expect(resolved.targetRef).toBe(leaf.uri);
    expect(resolved.targetAuthorHandle).toBe(ALICE.handle);
    expect(resolved.conversationRef).toBe(root.uri);
    expect(resolved.incomingText).toBe('@agent.test what do you think?');
    expect(resolved.parentText).toBe('a reply');
    expect(resolved.conversation?.ancestors.map((p) => p.remoteId)).toEqual([root.uri, mid.uri]);
    expect(resolved.conversation?.ancestors[0]?.isSelf).toBe(true);
    expect(resolved.conversation?.ancestors[1]?.isSelf).toBe(false);
    expect(resolved.thread.map((m) => m.role)).toEqual(['OUTBOUND', 'INBOUND']);
    expect(resolved.conversation?.method).toBe('STATUS_ANCHORED');
    expect(resolved.conversation?.participants).toEqual([ME.handle, ALICE.handle]);
  });

  it('says so when a post above has gone, rather than pretending the thread starts later', async () => {
    const { root, leaf } = thread();
    fake.notify(leaf, 'mention');
    fake.hiddenUris.add(root.uri);
    const [event] = await blueskyAdapter.ingestEvents(context(), { limit: 10 });
    const resolved = await blueskyAdapter.resolveContext(context(), event!);
    expect(resolved.conversation?.ancestors).toHaveLength(1);
    expect(resolved.conversation?.note).toMatch(/deleted/);
  });

  it('fails permanently when the post it was asked to answer is gone', async () => {
    const { leaf } = thread();
    fake.notify(leaf, 'mention');
    const [event] = await blueskyAdapter.ingestEvents(context(), { limit: 10 });
    fake.hiddenUris.add(leaf.uri);
    const failure = await blueskyAdapter.resolveContext(context(), event!).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PipelineError);
    expect((failure as PipelineError).errorClass).toBe('PERMANENT');
  });
});

describe('verifying and performing an action', () => {
  it('quotes the parent and the root, each by URI and CID, in a reply', async () => {
    const root = fake.seedPost({ id: '3kroot', author: ALICE, text: 'start' });
    const leaf = fake.seedPost({ id: '3kleaf', author: ALICE, text: 'middle', replyTo: root.uri });

    const result = await blueskyAdapter.executeAction(context(), {
      type: 'REPLY',
      targetRef: leaf.uri,
      text: 'thanks for this',
      idempotencyKey: 'k1',
      dryRun: false,
    });

    expect(result.status).toBe('EXECUTED');
    const written = fake.postsBy(ME.did);
    expect(written).toHaveLength(1);
    // The fixture rejects a reply whose refs do not match what it holds, so
    // this passing is the proof they were right.
    expect(written[0]!.record.reply).toEqual({
      root: { uri: root.uri, cid: root.cid },
      parent: { uri: leaf.uri, cid: leaf.cid },
    });
    expect(result.remoteActionId).toBe(written[0]!.uri);
    expect(result.remoteActionUrl).toBe(`https://bsky.app/profile/${ME.handle}/post/${written[0]!.uri.split('/').pop()}`);
  });

  it('makes a reply to a root post its own root', async () => {
    const root = fake.seedPost({ id: '3kroot', author: ALICE, text: 'start' });
    await blueskyAdapter.executeAction(context(), { type: 'REPLY', targetRef: root.uri, text: 'hi', idempotencyKey: 'k', dryRun: false });
    const reply = fake.postsBy(ME.did)[0]!.record.reply!;
    expect(reply.root).toEqual({ uri: root.uri, cid: root.cid });
    expect(reply.parent).toEqual({ uri: root.uri, cid: root.cid });
  });

  it('turns a mention into a real one, with byte-correct facets', async () => {
    const root = fake.seedPost({ id: '3kroot', author: ALICE, text: 'start' });
    await blueskyAdapter.executeAction(context(), {
      type: 'REPLY',
      targetRef: root.uri,
      text: '🎉 thanks @alice.test, see https://example.com/x.',
      idempotencyKey: 'k',
      dryRun: false,
    });
    const facets = fake.postsBy(ME.did)[0]!.record.facets as Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ $type: string }> }>;
    expect(facets.map((f) => f.features[0]!.$type)).toEqual([
      'app.bsky.richtext.facet#mention',
      'app.bsky.richtext.facet#link',
    ]);
    const bytes = Buffer.from('🎉 thanks @alice.test, see https://example.com/x.');
    expect(bytes.subarray(facets[0]!.index.byteStart, facets[0]!.index.byteEnd).toString()).toBe('@alice.test');
    expect(bytes.subarray(facets[1]!.index.byteStart, facets[1]!.index.byteEnd).toString()).toBe('https://example.com/x');
  });

  it('publishes a post with no target', async () => {
    const result = await blueskyAdapter.executeAction(context(), { type: 'POST', targetRef: null, text: 'a thought', idempotencyKey: 'k', dryRun: false });
    expect(result.status).toBe('EXECUTED');
    expect(fake.postsBy(ME.did)[0]!.record.reply).toBeUndefined();
  });

  it('stops at the boundary on a dry run', async () => {
    const root = fake.seedPost({ id: '3kroot', author: ALICE, text: 'start' });
    const result = await blueskyAdapter.executeAction(context(), { type: 'REPLY', targetRef: root.uri, text: 'hi', idempotencyKey: 'k', dryRun: true });
    expect(result).toMatchObject({ status: 'DRY_RUN', remoteActionId: null });
    expect(result.verification.verified).toBe(true);
    expect(fake.of('com.atproto.repo.createRecord')).toHaveLength(0);
  });

  it('never shortens a draft that is too long, and never sends it', async () => {
    const root = fake.seedPost({ id: '3kroot', author: ALICE, text: 'start' });
    const verification = await blueskyAdapter.verifyAction(context(), { type: 'REPLY', targetRef: root.uri, text: 'a'.repeat(301), idempotencyKey: 'k', dryRun: false });
    expect(verification.verified).toBe(false);
    expect(verification.detail).toMatch(/301/);
    const failure = await blueskyAdapter
      .executeAction(context(), { type: 'REPLY', targetRef: root.uri, text: 'a'.repeat(301), idempotencyKey: 'k', dryRun: false })
      .catch((e: unknown) => e);
    expect((failure as PipelineError).errorClass).toBe('REVIEW_REQUIRED');
    expect(fake.of('com.atproto.repo.createRecord')).toHaveLength(0);
  });

  it('refuses a target that is not there', async () => {
    const verification = await blueskyAdapter.verifyAction(context(), {
      type: 'REPLY',
      targetRef: `at://${ALICE.did}/app.bsky.feed.post/3knothing`,
      text: 'hi',
      idempotencyKey: 'k',
      dryRun: false,
    });
    expect(verification.verified).toBe(false);
  });

  it('likes a post once, and treats asking again as already done', async () => {
    const post = fake.seedPost({ id: '3kpost', author: ALICE, text: 'worth liking' });
    const request = { type: 'LIKE' as const, targetRef: post.uri, text: '', idempotencyKey: 'k', dryRun: false };

    const first = await blueskyAdapter.executeAction(context(), request);
    expect(first.status).toBe('EXECUTED');
    expect(fake.likes.get(post.uri)).toBeTruthy();

    const second = await blueskyAdapter.executeAction(context(), request);
    expect(second.verification.detail).toMatch(/Already liked/);
    expect(fake.of('com.atproto.repo.createRecord')).toHaveLength(1);
  });

  it('supports no other action, and says so rather than guessing', async () => {
    const verification = await blueskyAdapter.verifyAction(context(), { type: 'DIRECT_MESSAGE', targetRef: 'x', text: 'hi', idempotencyKey: 'k', dryRun: false });
    expect(verification.verified).toBe(false);
    expect(verification.detail).toMatch(/does not support DIRECT_MESSAGE/);
  });
});

describe('when the answer to a write is lost', () => {
  it('finds the post that was written and does not write it twice', async () => {
    const root = fake.seedPost({ id: '3kroot', author: ALICE, text: 'start' });
    fake.dropNextPostResponse = true;
    const result = await blueskyAdapter.executeAction(context(), {
      type: 'REPLY',
      targetRef: root.uri,
      text: 'this one lands and the answer does not',
      idempotencyKey: 'k',
      dryRun: false,
    });
    expect(result.status).toBe('EXECUTED');
    expect(fake.postsBy(ME.did)).toHaveLength(1);
    expect(result.remoteActionId).toBe(fake.postsBy(ME.did)[0]!.uri);
  });

  it('answers whether an action already happened, from the repository itself', async () => {
    const root = fake.seedPost({ id: '3kroot', author: ALICE, text: 'start' });
    const request = { type: 'REPLY' as const, targetRef: root.uri, text: 'said once', idempotencyKey: 'k', dryRun: false };

    const before = await blueskyAdapter.wasAlreadyDone!(context(), request);
    expect(before.done).toBe(false);
    // Nothing found in a collection this small is proof: the whole of it was read.
    expect(before.conclusive).toBe(true);

    await blueskyAdapter.executeAction(context(), request);
    const after = await blueskyAdapter.wasAlreadyDone!(context(), request);
    expect(after.done).toBe(true);
    expect(after.remoteActionId).toBe(fake.postsBy(ME.did)[0]!.uri);

    // The same words to a different post are a different action.
    const other = fake.seedPost({ id: '3kother', author: ALICE, text: 'else' });
    expect((await blueskyAdapter.wasAlreadyDone!(context(), { ...request, targetRef: other.uri })).done).toBe(false);
  });
});

describe('what a read does not say', () => {
  it('leaves a count out when the server left it out, because absent is not zero', async () => {
    fake.omitCounts = true;
    const post = fake.seedPost({ id: '3kpost', author: ALICE, text: 'hello' });
    const { blueskyReads } = await import('@xbam/channels');
    const read = await blueskyReads.readPost(context(), post.uri);
    expect(read.likeCount).toBeUndefined();
    expect(read.replyCount).toBeUndefined();

    fake.omitCounts = false;
    const counted = await blueskyReads.readPost(context(), post.uri);
    expect(counted.likeCount).toBe(2);
    expect(counted.replyCount).toBe(0);
  });

  it('resolves a bsky.app address through the handle, and refuses a handle as a post', async () => {
    const post = fake.seedPost({ id: '3kpost', author: ALICE, text: 'hello' });
    const { blueskyReads } = await import('@xbam/channels');
    const read = await blueskyReads.readPost(context(), 'https://bsky.app/profile/alice.test/post/3kpost');
    expect(read.uri).toBe(post.uri);
    await expect(blueskyReads.readPost(context(), '@alice.test')).rejects.toMatchObject({ reason: 'bluesky_bad_reference' });
  });

  it('reads a profile, and a missing one is permanent', async () => {
    const { blueskyReads } = await import('@xbam/channels');
    expect(await blueskyReads.readProfile(context(), '@alice.test')).toMatchObject({ handle: 'alice.test', followerCount: 12 });
    await expect(blueskyReads.readProfile(context(), 'nobody.test')).rejects.toMatchObject({ errorClass: 'PERMANENT' });
  });
});

describe('health', () => {
  it('is healthy when signed in, and reports who the session really is', async () => {
    const health = await blueskyAdapter.healthCheck(context());
    expect(health).toMatchObject({ status: 'healthy', authenticated: true, handle: ME.handle });
  });

  it('is offline, not merely degraded, when the details are wrong', async () => {
    const health = await blueskyAdapter.healthCheck(context('wrong-pass-word-0000'));
    expect(health).toMatchObject({ status: 'offline', authenticated: false });
  });

  it('leaves no live session behind on disconnect', async () => {
    const ctx = context();
    await blueskyAdapter.healthCheck(ctx);
    await blueskyAdapter.disconnect(ctx);
    expect(fake.of('com.atproto.server.deleteSession')).toHaveLength(1);
    // And the next call has to sign in again.
    await blueskyAdapter.healthCheck(ctx);
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(2);
  });
});

describe('what is attached to a post', () => {
  const picture = (n: number) => ({
    $type: 'app.bsky.embed.images#view',
    images: Array.from({ length: n }, (_, i) => ({
      thumb: `https://cdn.example.invalid/thumb/${i}`,
      fullsize: `https://cdn.example.invalid/full/${i}`,
      alt: `picture ${i}`,
    })),
  });

  async function resolved(embedOnMention: unknown, embedOnParent?: unknown) {
    const parent = fake.seedPost({ id: '3kparent', author: ALICE, text: 'look at this', embed: embedOnParent });
    const mention = fake.seedPost({ id: '3kment', author: ALICE, text: '@agent.test what is this?', replyTo: parent.uri, embed: embedOnMention });
    fake.notify(mention, 'mention');
    const [event] = await blueskyAdapter.ingestEvents(context(), { limit: 10 });
    return blueskyAdapter.resolveContext(context(), event!);
  }

  it('hands each picture to the media step with its address and alt text', async () => {
    const context_ = await resolved(picture(2));
    const inventory = context_.meta.inventory as { media: Array<{ kind: string; sourceUrl: string; altText: string; position: number }> };
    expect(inventory.media).toEqual([
      expect.objectContaining({ kind: 'image', sourceUrl: 'https://cdn.example.invalid/full/0', altText: 'picture 0', position: 0 }),
      expect.objectContaining({ kind: 'image', sourceUrl: 'https://cdn.example.invalid/full/1', altText: 'picture 1', position: 1 }),
    ]);
    expect(context_.meta.parentInventory).toBeUndefined();
  });

  it('carries the picture on the post above when the mention has none', async () => {
    const context_ = await resolved(undefined, picture(1));
    expect(context_.meta.inventory).toBeUndefined();
    expect((context_.meta.parentInventory as { media: unknown[] }).media).toHaveLength(1);
  });

  it('carries a quoted post, with its own pictures, and a link card as a link', async () => {
    const quoted = {
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://example.com/story', title: 'A story' } },
      record: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: `at://${ALICE.did}/app.bsky.feed.post/3kquoted`,
          author: { handle: ALICE.handle },
          value: { text: 'the quoted words' },
          embeds: [picture(1)],
        },
      },
    };
    const context_ = await resolved(quoted);
    const inventory = context_.meta.inventory as { links: string[]; quoted: { authorHandle: string; text: string; media: unknown[] } };
    expect(inventory.links).toEqual(['https://example.com/story']);
    expect(inventory.quoted).toMatchObject({ authorHandle: ALICE.handle, text: 'the quoted words' });
    expect(inventory.quoted.media).toHaveLength(1);
  });

  it('never drops an attachment it does not recognise: it becomes an item that cannot be read', async () => {
    const context_ = await resolved({ $type: 'app.bsky.embed.somethingNew#view', payload: 1 });
    const inventory = context_.meta.inventory as { media: Array<{ sourceUrl: string | null; meta: { unrecognised?: string } }> };
    expect(inventory.media).toHaveLength(1);
    expect(inventory.media[0]!.sourceUrl).toBeNull();
    expect(inventory.media[0]!.meta.unrecognised).toBe('app.bsky.embed.somethingNew#view');
  });

  it('counts pictures on a post that is read as a capability', async () => {
    const post = fake.seedPost({ id: '3kpics', author: ALICE, text: 'two', embed: picture(2) });
    const { blueskyReads } = await import('@xbam/channels');
    expect((await blueskyReads.readPost(context(), post.uri)).imageCount).toBe(2);
  });
});

describe('reading more than one page of notifications', () => {
  const BASE = Date.parse('2026-11-08T10:00:00.000Z');

  function seedMentions(count: number) {
    for (let i = 0; i < count; i += 1) {
      const post = fake.seedPost({
        id: `3kn${String(i).padStart(4, '0')}`,
        author: ALICE,
        text: `message ${i}`,
        createdAt: new Date(BASE + i * 1_000).toISOString(),
      });
      fake.notify(post, 'mention');
    }
  }

  function withMark(iso: string | null) {
    return context(ME.password, {
      settings: { bluesky: { serviceUrl: fake.origin, ...(iso ? { notificationsSeenThrough: iso } : {}) } },
    });
  }

  it('reads a single page when it has no mark, because a new link is not a reason to ingest history', async () => {
    seedMentions(120);
    const events = await blueskyAdapter.ingestEvents(withMark(null), { limit: 10 });
    expect(events).toHaveLength(50);
    expect(fake.of('app.bsky.notification.listNotifications')).toHaveLength(1);
  });

  it('pages back to the mark, and reads everything that is newer than it', async () => {
    seedMentions(120);
    // Everything from message 30 onward is new: ninety messages, two pages.
    const mark = new Date(BASE + 30 * 1_000).toISOString();
    const events = await blueskyAdapter.ingestEvents(withMark(mark), { limit: 10 });
    expect(events).toHaveLength(90);
    expect(events[0]!.text).toBe('message 30');
    expect(events[events.length - 1]!.text).toBe('message 119');
    expect(fake.of('app.bsky.notification.listNotifications').length).toBe(2);
  });

  it('stops at the page that meets the mark instead of reading the whole history', async () => {
    seedMentions(500);
    const mark = new Date(BASE + 480 * 1_000).toISOString();
    const events = await blueskyAdapter.ingestEvents(withMark(mark), { limit: 10 });
    expect(events).toHaveLength(20);
    expect(fake.of('app.bsky.notification.listNotifications')).toHaveLength(1);
  });

  it('is bounded, and says so when more is waiting than one poll reads', async () => {
    seedMentions(400);
    const mark = new Date(BASE).toISOString();
    const events = await blueskyAdapter.ingestEvents(withMark(mark), { limit: 10 });
    expect(fake.of('app.bsky.notification.listNotifications')).toHaveLength(4);
    expect(events).toHaveLength(200);
    expect(logs.join('\n')).toMatch(/more new Bluesky notifications than one poll reads/);
  });

  it('treats a mark that is not a time as no mark', async () => {
    seedMentions(60);
    const events = await blueskyAdapter.ingestEvents(withMark('not a time'), { limit: 10 });
    expect(events).toHaveLength(50);
  });
});


describe('a burst that is only partly read', () => {
  const BASE = Date.parse('2026-11-08T10:00:00.000Z');
  const at = (i: number) => new Date(BASE + i * 1_000).toISOString();

  function seed(count: number, from = 0) {
    for (let i = from; i < from + count; i += 1) {
      const post = fake.seedPost({ id: `3kp${String(i).padStart(4, '0')}`, author: ALICE, text: `message ${i}`, createdAt: at(i) });
      fake.notify(post, 'mention');
    }
  }

  const settingsOf = (bluesky: Record<string, unknown>) => ({ bluesky: { serviceUrl: fake.origin, ...bluesky } });

  async function poll(bluesky: Record<string, unknown>, extra: Partial<Parameters<typeof blueskyAdapter.ingestEvents>[1]> = {}) {
    let progress: { complete: boolean; resume: string | null; restarted?: boolean } | undefined;
    const events = await blueskyAdapter.ingestEvents(context(ME.password, { settings: settingsOf(bluesky) }), {
      limit: 10,
      report: (p) => {
        progress = p;
      },
      ...extra,
    });
    return { events, progress: progress! };
  }

  it('says it is not finished, and where to carry on, instead of returning as if it were', async () => {
    seed(450);
    const { events, progress } = await poll({ notificationsSeenThrough: new Date(BASE - 1_000).toISOString() });
    expect(events).toHaveLength(200);
    expect(progress.complete).toBe(false);
    expect(progress.resume).toEqual(expect.any(String));
    // The newest 200 were read. The 250 older ones were not, and are what a
    // caller that moved its mark to the newest event would skip for ever.
    expect(events[events.length - 1]!.text).toBe('message 449');
    expect(events[0]!.text).toBe('message 250');
  });

  it('carries on from the continuation and reads the whole burst across polls, skipping nothing', async () => {
    seed(450);
    const mark = new Date(BASE - 1_000).toISOString();
    const seen: string[] = [];
    let resume: string | null = null;
    for (let round = 0; round < 3; round += 1) {
      const result = await poll({ notificationsSeenThrough: mark, ...(resume ? { notificationsResume: { cursor: resume, throughAt: at(449) } } : {}) });
      seen.push(...result.events.map((e) => e.text));
      resume = result.progress.resume;
      if (result.progress.complete) break;
    }
    expect(new Set(seen).size).toBe(450);
    expect(resume).toBeNull();
    // The first request of the second poll started at the cursor, not at the newest.
    const cursors = fake.of('app.bsky.notification.listNotifications').map((r) => r.query.get('cursor'));
    expect(cursors.filter((c) => c === null)).toHaveLength(1);
  });

  it('is finished when it reaches the mark', async () => {
    seed(500);
    const { events, progress } = await poll({ notificationsSeenThrough: at(480) });
    expect(events).toHaveLength(20);
    expect(progress).toMatchObject({ complete: true, resume: null });
  });

  it('is finished after one page when there is no mark, because a new link does not ingest history', async () => {
    seed(120);
    const { events, progress } = await poll({});
    expect(events).toHaveLength(50);
    expect(progress).toMatchObject({ complete: true, resume: null });
  });

  it('starts again from the newest when the server no longer honours the cursor, and says so', async () => {
    seed(120);
    fake.staleCursors.add('long-gone');
    const { events, progress } = await poll({
      notificationsSeenThrough: new Date(BASE - 1_000).toISOString(),
      notificationsResume: { cursor: 'long-gone', throughAt: at(119) },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(progress.restarted).toBe(true);
  });

  it('asks before every page after the first and charges each one it reads', async () => {
    seed(450);
    let asked = 0;
    let charged = 0;
    const { events } = await poll(
      { notificationsSeenThrough: new Date(BASE - 1_000).toISOString() },
      {
        canReadAnother: async () => {
          asked += 1;
          return true;
        },
        onRead: async () => {
          charged += 1;
        },
      },
    );
    expect(events).toHaveLength(200);
    expect(fake.of('app.bsky.notification.listNotifications')).toHaveLength(4);
    expect(charged).toBe(4);
    expect(asked).toBe(3);
  });

  it('stops paging the moment the budget says no, and says it is not finished', async () => {
    seed(450);
    let charged = 0;
    const { events, progress } = await poll(
      { notificationsSeenThrough: new Date(BASE - 1_000).toISOString() },
      {
        // Two reads left in the budget: the first page, then one more.
        canReadAnother: async () => charged < 2,
        onRead: async () => {
          charged += 1;
        },
      },
    );
    expect(fake.of('app.bsky.notification.listNotifications')).toHaveLength(2);
    expect(charged).toBe(2);
    expect(events).toHaveLength(100);
    expect(progress.complete).toBe(false);
    expect(progress.resume).toEqual(expect.any(String));
  });
});

describe('a session held by another process', () => {
  /**
   * A second copy of the channel code is a second process: the sessions are
   * module level, so a fresh module registry is a fresh, separate cache.
   */
  async function otherProcess() {
    vi.resetModules();
    const adapter = (await import('../../packages/channels/src/bluesky/index')).blueskyAdapter;
    const { cachedSessionFor } = await import('../../packages/channels/src/bluesky/client');
    return { adapter, cachedSessionFor };
  }

  const as = (generation: number, enabled = true) =>
    context(ME.password, { enabled, settings: { bluesky: { serviceUrl: fake.origin, sessionGeneration: generation } } });

  it('is ended, and not used again, once the account moves to a newer generation', async () => {
    const worker = await otherProcess();
    await worker.adapter.ingestEvents(as(0), { limit: 10 });
    const held = worker.cachedSessionFor(as(0).account.id)!;
    expect(fake.isAccessValid(held.accessJwt)).toBe(true);
    const before = fake.requests.length;

    // The API disconnected the account: all it can do is bump the generation.
    // Its own cache is a different one and cannot reach the worker's tokens.
    await worker.adapter.ingestEvents(as(1), { limit: 10 });

    const after = fake.requests.slice(before);
    // The old access token was not used for anything after the bump...
    expect(after.filter((r) => r.authorization === `Bearer ${held.accessJwt}`)).toHaveLength(0);
    // ...it was ended on Bluesky's side, with the tokens only the worker has...
    expect(fake.isAccessValid(held.accessJwt)).toBe(false);
    expect(after.filter((r) => r.nsid === 'com.atproto.server.deleteSession' && r.authorization === `Bearer ${held.refreshJwt}`)).toHaveLength(1);
    // ...and a fresh one was made for the generation the account is on now.
    expect(worker.cachedSessionFor(as(1).account.id)!.generation).toBe(1);
  });

  it('does not sign an account in again once it is switched off, and ends what it held', async () => {
    const worker = await otherProcess();
    await worker.adapter.ingestEvents(as(0), { limit: 10 });
    const held = worker.cachedSessionFor(as(0).account.id)!;
    const signIns = fake.of('com.atproto.server.createSession').length;

    const failure = await worker.adapter.ingestEvents(as(1, false), { limit: 10 }).catch((e: unknown) => e);
    // Not `instanceof`: this is a second copy of the module, which is the point.
    expect((failure as Error).name).toBe('PipelineError');
    expect(failure).toMatchObject({ errorClass: 'PERMANENT', reason: 'bluesky_disconnected' });
    expect(fake.isAccessValid(held.accessJwt)).toBe(false);
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(signIns);
    expect(worker.cachedSessionFor(as(0).account.id)).toBeNull();
  });

  it('keeps a session made under the generation the account is still on', async () => {
    const worker = await otherProcess();
    await worker.adapter.ingestEvents(as(2), { limit: 10 });
    await worker.adapter.ingestEvents(as(2), { limit: 10 });
    expect(fake.of('com.atproto.server.createSession')).toHaveLength(1);
    expect(fake.of('com.atproto.server.deleteSession')).toHaveLength(0);
  });
});
