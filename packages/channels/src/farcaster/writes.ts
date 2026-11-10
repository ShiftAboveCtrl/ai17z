import { CastType, FarcasterNetwork, Message, NobleEd25519Signer, ReactionType,
  makeCastAdd, makeReactionAdd } from '@farcaster/core';
import { z } from 'zod';
import { channelState } from '@xbam/database';
import { PipelineError, sha256Hex } from '@xbam/shared';
import type { ActionRequest, ChannelContext } from '../contract';
import { ownFid, parseReference, request, unreadable } from './client';

const reactionSchema = z.object({
  hash: z.string().regex(/^0x[a-f0-9]{40}$/),
  data: z.object({ fid: z.number().int().positive(), type: z.literal('MESSAGE_TYPE_REACTION_ADD'),
    network: z.literal('FARCASTER_NETWORK_MAINNET'), reactionBody: z.object({
      type: z.enum(['REACTION_TYPE_LIKE', 'REACTION_TYPE_RECAST']),
      targetCastId: z.object({ fid: z.number().int().positive(), hash: z.string().regex(/^0x[a-f0-9]{40}$/) }),
    }),
  }),
});

export function digestFor(ctx: ChannelContext, action: ActionRequest): string {
  const text = action.type === 'POST' || action.type === 'REPLY' ? action.text : '';
  return sha256Hex(JSON.stringify([ownFid(ctx), 'MAINNET', action.type, action.targetRef, text]));
}

export async function signMessage(ctx: ChannelContext, action: ActionRequest): Promise<Message> {
  const key = await ctx.signerKey?.();
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) {
    throw PipelineError.permanent('farcaster_no_signer', 'Store an authorized Farcaster app signing key before acting.');
  }
  const signer = new NobleEd25519Signer(Buffer.from(key, 'hex'));
  const options = { fid: ownFid(ctx), network: FarcasterNetwork.MAINNET };
  if (action.type === 'POST' || action.type === 'REPLY') {
    if (!action.text.trim() || Buffer.byteLength(action.text) > 320) {
      throw PipelineError.permanent('farcaster_cast_length', 'A Farcaster cast must contain text and fit within 320 UTF-8 bytes.');
    }
    const target = action.type === 'REPLY' ? parseReference(action.targetRef) : null;
    const result = await makeCastAdd({ text: action.text, type: CastType.CAST, formatVersion: 0,
      embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [],
      ...(target ? { parentCastId: { fid: target.fid, hash: Buffer.from(target.hash.slice(2), 'hex') } } : {}),
    }, options, signer);
    if (result.isErr()) throw PipelineError.permanent('farcaster_invalid_message', 'This Farcaster cast could not be signed. Check its text and target.');
    return result.value;
  }
  if (action.type !== 'LIKE' && action.type !== 'REPOST') {
    throw PipelineError.permanent('farcaster_unsupported_action', 'This action is not supported by the Farcaster channel.');
  }
  const target = parseReference(action.targetRef);
  const result = await makeReactionAdd({ type: action.type === 'LIKE' ? ReactionType.LIKE : ReactionType.RECAST,
    targetCastId: { fid: target.fid, hash: Buffer.from(target.hash.slice(2), 'hex') },
  }, options, signer);
  if (result.isErr()) throw PipelineError.permanent('farcaster_invalid_message', 'This Farcaster reaction could not be signed.');
  return result.value;
}

/** The insert wins before any POST. Competing workers reuse the winning bytes. */
export async function preparedMessage(ctx: ChannelContext, action: ActionRequest): Promise<Message> {
  const digest = digestFor(ctx, action);
  const old = await channelState.outgoingMessage(ctx.account.id, action.idempotencyKey, digest);
  if (old) return Message.decode(old);
  const message = await signMessage(ctx, action);
  const bytes = await channelState.prepareOutgoing(ctx.account.id, action.idempotencyKey, digest, Message.encode(message).finish());
  return Message.decode(bytes);
}

export function messageHash(message: Message): string {
  return `0x${Buffer.from(message.hash).toString('hex')}`;
}

export async function readReaction(ctx: ChannelContext, action: ActionRequest): Promise<string | null> {
  const target = parseReference(action.targetRef);
  try {
    const body = await request(ctx, 'reactionById', { fid: ownFid(ctx), target_fid: target.fid,
      target_hash: target.hash, reaction_type: action.type === 'LIKE' ? 'Like' : 'Recast' });
    // Hub HTTP uses hex hashes. Protobuf JSON codecs expect base64 bytes,
    // so using Message.fromJSON here would change the target identity.
    const parsed = reactionSchema.safeParse(body);
    if (!parsed.success) throw unreadable();
    const message = parsed.data;
    const reaction = message.data.reactionBody;
    if (message.data.fid !== ownFid(ctx) ||
      reaction.type !== (action.type === 'LIKE' ? 'REACTION_TYPE_LIKE' : 'REACTION_TYPE_RECAST') ||
      reaction.targetCastId.fid !== target.fid || reaction.targetCastId.hash !== target.hash) throw unreadable();
    return message.hash;
  } catch (error) {
    if (error instanceof PipelineError && error.reason === 'farcaster_not_found') return null;
    throw error;
  }
}
