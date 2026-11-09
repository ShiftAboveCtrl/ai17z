import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFarcasterNames } from '../../packages/channels/src/farcaster/names';
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

  describe('usernames', () => {
    const named = (fid: number, value: string, dataFid = fid) => ({ data: { type: 'MESSAGE_TYPE_USER_DATA_ADD', fid: dataFid,
      userDataBody: { type: 'USER_DATA_TYPE_USERNAME', value } } });
    /** A node that answers pages with `page` and userDataByFid from `directory`; records every URL asked. */
    function node(page: unknown, directory: Record<number, unknown>) {
      const asked: URL[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        asked.push(url);
        if (url.pathname !== '/v1/userDataByFid') return Response.json(page);
        const found = directory[Number(url.searchParams.get('fid'))];
        return found === undefined ? Response.json({ errCode: 'not_found' }, { status: 404 }) : Response.json(found);
      }));
      return { names: () => asked.filter((u) => u.pathname === '/v1/userDataByFid') };
    }
    beforeEach(() => resetFarcasterNames());

    it('shows authors and mentions by username, keeps the FID as identity, and asks once per FID', async () => {
      const hub = node({ messages: [cast()], nextPageToken: '' }, { 22: named(22, 'alice'), 11: named(11, 'ourbot') });
      const adapter = getChannelAdapter('farcaster');
      const [event] = await adapter.ingestEvents(context(), { limit: 10 });
      expect(event).toMatchObject({ remoteAuthorHandle: 'alice', remoteAuthorId: '22', remoteMessageId: ref, text: 'hello @ourbot' });
      expect(hub.names().map((u) => u.searchParams.get('user_data_type'))).toEqual(['USER_DATA_TYPE_USERNAME', 'USER_DATA_TYPE_USERNAME']);
      await adapter.ingestEvents(context(), { limit: 10 });
      expect(hub.names()).toHaveLength(2);
    });

    it('falls back to the FID when a name is absent, belongs to another FID or is not a username', async () => {
      node({ messages: [cast()], nextPageToken: '' }, { 22: named(22, 'alice', 99), 11: named(11, 'not a name <b>') });
      const [event] = await getChannelAdapter('farcaster').ingestEvents(context(), { limit: 10 });
      expect(event).toMatchObject({ remoteAuthorHandle: 'fid:22', remoteAuthorId: '22', text: 'hello @fid:11' });
    });

    it('still reads when the node refuses name lookups, and stops asking for more', async () => {
      const asked: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        asked.push(url.pathname);
        return url.pathname === '/v1/userDataByFid'
          ? new Response('no', { status: 429, headers: { 'Retry-After': '30' } })
          : Response.json({ messages: [cast()], nextPageToken: '' });
      }));
      const [event] = await getChannelAdapter('farcaster').ingestEvents(context(), { limit: 10 });
      expect(event).toMatchObject({ remoteAuthorHandle: 'fid:22', text: 'hello @fid:11' });
      expect(asked.filter((p) => p === '/v1/userDataByFid')).toHaveLength(1);
    });

    it('bounds the lookups one page may cost', async () => {
      const casts = Array.from({ length: 40 }, (_, i) => cast({ hash: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        data: { ...cast().data, fid: 1000 + i, castAddBody: { ...cast().data.castAddBody } } }));
      const hub = node({ messages: casts, nextPageToken: '' }, {});
      const events = await getChannelAdapter('farcaster').ingestEvents(context(), { limit: 100 });
      expect(events).toHaveLength(40);
      expect(hub.names()).toHaveLength(25);
    });
  });

  describe('own cast walk', () => {
    const own = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
    const ownCast = (n: number) => cast({ hash: own(n), data: { ...cast().data, fid: 11, timestamp: n,
      castAddBody: { text: `own ${n}`, mentions: [], mentionsPositions: [], embeds: [], embedsDeprecated: [] } } });

    it('ends a new walk at the newest cast the last one saw instead of reading the history again', async () => {
      let history = [4, 3, 2, 1];
      const own_pages: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (url.pathname !== '/v1/castsByFid') return Response.json({ messages: [], nextPageToken: '' });
        expect(url.searchParams.get('reverse')).toBe('true');
        const start = Number(url.searchParams.get('pageToken') || 0);
        own_pages.push(`${start}`);
        const slice = history.slice(start, start + 2);
        return Response.json({ messages: slice.map(ownCast), nextPageToken: start + 2 < history.length ? String(start + 2) : '' });
      }));
      const adapter = getChannelAdapter('farcaster');
      let cursor: string | null = null;
      const walk = async () => {
        // Cycle until the own-cast surface has been read through to a stop.
        for (let i = 0; i < 40; i += 1) {
          await adapter.ingestEvents(context(), { limit: 2, cursor, reportCursor: (c) => { cursor = c; } });
          const state = JSON.parse(cursor!);
          if (state.surface === 'mentions' && state.ownToken === '' && state.parents.length === 0 && own_pages.length) return state;
        }
        throw new Error('The walk never finished.');
      };
      const first = await walk();
      expect(first.ownSeen).toBe(own(4));
      expect(own_pages).toEqual(['0', '2']);
      own_pages.length = 0;
      history = [5, ...history];
      const second = await walk();
      expect(second.ownSeen).toBe(own(5));
      expect(own_pages).toEqual(['0']);
    });
  });

  it('rejects malformed feeds instead of silently advancing past them', async () => {
    http(() => ({ messages: [cast({ hash: 'bad' })], nextPageToken: '' }));
    await expect(getChannelAdapter('farcaster').ingestEvents(context(), { limit: 10 }))
      .rejects.toMatchObject({ reason: 'farcaster_unreadable' });
  });
});
