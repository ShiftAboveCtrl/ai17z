import { accounts, farcasterSigners } from '@xbam/database';
import { farcasterAdapter } from '@xbam/channels';
import { BadRequestError, PipelineError } from '@xbam/shared';
import { buildChannelContext } from './channelContext';

/** Called by an authenticated owner. No custody key is accepted or generated. */
export async function connectFarcaster(accountId: string, signerKey?: string) {
  const account = await accounts.requireAccount(accountId);
  if (account.channel !== 'farcaster') throw new BadRequestError('This account is not on Farcaster.');
  const attempt = await farcasterSigners.beginConnection(accountId, signerKey);
  if (!attempt) return accounts.requireAccount(accountId);
  const checking = await accounts.requireAccount(accountId);
  try {
    const context = await buildChannelContext(checking, null);
    const result = await farcasterAdapter.connect({ ...context, signerKey: async () => attempt.signerKey });
    await farcasterSigners.finishConnection(accountId, attempt.generation, result);
    return accounts.requireAccount(accountId);
  } catch (error) {
    const detail = error instanceof PipelineError ? error.message : 'Farcaster could not be connected.';
    await farcasterSigners.finishConnection(accountId, attempt.generation, {
      status: error instanceof PipelineError && error.errorClass === 'PERMANENT' ? 'NEEDS_AUTH' : 'DISCONNECTED',
      detail, error: detail,
    });
    throw error;
  }
}
