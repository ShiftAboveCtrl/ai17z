import { Message } from '@farcaster/core';
import { channelState } from '@xbam/database';
import { PipelineError } from '@xbam/shared';
import type { ActionRequest, ChannelAdapter, ChannelContext } from '../contract';
import { ownFid, readCast, request, unreadable } from './client';
import { castUrl, readThread } from './reads';
import { ingestEvents } from './poll';
import { digestFor, messageHash, preparedMessage, readReaction, signMessage } from './writes';

export const farcasterAdapter: ChannelAdapter = {
  id: 'farcaster', displayName: 'Farcaster', requiresBrowser: false,
  capabilities: ['REPLY', 'POST', 'LIKE', 'REPOST'],
  async connect(ctx) {
    if (!(await ctx.signerKey?.())) return { status: 'NEEDS_AUTH', detail: 'Store an authorized Farcaster app signer.' };
    const probe = await signMessage(ctx, { type: 'POST', targetRef: null, text: 'Signer authorization check.',
      dryRun: true, idempotencyKey: 'connect' });
    const result = await request(ctx, 'validateMessage', {}, Message.encode(probe).finish(), true) as { valid?: unknown };
    if (result?.valid !== true) {
      return { status: 'NEEDS_AUTH', detail: 'The Farcaster node did not validate this app signer for the FID.' };
    }
    return { status: 'CONNECTED', remoteAccountId: String(ownFid(ctx)), detail: 'The Farcaster node validated the app signer. No cast was submitted.' };
  },
  async disconnect() {
    // The runtime removes the sealed local key. Remote revocation is an owner action.
  },
  async healthCheck(ctx) {
    const result = await farcasterAdapter.connect(ctx);
    return { status: result.status === 'CONNECTED' ? 'healthy' : 'offline',
      authenticated: result.status === 'CONNECTED', detail: result.detail };
  },
  ingestEvents,
  async resolveContext(ctx, event) {
    const reference = event.remoteMessageId;
    if (!reference) throw PipelineError.permanent('farcaster_bad_reference', 'The incoming event has no Farcaster cast reference.');
    return readThread(ctx, reference);
  },
  async verifyAction(ctx, action) {
    if (!farcasterAdapter.capabilities.includes(action.type)) {
      throw PipelineError.permanent('farcaster_unsupported_action', 'This action is not supported by the Farcaster channel.');
    }
    ownFid(ctx);
    if (action.type === 'POST') {
      if (action.targetRef !== null) throw PipelineError.permanent('farcaster_bad_reference', 'An original cast cannot have a reply target.');
      return { verified: true, detail: 'An original cast has no target.', targetRef: null, targetUrl: null,
        targetAuthorHandle: null, evidence: {} };
    }
    const cast = await readCast(ctx, action.targetRef ?? '');
    return { verified: true, detail: 'The full cast hash and author FID match the action target.',
      targetRef: action.targetRef, targetUrl: castUrl(cast.hash), targetAuthorHandle: `fid:${cast.data.fid}`, evidence: {} };
  },
  async executeAction(ctx, action) {
    const verification = await farcasterAdapter.verifyAction(ctx, action);
    if (action.dryRun) return { status: 'DRY_RUN', remoteActionId: null, remoteActionUrl: null, verification };
    if (action.type === 'LIKE' || action.type === 'REPOST') {
      const existing = await readReaction(ctx, action);
      if (existing) return { status: 'EXECUTED', remoteActionId: existing,
        remoteActionUrl: verification.targetUrl, verification: { ...verification, detail: 'This reaction is already present.' } };
    }
    const message = await preparedMessage(ctx, action);
    const hash = messageHash(message);
    const response = await request(ctx, 'submitMessage', {}, Message.encode(message).finish()) as { hash?: unknown };
    if (response?.hash !== hash) throw unreadable();
    // The node accepted these exact bytes, so a read that cannot see them yet is
    // lag, not failure. Retrying resends the persisted message and gets the same hash.
    const lagging = () => PipelineError.retryable('farcaster_readback_pending',
      'The Farcaster node accepted the message but cannot show it yet.');
    if (action.type === 'POST' || action.type === 'REPLY') {
      try { await readCast(ctx, `farcaster:${ownFid(ctx)}:${hash}`); } catch (error) {
        if (error instanceof PipelineError && error.reason === 'farcaster_not_found') throw lagging();
        throw error;
      }
    } else if (!(await readReaction(ctx, action))) throw lagging();
    return { status: 'EXECUTED', remoteActionId: hash,
      remoteActionUrl: action.type === 'POST' || action.type === 'REPLY' ? castUrl(hash) : verification.targetUrl,
      verification: { ...verification, detail: 'The Farcaster node accepted the signed message and it was read back.' } };
  },
  async wasAlreadyDone(ctx: ChannelContext, action: ActionRequest) {
    if (action.type === 'LIKE' || action.type === 'REPOST') {
      const hash = await readReaction(ctx, action);
      return { done: Boolean(hash), conclusive: true, remoteActionId: hash,
        remoteActionUrl: null, detail: hash ? 'The reaction is already present.' : 'The reaction is absent.' };
    }
    const bytes = await channelState.outgoingMessage(ctx.account.id, action.idempotencyKey, digestFor(ctx, action));
    if (!bytes) return { done: false, conclusive: true, remoteActionId: null, remoteActionUrl: null, detail: 'No signed message was prepared.' };
    const hash = messageHash(Message.decode(bytes));
    try {
      await readCast(ctx, `farcaster:${ownFid(ctx)}:${hash}`);
      return { done: true, remoteActionId: hash, remoteActionUrl: castUrl(hash), detail: 'The exact signed cast is already present.' };
    } catch (error) {
      if (!(error instanceof PipelineError) || error.reason !== 'farcaster_not_found') throw error;
      // Absence on one node can lag. Replaying these persisted bytes is still safe.
      return { done: false, conclusive: true, remoteActionId: null, remoteActionUrl: null, detail: 'The prepared cast is absent; its exact bytes can be resubmitted safely.' };
    }
  },
  async captureDiagnostics() { return null; },
};
