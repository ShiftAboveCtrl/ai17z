import { PipelineError } from '@xbam/shared';
import { ContextPost, ResolvedContext } from '@xbam/shared/contracts';
import type { ChannelContext } from '../contract';
import { castRef, ownFid, readCast, type Cast } from './client';

export function castUrl(hash: string): string {
  return `https://farcaster.xyz/~/conversations/${hash}`;
}

export function textOf(cast: Cast): string {
  const { text, mentions, mentionsPositions } = cast.data.castAddBody;
  const bytes = Buffer.from(text);
  let result = '';
  let position = 0;
  mentions.forEach((fid, index) => {
    const offset = mentionsPositions[index]!;
    result += bytes.subarray(position, offset).toString('utf8') + `@fid:${fid}`;
    position = offset;
  });
  return result + bytes.subarray(position).toString('utf8');
}

export function asPost(ctx: ChannelContext, cast: Cast): ContextPost {
  return ContextPost.parse({ remoteId: castRef(cast), remoteUrl: castUrl(cast.hash),
    authorHandle: `fid:${cast.data.fid}`, text: textOf(cast),
    createdAt: new Date(Date.UTC(2021, 0, 1) + cast.data.timestamp * 1000).toISOString(),
    isSelf: cast.data.fid === ownFid(ctx), authorVerified: null });
}

export async function readPost(ctx: ChannelContext, reference: string): Promise<ContextPost> {
  return asPost(ctx, await readCast(ctx, reference));
}

export async function readThread(ctx: ChannelContext, reference: string): Promise<ResolvedContext> {
  const focal = await readCast(ctx, reference);
  const incoming = asPost(ctx, focal);
  const ancestors: ContextPost[] = [];
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
    ancestors.unshift(asPost(ctx, current));
  }
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
