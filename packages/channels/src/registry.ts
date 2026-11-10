import type { ChannelId } from '@xbam/shared/contracts';
import { BadRequestError } from '@xbam/shared';
import type { ChannelAdapter } from './contract';
import { mockAdapter } from './mock/index';
import { xAdapter } from './x/index';
import { telegramAdapter } from './telegram/index';
import { farcasterAdapter } from './farcaster/index';
import { blueskyAdapter } from './bluesky/index';

const ADAPTERS = new Map<ChannelId, ChannelAdapter>([
  ['mock', mockAdapter],
  ['x', xAdapter],
  ['telegram', telegramAdapter],
  ['farcaster', farcasterAdapter],
  ['bluesky', blueskyAdapter],
]);

export function getChannelAdapter(channel: ChannelId): ChannelAdapter {
  const adapter = ADAPTERS.get(channel);
  if (!adapter) {
    throw new BadRequestError(
      `Channel "${channel}" has no adapter yet. Implemented channels: ${[...ADAPTERS.keys()].join(', ')}.`,
    );
  }
  return adapter;
}

export function listChannelAdapters(): ChannelAdapter[] {
  return [...ADAPTERS.values()];
}

/**
 * Whether an account on this channel has a sign-in that can lapse.
 *
 * True for a browser channel and for one that signs in with a stored app
 * password; false for the mock channel, which has nothing to be signed out of.
 */
export function channelHasSignIn(channel: ChannelId): boolean {
  const adapter = ADAPTERS.get(channel);
  return Boolean(adapter && (adapter.requiresBrowser || adapter.signInKind || ['telegram', 'farcaster'].includes(channel)));
}

export function isChannelImplemented(channel: ChannelId): boolean {
  return ADAPTERS.has(channel);
}
