import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';
import { parseCid, verifyCid, type CidKind, type CidVerification } from '../cid';

/**
 * Fetching content-addressed storage through a gateway that is not trusted.
 *
 * ### The gateway is checked where the identifier allows it
 *
 * Every other family in this package has to trust its upstream to some degree:
 * if a node lies about a balance there is nothing local that can tell. IPFS is
 * partly an exception -- but only partly, and the size of the exception is
 * exactly the codec.
 *
 * A CID names an IPLD **block**, not a file. When the codec is `raw` the block
 * is the content, so the body can be hashed and compared and a gateway that
 * substitutes something else is caught. When it is `dag-pb` -- every `Qm...`,
 * and any file bigger than one chunk -- the CID commits to a UnixFS node whose
 * children a plain gateway `GET` never returns, so there is nothing here to
 * check it against and the answer says `UNVERIFIABLE` rather than inventing an
 * assurance. See `cid.ts`.
 *
 * That is not a hypothetical protection. Probed September 2026, `ipfs.io`
 * answered a request for a known CID with 188 bytes of "This IPFS gateway is
 * switching to a service worker gateway" and a 429 -- twice, on separate
 * attempts. Anything trusting the gateway would have handed that notice page to
 * a model as the file's contents.
 *
 * ### Which gateways, and why so few
 *
 * Probed with one known raw CID whose sha2-256 is checkable:
 *
 *   `gateway.pinata.cloud` -- 200, eleven bytes, **hash verified**. Slow on a
 *     cold fetch (5.9s), hence the generous timeout.
 *   `ipfs.io` -- 429 with a notice page, consistently. Not adopted: a member
 *     that never answers is a wasted attempt, and this one answers *wrongly*.
 *   `cloudflare-ipfs.com` -- gone; no DNS record at all.
 *   `flk-ipfs.xyz` -- NXDOMAIN.
 *   `dweb.link`, `4everland.io` -- resolve publicly but `0.0.0.0` on the
 *     machine this was researched on, which has DNS filtering. Not reachable
 *     from here, so not registered on a guess -- the `eth.llamarpc.com` rule.
 *   `w3s.link` -- resolves, and the connection failed anyway.
 *
 * One member, then. For a `raw` identifier the usual risk of a single source is
 * smaller here than anywhere else in this package, because the content is
 * checked independently of who served it -- so adding gateways later is a
 * question of availability rather than of trust. For `dag-pb` it is not: there
 * the gateway is trusted like any other upstream, and a second one would be a
 * second opinion rather than a redundant transport. The answer says which.
 */

export const IPFS_FAMILY = 'ipfs';

export const IpfsQuery = z.object({
  /** A CID, an `ipfs://` URI, or a gateway URL. Normalised before use. */
  cid: z.string().min(1).max(200),
  /** Refuses rather than truncates: half a document is not the document. */
  maxBytes: z.number().int().min(1).max(2_000_000).default(512_000),
});
export type IpfsQuery = z.infer<typeof IpfsQuery>;

export interface IpfsResult {
  cid: string;
  /** The bytes as text. Third-party content; see the capability layer. */
  text: string;
  bytes: number;
  contentType: string | null;
  verification: CidVerification;
  /** Which kind of identifier it was, which is what decided the above. */
  kind: CidKind;
  /** Why it could or could not be verified, in a sentence. */
  verificationNote: string;
}

interface GatewayOptions {
  name: string;
  base: string;
  rank: number;
}

function gateway(input: GatewayOptions): Upstream<IpfsQuery, IpfsResult> {
  return defineUpstream<IpfsQuery, IpfsResult>({
    id: `${IPFS_FAMILY}.${input.name}`,
    family: IPFS_FAMILY,
    name: input.name,
    description: 'Fetches content-addressed storage through a public gateway.',
    origin: new URL(input.base).hostname,
    limit: {
      concurrentPerProcess: 2,
      // No published figure for the free tier -- checked September 2026. These
      // are ours, and deliberately modest: a gateway fetch can be expensive for
      // whoever runs it, and a cold one took nearly six seconds.
      windows: [perSecond(2, { scope: 'MACHINE' }), perMinute(30, { scope: 'MACHINE' })],
    },
    // Cold fetches are slow because the gateway may have to find the content on
    // the network first.
    timeoutMs: 30_000,
    // Content addressing means the answer for a CID can never change, so this
    // could be cached for ever. An hour is a compromise with memory rather than
    // with correctness.
    freshMs: 60 * 60_000,
    rank: input.rank,
    cacheKey: (query) => `${query.cid}:${query.maxBytes}`,
    async fetch(query, ctx) {
      const parsed = parseCid(query.cid);
      if (!parsed) {
        throw new UpstreamFailure('BAD_CONFIGURATION', `"${query.cid}" is not a content identifier.`);
      }

      try {
        const response = await safeFetch(`${input.base}${parsed.cid}`, {
          signal: ctx.signal,
          headers: { accept: '*/*' },
          maxBytes: query.maxBytes,
        });

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = Buffer.from(response.text, 'utf8');
        const verification = verifyCid(parsed, body);

        // A mismatch is not content. Thrown rather than returned so the family
        // tries another gateway -- which is exactly the situation where having
        // one is worth something, and where trusting this one would be worst.
        if (verification === 'MISMATCH') {
          throw new UpstreamFailure(
            'BAD_RESPONSE',
            `${input.base} returned bytes that are not what ${parsed.cid} commits to. Nothing was read from it.`,
          );
        }

        return {
          cid: parsed.cid,
          kind: parsed.kind,
          text: response.text,
          bytes: body.length,
          contentType: response.headers.get('content-type'),
          verification,
          verificationNote: parsed.why,
        };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

const GATEWAYS: GatewayOptions[] = [
  { name: 'pinata', base: 'https://gateway.pinata.cloud/ipfs/', rank: 1 },
];

export function registerIpfsUpstreams(): void {
  for (const options of GATEWAYS) registerUpstream(gateway(options));
}
