import { PipelineError } from '@xbam/shared';
import { ContextPost, ResolvedContext } from '@xbam/shared/contracts';
import type { ChannelContext } from '../contract';
import { castRef, ownFid, readCast, type Cast } from './client';
import { handleOf, resolveNames, type Names } from './names';

export function castUrl(hash: string): string {
  return `https://farcaster.xyz/~/conversations/${hash}`;
}

const NO_NAMES: Names = new Map();

export function textOf(cast: Cast, names: Names = NO_NAMES): string {
  const { text, mentions, mentionsPositions } = cast.data.castAddBody;
  const bytes = Buffer.from(text);
  let result = '';
  let position = 0;
  mentions.forEach((fid, index) => {
    const offset = mentionsPositions[index]!;
    const name = names.get(fid);
    result += bytes.subarray(position, offset).toString('utf8') + (name ? `@${name}` : `@fid:${fid}`);
    position = offset;
  });
  return result + bytes.subarray(position).toString('utf8');
}

/** The author is shown by username where the node has one; the FID stays the identity. */
export function asPost(ctx: ChannelContext, cast: Cast, names: Names = NO_NAMES): ContextPost {
  return ContextPost.parse({ remoteId: castRef(cast), remoteUrl: castUrl(cast.hash),
    authorHandle: handleOf(names, cast.data.fid), text: textOf(cast, names),
    createdAt: new Date(Date.UTC(2021, 0, 1) + cast.data.timestamp * 1000).toISOString(),
    isSelf: cast.data.fid === ownFid(ctx), authorVerified: null });
}

export async function readPost(ctx: ChannelContext, reference: string): Promise<ContextPost> {
  const cast = await readCast(ctx, reference);
  return asPost(ctx, cast, await resolveNames(ctx, [cast]));
}

export async function readThread(ctx: ChannelContext, reference: string): Promise<ResolvedContext> {
  const focal = await readCast(ctx, reference);
  const casts: Cast[] = [];
  const seen = new Set([reference]);
  let current = focal;
  let note = '';
  for (let depth = 0; current.data.castAddBody.parentCastId; depth += 1) {
    if (depth === 12) { note = 'The conversation continues beyond the ancestor read limit.'; break; }
    const parent = current.data.castAddBody.parentCastId;
    const ref = `farcaster:${parent.fid}:${parent.hash}`;
    if (seen.has(ref)) throw PipelineError.permanent('farcaster_cyclic_thread', 'The node returned a cyclic conversation.');
    seen.add(ref);
    try {
      current = await readCast(ctx, ref);
    } catch (error) {
      if (!(error instanceof PipelineError) || error.reason !== 'farcaster_not_found') throw error;
      note = 'An ancestor is unavailable on this Farcaster node.';
      break;
    }
    casts.unshift(current);
  }
  // Names are read once the whole chain is known, so the same author is asked for once.
  const names = await resolveNames(ctx, [focal, ...casts]);
  const ancestors = casts.map((c) => asPost(ctx, c, names));
  const incoming = asPost(ctx, focal, names);
  const parent = ancestors.at(-1) ?? null;
  const root = ancestors[0] ?? incoming;
  return ResolvedContext.parse({ targetRef: reference, targetUrl: incoming.remoteUrl,
    targetAuthorHandle: incoming.authorHandle, conversationRef: root.remoteId,
    incomingText: incoming.text, parentText: parent?.text ?? null,
    thread: ancestors.map((p) => ({ role: p.isSelf ? 'OUTBOUND' : 'INBOUND', remoteMessageId: p.remoteId,
      authorHandle: p.authorHandle, text: p.text, createdAt: p.createdAt })),
    conversation: { incoming, parent, ancestors, root, quote: null,
      participants: [...new Set([...ancestors, incoming].map((p) => p.authorHandle!))],
      excludedCount: 0, method: 'STATUS_ANCHORED', branchConfirmed: !note, note }, meta: {} });
}
