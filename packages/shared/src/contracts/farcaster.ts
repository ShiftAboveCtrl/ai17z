import { z } from 'zod';

/** Public configuration contains only the operator's node origin. */
export const FarcasterNodeOrigin = z.string().url().max(2000).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}, 'Use an HTTPS origin, or HTTP on loopback, without credentials, paths or query parameters.');

export const FarcasterSettings = z.object({ farcaster: z.object({ hubUrl: FarcasterNodeOrigin }).strict() }).strict();
export const FarcasterFid = z.string().regex(/^[1-9][0-9]*$/).refine((value) => Number.isSafeInteger(Number(value)));
