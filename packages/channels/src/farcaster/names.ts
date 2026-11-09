import { z } from 'zod';
import { PipelineError } from '@xbam/shared';
import type { ChannelContext } from '../contract';
import { baseUrl, request, type Cast } from './client';

/** FID to username for the casts being rendered. A missing entry renders as `fid:<n>`. */
export type Names = ReadonlyMap<number, string>;

const MAX_CACHED = 1000;
const TTL_MS = 60 * 60_000;
/** Each lookup is a charged read, so one batch may not spend the account's read budget on names. */
const MAX_LOOKUPS_PER_BATCH = 25;

const userNameSchema = z.object({
  data: z.object({
    type: z.literal('MESSAGE_TYPE_USER_DATA_ADD'),
    fid: z.number().int().positive(),
    userDataBody: z.object({ type: z.literal('USER_DATA_TYPE_USERNAME'), value: z.string().max(64) }),
  }),
});
// An fname or an ENS name. Anything else is not rendered: the value ends up inside prompts.
const usernameShape = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const cache = new Map<string, { name: string | null; at: number }>();

export function resetFarcasterNames(): void {
  cache.clear();
}

export function handleOf(names: Names, fid: number): string {
  return names.get(fid) ?? `fid:${fid}`;
}

function remember(key: string, name: string | null, now: number): void {
  cache.delete(key);
  cache.set(key, { name, at: now });
  // Insertion order is age order, so the first key is the oldest.
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

async function lookup(ctx: ChannelContext, fid: number): Promise<string | null> {
  const body = userNameSchema.safeParse(await request(ctx, 'userDataByFid', { fid, user_data_type: 'USER_DATA_TYPE_USERNAME' }));
  // A name the node returned for a different FID is not evidence about this one.
  if (!body.success || body.data.data.fid !== fid) return null;
  const name = body.data.data.userDataBody.value.trim().toLowerCase();
  return usernameShape.test(name) ? name : null;
}

/**
 * Usernames for every author and mention in these casts, from the node's own
 * user data. Identity stays the numeric FID; a name is only how it is shown, so
 * any failure leaves the FID form rather than failing the read that wanted it.
 */
export async function resolveNames(ctx: ChannelContext, casts: Cast[]): Promise<Names> {
  const fids = new Set<number>();
  for (const cast of casts) fids.add(cast.data.fid);
  for (const cast of casts) for (const fid of cast.data.castAddBody.mentions) fids.add(fid);
  const origin = baseUrl(ctx).origin;
  const now = Date.now();
  const names = new Map<number, string>();
  let lookups = 0;
  for (const fid of fids) {
    const key = `${origin}|${fid}`;
    const hit = cache.get(key);
    if (hit && now - hit.at < TTL_MS) {
      if (hit.name) names.set(fid, hit.name);
      continue;
    }
    if (lookups === MAX_LOOKUPS_PER_BATCH) break;
    lookups += 1;
    try {
      const name = await lookup(ctx, fid);
      remember(key, name, now);
      if (name) names.set(fid, name);
    } catch (error) {
      if (error instanceof PipelineError && error.reason === 'farcaster_not_found') { remember(key, null, now); continue; }
      // Pushback, a closed budget or an outage: ask for no more names this time.
      break;
    }
  }
  return names;
}
