import { z } from 'zod';
import { PipelineError } from '@xbam/shared';
import { FarcasterSettings } from '@xbam/shared/contracts';
import type { ChannelContext } from '../contract';

export const CastReference = z.string().regex(/^farcaster:[1-9][0-9]*:0x[a-f0-9]{40}$/)
  .refine((s) => Number.isSafeInteger(Number(s.split(':')[1])));
const fidSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/).transform((s) => s.toLowerCase());
export const castSchema = z.object({
  hash: hashSchema,
  data: z.object({
    type: z.literal('MESSAGE_TYPE_CAST_ADD'), fid: fidSchema,
    timestamp: z.number().int().nonnegative().max(0xffffffff),
    network: z.literal('FARCASTER_NETWORK_MAINNET'),
    castAddBody: z.object({
      text: z.string().max(50_000), mentions: z.array(fidSchema),
      mentionsPositions: z.array(z.number().int().nonnegative()),
      parentCastId: z.object({ fid: fidSchema, hash: hashSchema }).optional(),
    }),
  }),
});
export type Cast = z.infer<typeof castSchema>;

export function unreadable(): PipelineError {
  return PipelineError.retryable('farcaster_unreadable', 'The Farcaster node returned a response that could not be read.');
}

export function parseCast(value: unknown): Cast {
  const result = castSchema.safeParse(value);
  if (!result.success) throw unreadable();
  // A bad UTF-8 offset would silently change who the text says was mentioned.
  const { text, mentions, mentionsPositions } = result.data.data.castAddBody;
  const bytes = Buffer.from(text);
  if (mentions.length !== mentionsPositions.length || mentionsPositions.some((p, i) =>
    p > bytes.length || (i > 0 && p < mentionsPositions[i - 1]!) || (p < bytes.length && (bytes[p]! & 0xc0) === 0x80))) {
    throw unreadable();
  }
  return result.data;
}

export function castRef(cast: Cast): string {
  return `farcaster:${cast.data.fid}:${cast.hash}`;
}

export function parseReference(reference: string | null): { fid: number; hash: string } {
  if (!CastReference.safeParse(reference).success) {
    throw PipelineError.permanent('farcaster_bad_reference', 'Use a full Farcaster cast reference containing its FID and hash.');
  }
  const [, fid, hash] = reference!.split(':');
  return { fid: Number(fid), hash: hash! };
}

export function ownFid(ctx: ChannelContext): number {
  const raw = ctx.account.remoteAccountId;
  const fid = Number(raw);
  if (!raw || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(fid)) {
    throw PipelineError.permanent('farcaster_no_fid', 'Set this Farcaster account\'s numeric FID before connecting it.');
  }
  return fid;
}

function baseUrl(ctx: ChannelContext): URL {
  const settings = FarcasterSettings.safeParse(ctx.account.settings);
  if (!settings.success) {
    throw PipelineError.permanent('farcaster_bad_node', 'Configure a Farcaster node origin using HTTPS, or HTTP on loopback, without credentials or a path.');
  }
  return new URL(settings.data.farcaster.hubUrl);
}

/** All reads, including failed reads, are charged once at this HTTP boundary. */
export async function request(
  ctx: ChannelContext, endpoint: string, params: Record<string, string | number> = {},
  bytes?: Uint8Array, read = bytes === undefined,
): Promise<unknown> {
  const url = new URL(`/v1/${endpoint}`, baseUrl(ctx));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  if (read) await ctx.beforeRead?.();
  let failure: unknown;
  try {
    const response = await fetch(url, {
      method: bytes ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      ...(bytes ? { headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(bytes) } : {}),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const delay = retry && /^\d+(?:\.\d+)?$/.test(retry)
          ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 60_000;
        throw PipelineError.retryable('farcaster_rate_limited', 'The Farcaster node is rate limited. Wait before asking again.',
          { retryAfterMs: Number.isFinite(delay) ? Math.max(1000, delay) : 60_000 });
      }
      if (response.status === 401 || response.status === 403) {
        throw PipelineError.permanent('farcaster_auth_failed', 'The Farcaster node refused access. Check the node and the authorized app signer.');
      }
      // The node sometimes uses 400 with not_found rather than HTTP 404.
      const body = await response.json().catch(() => null) as { errCode?: unknown } | null;
      if (response.status === 404 || body?.errCode === 'not_found') {
        throw PipelineError.permanent('farcaster_not_found', 'That Farcaster message was not found on this node.');
      }
      if (response.status >= 500) throw PipelineError.retryable('farcaster_unavailable', 'The Farcaster node is temporarily unavailable.');
      throw PipelineError.permanent('farcaster_rejected', 'The Farcaster node rejected this request. Check the signer authorization, storage and message limits.');
    }
    return await response.json();
  } catch (error) {
    failure = error instanceof PipelineError ? error
      : PipelineError.retryable('farcaster_unavailable', 'The Farcaster node did not return a readable answer.');
    throw failure;
  } finally {
    if (read) await ctx.afterRead?.(failure);
  }
}

export async function readCast(ctx: ChannelContext, reference: string): Promise<Cast> {
  const target = parseReference(reference);
  const cast = parseCast(await request(ctx, 'castById', target));
  if (castRef(cast) !== reference) {
    throw PipelineError.permanent('farcaster_target_mismatch', 'The Farcaster node returned a different cast from the requested target.');
  }
  return cast;
}

export async function page(ctx: ChannelContext, endpoint: string, params: Record<string, string | number>) {
  const body = z.object({ messages: z.array(z.unknown()), nextPageToken: z.string().max(16_384).optional() })
    .safeParse(await request(ctx, endpoint, params));
  if (!body.success) throw unreadable();
  const token = body.data.nextPageToken || '';
  if (token && token === params.pageToken) throw unreadable();
  return { casts: body.data.messages.map(parseCast), token };
}
