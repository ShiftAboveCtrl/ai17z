import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChannelAdapter } from '@xbam/channels';
import { createLogger } from '@xbam/shared';
import { syntheticAccount } from '@xbam/runtime';
import type { ChannelContext } from '@xbam/channels';
import { digestFor } from '../../packages/channels/src/farcaster/writes';

const hash = `0x${'ab'.repeat(20)}`;
const parent = `0x${'cd'.repeat(20)}`;
const ref = `farcaster:22:${hash}`;
const cast = (overrides = {}) => ({
  hash,
  data: { type: 'MESSAGE_TYPE_CAST_ADD', fid: 22, timestamp: 100,
    network: 'FARCASTER_NETWORK_MAINNET',
    castAddBody: { text: 'hello ', mentions: [11], mentionsPositions: [6], embeds: [], embedsDeprecated: [] } },
  ...overrides,
});
const context = (): ChannelContext => ({
  account: syntheticAccount({ id: 'unit-farcaster', ownerId: 'owner', channel: 'farcaster',
    remoteAccountId: '11', settings: { farcaster: { hubUrl: 'https://hub.example.test' } } }),
  session: null, storageDir: '', logger: createLogger('test'), jobId: null,
});
function http(handler: (url: URL) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => Response.json(handler(new URL(url)))));
}
afterEach(() => vi.unstubAllGlobals());

describe('Farcaster HTTP channel', () => {
  it('supports casts, replies, likes and recasts without a browser', () => {
    const adapter = getChannelAdapter('farcaster');
    expect(adapter.requiresBrowser).toBe(false);
    expect(adapter.capabilities).toEqual(['REPLY', 'POST', 'LIKE', 'REPOST']);
  });

  it('uses one reaction request digest for pipeline and capability writers', () => {
    const request = { type: 'LIKE' as const, targetRef: ref, text: '', idempotencyKey: 'shared-key', dryRun: false };
    expect(digestFor(context(), request)).toBe(digestFor(context(), { ...request, text: 'Pipeline output is irrelevant to a reaction.' }));
    const reply = { ...request, type: 'REPLY' as const };
    expect(digestFor(context(), reply)).not.toBe(digestFor(context(), { ...reply, text: 'Different reply' }));
  });

  it('normalizes mentions using full cast hashes and restores byte-position mentions', async () => {
    http((url) => {
      expect(url.pathname).toBe('/v1/castsByMention');
      expect(url.searchParams.get('fid')).toBe('11');
      return { messages: [cast()], nextPageToken: '' };
    });
    const events = await getChannelAdapter('farcaster').ingestEvents(context(), { limit: 10 });
    expect(events).toEqual([expect.objectContaining({ channel: 'farcaster', type: 'MENTION',
      remoteEventId: hash, remoteMessageId: ref, remoteAuthorId: '22', text: 'hello @fid:11',
      occurredAt: '2021-01-01T00:01:40.000Z' })]);
  });

  it('keeps the incoming cast as target while walking ancestors', async () => {
    http((url) => url.searchParams.get('hash') === hash
      ? cast({ data: { ...cast().data, castAddBody: { ...cast().data.castAddBody,
        parentCastId: { fid: 33, hash: parent } } } })
      : cast({ hash: parent, data: { ...cast().data, fid: 33 } }));
    const adapter = getChannelAdapter('farcaster');
    const event = { channel: 'farcaster', type: 'MENTION', remoteEventId: hash, remoteMessageId: ref,
      remoteAuthorId: '22', remoteAuthorHandle: null, remoteAuthorDisplayName: null,
      remoteConversationId: ref, parentRemoteMessageId: null, remoteUrl: null,
      text: 'incoming', occurredAt: null, raw: {} } as const;
    const resolved = await adapter.resolveContext(context(), event);
    expect(resolved.targetRef).toBe(ref);
    expect(resolved.conversationRef).toBe(`farcaster:33:${parent}`);
    expect(resolved.conversation?.ancestors.map((p) => p.remoteId)).toEqual([`farcaster:33:${parent}`]);
  });

  it('refuses an HTTP response for a different cast before acting', async () => {
    http(() => cast({ hash: parent }));
    await expect(getChannelAdapter('farcaster').verifyAction(context(), {
      type: 'LIKE', targetRef: ref, text: '', idempotencyKey: 'test', dryRun: false,
    })).rejects.toMatchObject({ errorClass: 'PERMANENT', reason: 'farcaster_target_mismatch' });
  });

  it('classifies a rate limit without exposing the remote error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private server internals', {
      status: 429, headers: { 'Retry-After': '37' },
    })));
    await expect(getChannelAdapter('farcaster').ingestEvents(context(), { limit: 10 }))
      .rejects.toMatchObject({ errorClass: 'RETRYABLE', data: { retryAfterMs: 37_000 } });
  });

  it('rejects malformed feeds instead of silently advancing past them', async () => {
    http(() => ({ messages: [cast({ hash: 'bad' })], nextPageToken: '' }));
    await expect(getChannelAdapter('farcaster').ingestEvents(context(), { limit: 10 }))
      .rejects.toMatchObject({ reason: 'farcaster_unreadable' });
  });
});
