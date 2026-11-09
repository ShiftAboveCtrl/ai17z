import { z } from 'zod';
import { NormalizedEvent } from '@xbam/shared/contracts';
import type { ChannelContext, IngestOptions } from '../contract';
import { CastReference, castRef, ownFid, page, parseReference, unreadable, type Cast } from './client';
import { asPost } from './reads';

const cursorSchema = z.object({
  surface: z.enum(['mentions', 'own', 'replies']),
  mentionToken: z.string().default(''), ownToken: z.string().default(''),
  parents: z.array(CastReference).max(100).default([]), replyToken: z.string().default(''),
});

function eventOf(ctx: ChannelContext, cast: Cast, reply: boolean): NormalizedEvent {
  const post = asPost(ctx, cast);
  const parent = cast.data.castAddBody.parentCastId;
  return NormalizedEvent.parse({ channel: 'farcaster', type: reply ? 'REPLY' : 'MENTION',
    remoteEventId: cast.hash, remoteMessageId: post.remoteId, remoteAuthorId: String(cast.data.fid),
    remoteAuthorHandle: post.authorHandle, remoteAuthorDisplayName: null,
    remoteConversationId: parent ? `farcaster:${parent.fid}:${parent.hash}` : post.remoteId,
    parentRemoteMessageId: parent ? `farcaster:${parent.fid}:${parent.hash}` : null,
    remoteUrl: post.remoteUrl, text: post.text, occurredAt: post.createdAt, raw: {} });
}

/** One page per cadence claim. Mention reads alternate with own-thread reads. */
export async function ingestEvents(ctx: ChannelContext, options: IngestOptions): Promise<NormalizedEvent[]> {
  let decoded: unknown = { surface: 'mentions' };
  if (options.cursor) {
    try { decoded = JSON.parse(options.cursor); } catch { throw unreadable(); }
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw unreadable();
  const state = parsed.data;
  const fid = ownFid(ctx);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  let events: NormalizedEvent[] = [];
  if (state.surface === 'mentions') {
    const result = await page(ctx, 'castsByMention', { fid, pageSize: limit, pageToken: state.mentionToken });
    if (result.casts.some((c) => !c.data.castAddBody.mentions.includes(fid))) throw unreadable();
    events = result.casts.filter((c) => c.data.fid !== fid).map((c) => eventOf(ctx, c,
      c.data.castAddBody.parentCastId?.fid === fid));
    state.mentionToken = result.token;
    state.surface = state.parents.length ? 'replies' : 'own';
  } else if (state.surface === 'own') {
    const result = await page(ctx, 'castsByFid', { fid, pageSize: limit, pageToken: state.ownToken });
    if (result.casts.some((c) => c.data.fid !== fid)) throw unreadable();
    state.parents = result.casts.map(castRef);
    state.ownToken = result.token;
    state.surface = 'mentions';
  } else {
    const reference = state.parents[0];
    if (!reference) throw unreadable();
    const target = parseReference(reference);
    const result = await page(ctx, 'castsByParent', { ...target, pageSize: limit, pageToken: state.replyToken });
    if (result.casts.some((c) => {
      const parent = c.data.castAddBody.parentCastId;
      return parent?.fid !== target.fid || parent.hash !== target.hash;
    })) throw unreadable();
    events = result.casts.filter((c) => c.data.fid !== fid).map((c) => eventOf(ctx, c, true));
    state.replyToken = result.token;
    if (!result.token) state.parents.shift();
    state.surface = 'mentions';
  }
  options.reportCursor?.(JSON.stringify(state));
  return events;
}
