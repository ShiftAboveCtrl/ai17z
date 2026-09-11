import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';
import { parseExactJson } from '../exactNumbers';

/**
 * Reading Bitcoin, which does not have accounts.
 *
 * ### What makes this its own thing
 *
 * **There is no balance.** There are unspent outputs. An address's balance is a
 * sum somebody computes, and the sum is only interesting if the address is
 * interesting -- which brings the thing that actually matters here:
 *
 * **An address is not a wallet.** Bitcoin wallets are expected to use a fresh
 * address for every payment, so one address is a fragment of somebody's
 * activity and usually a small one. "This address holds 0.4 BTC" is true and
 * almost always misleading as an answer to "how much do they have". Every
 * address answer says so.
 *
 * **Confirmed is not a boolean, it is a depth.** A transaction in the mempool
 * can be replaced -- that is what replace-by-fee is -- and one in the most
 * recent block can still be reorganised out. So the number of confirmations
 * travels with every transaction, and an unconfirmed one is reported as
 * unconfirmed rather than as a transaction.
 *
 * ### Two members: redundant transport, NOT independent confirmation
 *
 * Both are Esplora, Blockstream's API, and the responses are byte-identical:
 * probed in September 2026, mempool.space and blockstream.info returned the
 * same 284 bytes for the same address. That is exactly what a family's members
 * are supposed to be, and it is why fallback here means something -- one can be
 * down and the question still gets answered.
 *
 * It is **not** a second opinion, and the distinction matters enough to spell
 * out. They run the same indexing software over the same canonical chain. If
 * that chain view is wrong, or the software has a bug, both are wrong together
 * and agreeing tells nobody anything. Two sources here buy availability, not
 * corroboration -- so nothing in this family should ever describe an agreement
 * between them as confirmation.
 *
 * (The genuinely independent reading would be a different implementation, and
 * there is one worth knowing about: probed at the same time, blockchain.info
 * reported 107.44 BTC received for the genesis address where Esplora reported
 * 57.43 -- a ~50 BTC gap, being the unspendable genesis coinbase that Core
 * excludes from the UTXO set. Not adopted, because its shape is different and
 * a family's members have to be substitutable, but that is what a real
 * cross-check looks like: two implementations that can disagree.)
 *
 * Two things deliberately stayed out:
 *
 *   **mempool.space's `/v1/` endpoints** -- recommended fees and the
 *     replace-by-fee history -- are its own, not Esplora's. Blockstream does
 *     not serve them, so putting them in this family would mean a fallback
 *     that answers 404. They live in `bitcoin_fees`, which has one member and
 *     says so.
 *   **`/mempool/txids`** -- 5.16 MB when measured. The same lesson the DeFi
 *     wave learned from a ten-megabyte protocol endpoint: the obvious URL is
 *     sometimes the whole dataset.
 *
 * ### One endpoint refuses busy addresses, and that is not a failure
 *
 * `/address/:a/utxo` answers `400 Too many unspent outputs` for an address with
 * enough of them -- the genesis address has 78,725. Reported as a limit of the
 * source rather than as an error about the address, because an agent told "that
 * failed" will try something else, and an agent told "there are too many to
 * list" has learned something true.
 */

export const BITCOIN_FAMILY = 'bitcoin';
export const BITCOIN_FEES_FAMILY = 'bitcoin_fees';

/**
 * What may be asked, as operations rather than paths.
 *
 * The caller never builds a URL. Esplora is a REST API, so the equivalent of an
 * RPC method allowlist is a closed set of operations each member knows how to
 * turn into its own request -- which is also what lets a second implementation
 * join without the caller learning its layout.
 */
export const BITCOIN_OPERATIONS = ['tip_height', 'address', 'transaction', 'unspent'] as const;
export type BitcoinOperation = (typeof BITCOIN_OPERATIONS)[number];

export const BitcoinQuery = z.object({
  operation: z.enum(BITCOIN_OPERATIONS),
  /** The address or transaction id the operation is about, when it needs one. */
  target: z.string().max(128).default(''),
});
export type BitcoinQuery = z.infer<typeof BitcoinQuery>;

export interface BitcoinResult {
  value: unknown;
  /**
   * True when the source answered that there are too many to list.
   *
   * Carried rather than thrown: it is an answer about the address, and a
   * sibling would say the same thing.
   */
  tooMany: boolean;
}

/** Esplora's path for each operation. The one place a URL is built. */
function pathFor(query: BitcoinQuery): string {
  switch (query.operation) {
    case 'tip_height':
      return '/blocks/tip/height';
    case 'address':
      return `/address/${encodeURIComponent(query.target)}`;
    case 'transaction':
      return `/tx/${encodeURIComponent(query.target)}`;
    case 'unspent':
      return `/address/${encodeURIComponent(query.target)}/utxo`;
  }
}

interface NodeOptions {
  name: string;
  base: string;
  rank: number;
  perSecondOurs: number;
}

function esplora(input: NodeOptions): Upstream<BitcoinQuery, BitcoinResult> {
  return defineUpstream<BitcoinQuery, BitcoinResult>({
    id: `${BITCOIN_FAMILY}.${input.name}`,
    family: BITCOIN_FAMILY,
    name: input.name,
    description: 'Reads the Bitcoin chain through an Esplora API.',
    origin: new URL(input.base).hostname,
    limit: {
      concurrentPerProcess: 3,
      // Neither publishes a figure for its free API -- checked September 2026.
      // These are what AI17Z allows itself against somebody else's public
      // service, not an allowance anybody granted.
      windows: [
        perSecond(input.perSecondOurs, { scope: 'MACHINE' }),
        perMinute(input.perSecondOurs * 20, { scope: 'MACHINE' }),
      ],
    },
    timeoutMs: 15_000,
    // A block is about ten minutes, but the mempool moves constantly and an
    // address answer includes unconfirmed activity.
    freshMs: 20_000,
    rank: input.rank,
    cacheKey: (query) => `${query.operation}:${query.target}`,
    async fetch(query, ctx) {
      if (!(BITCOIN_OPERATIONS as readonly string[]).includes(query.operation)) {
        throw new UpstreamFailure('UNSUPPORTED', `${query.operation} is not something this reads.`);
      }

      try {
        const response = await safeFetch(`${input.base}${pathFor(query)}`, {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          // Every measured response was under 1,300 bytes. The cap is for the
          // one that misbehaves; a busy address's UTXO list is the realistic
          // large case and the source refuses that itself.
          maxBytes: 2_000_000,
        });

        // An answer about the address rather than a fault, so it is carried
        // through instead of thrown: every sibling would say the same.
        if (response.status === 400 && /too many/i.test(response.text)) {
          return { value: null, tooMany: true };
        }

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        // The tip height comes back as a bare number, not JSON.
        if (query.operation === 'tip_height') {
          const height = Number(response.text.trim());
          if (!Number.isInteger(height) || height <= 0) {
            throw new UpstreamFailure('BAD_RESPONSE', `${input.base} answered with something that is not a height.`);
          }
          return { value: height, tooMany: false };
        }

        // Satoshi amounts are whole numbers and the exact parse keeps them
        // that way. Twenty-one million BTC is 2.1e15 satoshis, under where
        // doubles stop counting by ones -- but only just, and "it fits today"
        // is not a reason to use the lossy path when the exact one is here.
        return { value: parseExactJson(response.text, `the answer from ${input.base}`), tooMany: false };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

/**
 * Recommended fee rates, which only mempool.space serves.
 *
 * Its own family because a family's members must be interchangeable, and
 * Blockstream has no equivalent endpoint. One member, and the capability says
 * so rather than implying a fallback that is not there.
 */
function fees(): Upstream<Record<string, never>, unknown> {
  return defineUpstream<Record<string, never>, unknown>({
    id: `${BITCOIN_FEES_FAMILY}.mempoolspace`,
    family: BITCOIN_FEES_FAMILY,
    name: 'mempoolspace',
    description: 'What a Bitcoin transaction currently needs to pay to confirm.',
    origin: 'mempool.space',
    limit: {
      concurrentPerProcess: 2,
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(30, { scope: 'MACHINE' })],
    },
    timeoutMs: 15_000,
    // Fee advice that is a minute old is still fee advice; a block is ten.
    freshMs: 60_000,
    rank: 1,
    cacheKey: () => 'recommended',
    async fetch(_query, ctx) {
      try {
        const response = await safeFetch('https://mempool.space/api/v1/fees/recommended', {
          signal: ctx.signal,
          headers: { accept: 'application/json' },
          maxBytes: 100_000,
        });
        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;
        return parseExactJson(response.text, 'the fee estimate');
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

/**
 * The sources, in the order they are tried.
 *
 * Both answered identically when probed, which is what makes the second one a
 * fallback rather than a different opinion.
 */
const NODES: NodeOptions[] = [
  { name: 'mempoolspace', base: 'https://mempool.space/api', rank: 1, perSecondOurs: 3 },
  { name: 'blockstream', base: 'https://blockstream.info/api', rank: 2, perSecondOurs: 3 },
];

export function registerBitcoinUpstreams(): void {
  for (const options of NODES) registerUpstream(esplora(options));
  registerUpstream(fees());
}
