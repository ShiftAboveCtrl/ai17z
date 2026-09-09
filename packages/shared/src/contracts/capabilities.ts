import { z } from 'zod';

/**
 * What a capability is, in the vocabulary every layer shares.
 *
 * AI17Z had tools before this and none of them could run: three rows in a
 * catalogue, a switch per agent, and nothing anywhere that called `execute`.
 * `docs/ENGINEERING.md` was explicit that the model never chooses a tool, and
 * the honest answer at the time was to remove the one tool whose whole purpose
 * was to be called (`http.fetch`, migration 0062) rather than leave a control
 * that did nothing.
 *
 * This is the other half of that decision: a real loop, and the vocabulary it
 * needs. Nothing here describes an implementation. The contract lives in
 * `contracts` because the interface has to render a capability -- its risk, its
 * status, why it is unavailable -- and the browser cannot import a package that
 * drives Chrome.
 */

/**
 * What the capability is for. Categories exist so the interface can group
 * fifty capabilities without a person reading fifty descriptions.
 */
export const CAPABILITY_CATEGORIES = [
  'READ',
  'CREATE',
  'ENGAGE',
  'DISCOVER',
  'RELATIONSHIPS',
  'MESSAGING',
  'ANALYTICS',
  'ACCOUNT',
  'RESEARCH',
] as const;
export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

/**
 * Whether running it changes anything outside AI17Z.
 *
 * This is the distinction the whole permission model rests on, so it is one
 * word rather than a set of flags. A READ capability can be retried, run twice,
 * and run without asking anybody. A WRITE capability cannot be any of those.
 */
export const CAPABILITY_EFFECTS = ['READ', 'WRITE'] as const;
export type CapabilityEffect = (typeof CAPABILITY_EFFECTS)[number];

/**
 * How much it matters if it goes wrong, which is not the same as what it costs.
 *
 * LOW    nothing outside AI17Z changes and nothing private is read
 * MEDIUM reads something private, or spends money, or is visible to one person
 * HIGH   publicly visible, irreversible, or changes the account's own identity
 */
export const CAPABILITY_RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];

/**
 * What the owner has decided about a capability, per agent.
 *
 * `OWNER_APPROVAL` is deliberately distinct from `ALLOWED`: an owner who wants
 * to watch the first few uses of something should not have to choose between
 * off and unattended.
 */
export const CAPABILITY_PERMISSIONS = ['DISABLED', 'OWNER_APPROVAL', 'ALLOWED'] as const;
export type CapabilityPermission = (typeof CAPABILITY_PERMISSIONS)[number];

/**
 * What the interface should say about a capability right now.
 *
 * Status is computed, never stored: an owner permission is a setting, but
 * "the browser is down so nothing on X can run" is a fact about this minute.
 * `docs/ENGINEERING.md` calls a control that does nothing worse than no control
 * at all, so a capability that cannot run has to say which of these it is and
 * why.
 */
export const CAPABILITY_STATUSES = [
  'AVAILABLE',
  'DISABLED',
  'OWNER_APPROVAL',
  'UNAVAILABLE',
  'BLOCKED',
  'DEGRADED',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** How an invocation ended. */
export const INVOCATION_OUTCOMES = ['SUCCEEDED', 'FAILED', 'REFUSED', 'TIMED_OUT'] as const;
export type InvocationOutcome = (typeof INVOCATION_OUTCOMES)[number];

/**
 * A capability as the interface sees it. Derived, never a table row.
 */
export const CapabilityView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(CAPABILITY_CATEGORIES),
  effect: z.enum(CAPABILITY_EFFECTS),
  risk: z.enum(CAPABILITY_RISKS),
  /** Whether the model may choose it, as opposed to the runtime driving it. */
  modelCallable: z.boolean(),
  permission: z.enum(CAPABILITY_PERMISSIONS),
  status: z.enum(CAPABILITY_STATUSES),
  /** Required whenever status is not AVAILABLE. */
  why: z.string().optional(),
});
export type CapabilityView = z.infer<typeof CapabilityView>;

/**
 * The default permission for a capability nobody has configured.
 *
 * Reading is allowed, writing is not. An agent that can look things up without
 * being asked is useful; an agent that can publish without being asked is a
 * decision an owner makes on purpose.
 */
export function defaultPermission(effect: CapabilityEffect, risk: CapabilityRisk): CapabilityPermission {
  if (effect === 'READ') return risk === 'HIGH' ? 'OWNER_APPROVAL' : 'ALLOWED';
  return risk === 'LOW' ? 'OWNER_APPROVAL' : 'DISABLED';
}
