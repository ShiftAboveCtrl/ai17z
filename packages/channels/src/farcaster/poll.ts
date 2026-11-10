import { z } from 'zod';
import { NormalizedEvent } from '@xbam/shared/contracts';
import type { ChannelContext, IngestOptions } from '../contract';
import { CastReference, castRef, ownFid, page, parseReference, unreadable, type Cast } from './client';
import { resolveNames, type Names } from './names';
import { asPost } from './reads';

const cursorSchema = z.object({
  surface: z.enum(['mentions', 'own', 'replies']),
  mentionToken: z.string().default(''), ownToken: z.string().default(''),
  parents: z.array(CastReference).max(100).default([]), replyToken: z.string().default(''),
  // The newest own cast a finished walk reached, and the newest one the walk in progress began at.
  ownSeen: z.string().default(''), ownHead: z.string().default(''),
});

function eventOf(ctx: ChannelContext, cast: Cast, reply: boolean, names: Names): NormalizedEvent {
  const post = asPost(ctx, cast, names);
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
    const others = result.casts.filter((c) => c.data.fid !== fid);
    const names = await resolveNames(ctx, others);
    events = others.map((c) => eventOf(ctx, c, c.data.castAddBody.parentCastId?.fid === fid, names));
    state.mentionToken = result.token;
    state.surface = state.parents.length ? 'replies' : 'own';
  } else if (state.surface === 'own') {
    // Newest first, so a walk can end where the previous one began instead of
    // reading the whole history again every time it comes round.
    const result = await page(ctx, 'castsByFid', { fid, pageSize: limit, pageToken: state.ownToken, reverse: 'true' });
    if (result.casts.some((c) => c.data.fid !== fid)) throw unreadable();
    if (!state.ownToken && result.casts[0]) state.ownHead = result.casts[0].hash;
    const boundary = state.ownSeen ? result.casts.findIndex((c) => c.hash === state.ownSeen) : -1;
    const fresh = boundary < 0 ? result.casts : result.casts.slice(0, boundary);
    state.parents = fresh.map(castRef);
    if (boundary >= 0 || !result.token) {
      state.ownSeen = state.ownHead || state.ownSeen;
      state.ownToken = '';
    } else state.ownToken = result.token;
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
    const others = result.casts.filter((c) => c.data.fid !== fid);
    const names = await resolveNames(ctx, others);
    events = others.map((c) => eventOf(ctx, c, true, names));
    state.replyToken = result.token;
    if (!result.token) state.parents.shift();
    state.surface = 'mentions';
  }
  options.reportCursor?.(JSON.stringify(state));
  return events;
}
