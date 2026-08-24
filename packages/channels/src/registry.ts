import type { ChannelId } from '@xbam/shared/contracts';
import { BadRequestError } from '@xbam/shared';
import type { ChannelAdapter } from './contract';
import { mockAdapter } from './mock/index';
import { xAdapter } from './x/index';

const ADAPTERS = new Map<ChannelId, ChannelAdapter>([
  ['mock', mockAdapter],
  ['x', xAdapter],
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

export function isChannelImplemented(channel: ChannelId): boolean {
  return ADAPTERS.has(channel);
}
