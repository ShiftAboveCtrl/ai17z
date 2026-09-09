import type { AnyCapability, Capability } from './capability';

/**
 * Every capability an agent could have, in one place.
 *
 * Registration is explicit and happens at bootstrap rather than by scanning a
 * directory, for the reason the provider catalogue gives: a list somebody has
 * to edit is a list somebody reads, and a capability that appears because a
 * file exists is a capability nobody decided to ship.
 *
 * Capabilities that drive a channel are registered by the package that owns
 * that channel, so no X selector knowledge reaches this module or anything
 * above it.
 */
const CAPABILITIES = new Map<string, AnyCapability>();

/** Ids look like `family.verb_noun`, so a family can be offered as a group. */
const ID_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function registerCapability<I, O>(capability: Capability<I, O>): void {
  if (!ID_SHAPE.test(capability.id)) {
    throw new Error(`Capability id "${capability.id}" must look like family.verb_noun.`);
  }
  const existing = CAPABILITIES.get(capability.id);
  // Registering twice is how two implementations of one id end up in a build,
  // and the one that wins is whichever module loaded last. Refuse instead --
  // unless it is the identical object, which is a module loaded twice.
  if (existing && existing !== (capability as unknown as AnyCapability)) {
    throw new Error(`Capability "${capability.id}" is already registered by something else.`);
  }
  CAPABILITIES.set(capability.id, capability as unknown as AnyCapability);
}

export function getCapability(id: string): AnyCapability | null {
  return CAPABILITIES.get(id) ?? null;
}

export function listCapabilities(): AnyCapability[] {
  return [...CAPABILITIES.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The subset a model may choose from, before permissions are applied. */
export function listModelCallable(): AnyCapability[] {
  return listCapabilities().filter((c) => c.modelCallable);
}

/** Only for tests: the registry is process-wide and otherwise append-only. */
export function resetCapabilitiesForTest(): void {
  CAPABILITIES.clear();
}
