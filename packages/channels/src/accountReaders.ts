import { networkHas } from '@xbam/shared/contracts';
import { xIntelligence } from './x/intelligence/index';

/**
 * Which canonical reader answers "who is this, what do they post, what is above
 * this post" for a channel.
 *
 * A dispatch table rather than an `if (channel === 'x')` in each caller. The
 * worker's account reads, the persona collector and the Response Lab all need
 * the same answer, and each used to name X directly, so each would have been
 * edited again for every network. They ask here instead.
 *
 * Two things have to be true for a reader to be handed out: the network's
 * profile says it has account reads, and a reader is registered for it. A
 * channel with only one of those gets `null`, which every caller treats as "this
 * network cannot be read this way" and answers with a refusal, never a throw.
 */
export type AccountReader = typeof xIntelligence;

const READERS = new Map<string, AccountReader>([['x', xIntelligence]]);

export function accountReaderFor(channel: string | null | undefined): AccountReader | null {
  if (!channel || !networkHas(channel, 'accountReads')) return null;
  return READERS.get(channel) ?? null;
}

/** Whether an account on this channel can be used to read other people's accounts and posts. */
export function canReadAccounts(channel: string | null | undefined): boolean {
  return accountReaderFor(channel) !== null;
}
