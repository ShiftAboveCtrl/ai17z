import { listCapabilities } from './capabilityRegistry';
import type { AnyCapability } from './capability';

/**
 * Capabilities, grouped the way somebody would ask for them.
 *
 * Twenty-three capabilities is already past the point where a flat list of
 * switches is a screen anybody reads, and the catalogue is going to keep
 * growing. A person does not want to decide about `chain.read_receipt`; they
 * want to decide whether their agent can look things up on chains.
 *
 * ### A pack is a projection, not a second permission system
 *
 * There is exactly one place a decision lives -- `agent_capability_permissions`
 * -- and a pack is a way of reading and writing several of those at once. It
 * stores nothing of its own. That matters because two overlapping sources of
 * truth about what an agent may do is how something ends up allowed by one
 * screen and refused by another, and this codebase has already paid for that
 * once with capabilities in the tool catalogue.
 *
 * So: a pack's state is *computed* from the permissions underneath it, and
 * turning one on writes those permissions. An owner who then changes one
 * capability in Advanced has a pack that reads MIXED, which is the truth rather
 * than a conflict.
 *
 * ### Turning a pack on does not allow everything in it
 *
 * Enabling a pack sets each capability to **its own default** -- reads allowed,
 * writes off or asking. It does not sweep a write capability to ALLOWED,
 * because "let my agent look at chains" is not consent to let it post. An owner
 * who wants that says so about that capability, on purpose.
 */

export interface Toolpack {
  id: string;
  /** What a person would call it. */
  name: string;
  /** One line, in the words somebody would use about themselves. */
  summary: string;
  /**
   * Which capabilities belong to it, by id prefix.
   *
   * Prefixes rather than a list, so a capability added to a family joins its
   * pack without anybody remembering to edit two places. A capability in no
   * pack still exists and is still settable in Advanced -- it is simply not
   * part of a group anybody would ask for by name.
   */
  prefixes: string[];
}

/**
 * The packs, in the order they are shown.
 *
 * Ordered by how likely somebody is to want them rather than alphabetically:
 * the screen is a question about this agent, not an index.
 */
export const TOOLPACKS: Toolpack[] = [
  {
    id: 'x',
    name: 'X',
    summary: 'Read posts, profiles and conversations on X, and act on them.',
    prefixes: ['x.'],
  },
  {
    id: 'crypto',
    name: 'Crypto & Onchain',
    summary:
      'Verify contracts, read balances and transactions across chains, check what a token is worth, see where ' +
      'value is locked, and read what a DAO has voted on.',
    // Solana sits here rather than in a pack of its own. "Let my agent look
    // things up on chains" is one decision a person makes once; a pack per
    // chain would turn it into a decision per chain, which is the flat list of
    // switches these exist to replace.
    prefixes: ['bitcoin.', 'chain.', 'contract.', 'defi.', 'governance.', 'market.', 'solana.', 'token.'],
  },
];

/** Which pack a capability belongs to, or nothing. */
export function packFor(capabilityId: string): Toolpack | null {
  return TOOLPACKS.find((pack) => pack.prefixes.some((prefix) => capabilityId.startsWith(prefix))) ?? null;
}

/** Every registered capability in one pack. */
export function capabilitiesInPack(packId: string): AnyCapability[] {
  const pack = TOOLPACKS.find((entry) => entry.id === packId);
  if (!pack) return [];
  return listCapabilities().filter((capability) =>
    pack.prefixes.some((prefix) => capability.id.startsWith(prefix)),
  );
}

/** Capabilities no pack claims, which Advanced still shows. */
export function capabilitiesOutsideAnyPack(): AnyCapability[] {
  return listCapabilities().filter((capability) => packFor(capability.id) === null);
}
