import { readingAvailable, type CardReading } from '@xbam/prompts';
import { studioLinkedContext } from './studioLink';

/**
 * The address of a token's public check page on the Studio this installation
 * is linked to.
 *
 * The page is `/check/<chain>/<address>`. Three rules keep a stranger's message
 * from steering where a reply points:
 *
 * - The origin is the linked Studio's and nothing else. There is no parameter,
 *   setting or message text that supplies a host, and an installation that is
 *   not linked, or whose link was revoked, produces no link at all.
 * - A development origin (`AI17Z_STUDIO_UNSAFE_DEV_ORIGIN`) is never printed
 *   in public. It is a loopback or private address nobody else can open.
 * - It exists only for a mint that `token.inspect_risk` actually read. A page
 *   Studio has not indexed would be a dead link on an agent's public reply, so
 *   an unread token gets the inline card and nothing more.
 *
 * Tokens only. A wallet has no check page here and this never builds one.
 */

/** The chain names Studio's check page answers to. A chain missing here gets no link. */
const CHECK_SLUGS: Readonly<Record<string, string>> = { solana: 'solana', ethereum: 'ethereum', robinhood: 'robinhood' };
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Pure: the page for one token on one origin, or null when either part is not exactly that. */
export function checkLinkUrl(origin: string, chain: string, address: string): string | null {
  const slug = CHECK_SLUGS[chain];
  if (!slug) return null;
  // One address has one permalink: the page canonicalises an EVM address to lowercase.
  const path = chain === 'solana'
    ? SOLANA_MINT.test(address) ? address : null
    : EVM_ADDRESS.test(address) ? address.toLowerCase() : null;
  if (!path) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.origin !== origin || (base.protocol !== 'https:' && base.protocol !== 'http:')) return null;
  const url = new URL(`/check/${slug}/${path}`, base);
  // The path is built from validated parts, but the host is the claim worth proving.
  return url.origin === origin ? url.toString() : null;
}

/** Whether at least one reading was current and valid, so the page has something to show. */
export function tokenResolved(readings: CardReading[], now = Date.now()): boolean {
  return readings.some(reading => readingAvailable(reading, now));
}

/** The linked Studio's public origin, or null when there is none or it is not public. */
export async function linkedCheckOrigin(): Promise<string | null> {
  const ready = await studioLinkedContext();
  if ('ok' in ready || ready.where.unsafeDev) return null;
  return ready.where.origin;
}

/** The link for a token that `token.inspect_risk` just read, or null. Never throws. */
export async function studioCheckLink(input: { chain: string; address: string; readings: CardReading[] }): Promise<string | null> {
  if (!tokenResolved(input.readings)) return null;
  const origin = await linkedCheckOrigin().catch(() => null);
  return origin ? checkLinkUrl(origin, input.chain, input.address) : null;
}
