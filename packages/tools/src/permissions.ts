import {
  defaultPermission,
  type CapabilityPermission,
  type CapabilityStatus,
} from '@xbam/shared/contracts';
import type { Capability } from './capability';

/**
 * The only three things the permission model needs to know.
 *
 * Narrower than a whole capability on purpose. Taking the full type here
 * would make the decision depend on the schemas, which it does not, and a
 * concretely-typed capability is not assignable to the erased one -- so every
 * caller would need a cast to ask a question about three fields.
 */
export type CapabilityFacts = Pick<Capability<never, unknown>, 'name' | 'effect' | 'risk'>;

/**
 * Whether a capability may run, and the sentence explaining it either way.
 *
 * Pure, and separate from the loop, because this is the answer an owner reads
 * on a screen as well as the answer the loop acts on. Two implementations of
 * "may it run" would drift, and the one on the screen would be the wrong one.
 */
export interface PermissionDecision {
  allowed: boolean;
  /** True when the owner must approve this particular invocation first. */
  needsApproval: boolean;
  permission: CapabilityPermission;
  status: CapabilityStatus;
  /** Always set. An allowed decision still says why it was allowed. */
  why: string;
}

export interface PermissionInputs {
  capability: CapabilityFacts;
  /** What the owner configured for this agent, or null if they never have. */
  stored: CapabilityPermission | null;
  /** What the capability itself reports about right now. */
  readiness?: { status: CapabilityStatus; why?: string };
  /** PAUSE ALL, which outranks everything below it. */
  paused: boolean;
  /**
   * Whether this invocation already carries an owner decision.
   *
   * An approved invocation runs even where the permission is OWNER_APPROVAL --
   * that is what the approval was.
   */
  approved?: boolean;
}

export function resolvePermission(inputs: PermissionInputs): PermissionDecision {
  const { capability, stored, readiness, paused, approved } = inputs;
  const permission = stored ?? defaultPermission(capability.effect, capability.risk);

  // Everything stops, and it says so rather than blaming the capability.
  if (paused) {
    return {
      allowed: false,
      needsApproval: false,
      permission,
      status: 'BLOCKED',
      why: 'Everything is paused. Nothing runs until PAUSE ALL is lifted.',
    };
  }

  // A capability that cannot run does not become runnable by being permitted.
  // Asked in this order deliberately: an owner reading "you have not enabled
  // this" about something that could not have worked anyway learns nothing.
  if (readiness && readiness.status !== 'AVAILABLE') {
    return {
      allowed: false,
      needsApproval: false,
      permission,
      status: readiness.status,
      why: readiness.why ?? 'This capability is not available right now.',
    };
  }

  if (permission === 'DISABLED') {
    return {
      allowed: false,
      needsApproval: false,
      permission,
      status: 'DISABLED',
      why: `${capability.name} is switched off for this agent.`,
    };
  }

  if (permission === 'OWNER_APPROVAL' && !approved) {
    return {
      allowed: false,
      needsApproval: true,
      permission,
      status: 'OWNER_APPROVAL',
      why: `${capability.name} needs your approval before it runs.`,
    };
  }

  return {
    allowed: true,
    needsApproval: false,
    permission,
    status: 'AVAILABLE',
    why: approved && permission === 'OWNER_APPROVAL' ? 'Approved by the owner.' : 'Allowed for this agent.',
  };
}
