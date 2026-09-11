import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { classifyStatus, classifyThrown } from '../failures';
import { parseExactJson } from '../exactNumbers';

/**
 * What a four-byte selector or an event topic might mean.
 *
 * ### A selector is not an identity, and this is not theoretical
 *
 * `0xa9059cbb` is the most common selector on Ethereum: `transfer(address,
 * uint256)`. Asked in September 2026, 4byte.directory returned **six**
 * signatures that hash to it, ordered newest first:
 *
 *   workMyDirefulOwner(uint256,uint256)
 *   join_tg_invmru_haha_fd06787(address,bool)
 *   func_2093253501(bytes)
 *   transfer(bytes4[9],bytes5[6],int48[11])
 *   many_msg_babbage(bytes1)
 *   transfer(address,uint256)          <- the real one, last
 *
 * Anything taking the first result would report every ERC-20 transfer on
 * Ethereum as `workMyDirefulOwner`. People register colliding signatures on
 * purpose; a four-byte hash has collisions by construction.
 *
 * So these upstreams return **candidates**, plural, always. Choosing between
 * them is not their job and is not done by guessing -- see
 * `contractCapabilities`, where a contract's own verified ABI is what
 * disambiguates.
 *
 * ### Two sources, because they differ in a way that matters
 *
 * `signature_curated` ranks and filters; it returned only the real `transfer`.
 * `signature_registry` returns everything ever registered, junk included. The
 * union is what makes the intersection with an ABI work, so both are asked and
 * neither stands in for the other -- which is why they are two families rather
 * than two members of one.
 */

export const CURATED_SIGNATURES_FAMILY = 'signature_curated';
export const REGISTRY_SIGNATURES_FAMILY = 'signature_registry';

export const SignatureQuery = z.object({
  /** `function` for a 4-byte selector, `event` for a 32-byte topic. */
  kind: z.enum(['function', 'event']),
  /** `0x` followed by 8 hex characters for a function, 64 for an event. */
  hash: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
export type SignatureQuery = z.infer<typeof SignatureQuery>;

export interface SignatureCandidates {
  /** Every signature this source knows of that hashes to the input. */
  candidates: string[];
  /** What to call this source when attributing it. */
  sourceName: string;
}

function openchain(): Upstream<SignatureQuery, SignatureCandidates> {
  return defineUpstream<SignatureQuery, SignatureCandidates>({
    id: `${CURATED_SIGNATURES_FAMILY}.openchain`,
    family: CURATED_SIGNATURES_FAMILY,
    name: 'openchain',
    description: 'Signatures matching a selector or topic, ranked and filtered.',
    origin: 'api.openchain.xyz',
    limit: {
      concurrentPerProcess: 2,
      // No published figure -- checked September 2026. Ours, and modest.
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(40, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    // A signature for a given hash never changes; only the set of known ones
    // grows. An hour is a compromise with memory, not with correctness.
    freshMs: 60 * 60_000,
    rank: 1,
    cacheKey: (query) => `${query.kind}:${query.hash.toLowerCase()}`,
    async fetch(query, ctx) {
      try {
        const url = `https://api.openchain.xyz/signature-database/v1/lookup?${query.kind}=${encodeURIComponent(query.hash)}`;
        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          maxBytes: 500_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = parseExactJson(response.text, 'the signature lookup') as {
          ok?: boolean;
          result?: Record<string, Record<string, { name?: unknown; filtered?: unknown }[]>>;
        };
        const entries = body.result?.[query.kind]?.[query.hash.toLowerCase()] ?? [];
        return {
          // `filtered` is this source saying it believes an entry is junk. Its
          // opinion is kept rather than acted on: the capability decides.
          candidates: entries
            .filter((entry) => entry.filtered !== true)
            .map((entry) => (typeof entry.name === 'string' ? entry.name : ''))
            .filter((name) => name.length > 0),
          sourceName: 'a curated signature database',
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

function fourByte(): Upstream<SignatureQuery, SignatureCandidates> {
  return defineUpstream<SignatureQuery, SignatureCandidates>({
    id: `${REGISTRY_SIGNATURES_FAMILY}.fourbyte`,
    family: REGISTRY_SIGNATURES_FAMILY,
    name: 'fourbyte',
    description: 'Every signature ever registered for a selector or topic.',
    origin: 'www.4byte.directory',
    limit: {
      concurrentPerProcess: 2,
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(40, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    freshMs: 60 * 60_000,
    rank: 1,
    cacheKey: (query) => `${query.kind}:${query.hash.toLowerCase()}`,
    async fetch(query, ctx) {
      try {
        const path = query.kind === 'event' ? 'event-signatures' : 'signatures';
        const url = `https://www.4byte.directory/api/v1/${path}/?hex_signature=${encodeURIComponent(query.hash)}`;
        const response = await safeFetch(url, {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          // A popular selector has a handful of collisions, not thousands.
          maxBytes: 500_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = parseExactJson(response.text, 'the signature registry') as {
          results?: { text_signature?: unknown }[];
        };
        return {
          // Deliberately unordered by relevance: this source orders newest
          // first, which puts the junk at the top. Presenting them in its order
          // would be presenting a ranking that is not one.
          candidates: (body.results ?? [])
            .map((row) => (typeof row.text_signature === 'string' ? row.text_signature : ''))
            .filter((name) => name.length > 0),
          sourceName: 'an open signature registry',
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerSignatureUpstreams(): void {
  registerUpstream(openchain());
  registerUpstream(fourByte());
}
