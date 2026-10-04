import { hosting } from '@xbam/database';
import type { HostedRuntimeRow, RuntimeGrantRow } from '@xbam/database';
import { runtimeMayAct, type RuntimeState } from '@xbam/shared/contracts';

/**
 * Deciding which runtime a request is allowed to reach.
 *
 * This is the boundary most likely to be built wrong, so the rule is written
 * here as plainly as it can be: **a client never names its own runtime.** A
 * `runtimeId` arriving from a browser is an argument, not an authority. What
 * decides is a grant that Studio issued for a specific tenant and runtime,
 * presented as a token, and the runtime that the grant names is the only one
 * the request can touch.
 *
 * Every refusal is deliberately the same shape and says little. A caller
 * probing with other people's identifiers learns whether a runtime exists from
 * a specific error, and that is a map of the estate; so an expired grant, a
 * revoked grant, a grant for another tenant and a runtime that was never there
 * all come back as a refusal with a code the operator can read in a log and
 * the caller cannot mine.
 */

export const GATEWAY_SCOPES = [
  /** Ordinary dashboard traffic: read and write the agent's own configuration. */
  'runtime.api',
  /** Watch the tenant's real browser. */
  'browser.view',
  /** Drive the tenant's real browser. Separate, because typing is not watching. */
  'browser.control',
  /** Export or move the tenant out. */
  'runtime.export',
  /** Infrastructure actions an owner may take on their own runtime. */
  'runtime.manage',
] as const;
export type GatewayScope = (typeof GATEWAY_SCOPES)[number];

export type GatewayRefusal =
  | 'NO_TOKEN'
  | 'NO_SUCH_GRANT'
  | 'GRANT_EXPIRED_OR_REVOKED'
  | 'GRANT_ALREADY_USED'
  | 'SCOPE_NOT_GRANTED'
  | 'RUNTIME_MISMATCH'
  | 'TENANT_MISMATCH'
  | 'NO_SUCH_RUNTIME'
  | 'RUNTIME_NOT_REACHABLE'
  | 'RUNTIME_SUSPENDED';

export type GatewayDecision =
  | { ok: true; runtime: HostedRuntimeRow; grant: RuntimeGrantRow; scope: GatewayScope }
  | { ok: false; refusal: GatewayRefusal; detail: string };

/**
 * States a request may reach a runtime in.
 *
 * Suspended is reachable for export and management and nothing else: an owner
 * whose subscription lapsed must still be able to get their agent out, which
 * is the whole point of not deleting it. `runtimeMayAct` is the separate
 * question of whether the agent may do anything, and it stays false here.
 */
const REACHABLE: readonly RuntimeState[] = ['READY', 'ACTIVE', 'GRACE', 'SUSPENDED', 'RETAINED'];
const SCOPES_WHEN_NOT_ACTING: readonly GatewayScope[] = ['runtime.export', 'runtime.manage', 'runtime.api'];

export interface GatewayRequest {
  /** The bearer the owner's browser presented. Never a runtime id. */
  token: string | null;
  scope: GatewayScope;
  /**
   * What the client claimed it wanted, if anything. Checked against the grant
   * rather than trusted: a mismatch is a refusal, not a redirect.
   */
  claimedRuntimeId?: string | null;
}

/**
 * Resolve a request to a runtime, or refuse it.
 *
 * The order matters. The token is looked up first, so nothing about a runtime
 * is revealed to somebody without a valid grant; the claimed id is compared
 * afterwards, so a caller cannot use the shape of the answer to find out which
 * runtimes exist.
 */
export async function authoriseGatewayRequest(request: GatewayRequest): Promise<GatewayDecision> {
  if (!request.token) {
    return { ok: false, refusal: 'NO_TOKEN', detail: 'The request carried no grant.' };
  }

  const grant = await hosting.liveGrantByToken(request.token);
  if (!grant) {
    // One answer for "never existed", "expired", "revoked" and "already
    // spent". A caller must not be able to tell those apart.
    return { ok: false, refusal: 'NO_SUCH_GRANT', detail: 'No live grant matches that token.' };
  }

  if (!grant.scopes.includes(request.scope)) {
    return {
      ok: false,
      refusal: 'SCOPE_NOT_GRANTED',
      detail: `The grant does not carry ${request.scope}.`,
    };
  }

  // The client's own idea of which runtime it wants is only ever checked
  // against the grant. It is never used to choose one.
  if (request.claimedRuntimeId && request.claimedRuntimeId !== grant.runtimeId) {
    return { ok: false, refusal: 'RUNTIME_MISMATCH', detail: 'The grant is for a different runtime.' };
  }

  const runtime = await hosting.getRuntime(grant.runtimeId);
  if (!runtime) {
    return { ok: false, refusal: 'NO_SUCH_RUNTIME', detail: 'The runtime the grant names is gone.' };
  }
  // Belt and braces: the grant and the runtime must agree about the tenant.
  // They are written together, so a disagreement means somebody edited one.
  if (runtime.tenantId !== grant.tenantId) {
    return { ok: false, refusal: 'TENANT_MISMATCH', detail: 'The grant and the runtime disagree about the tenant.' };
  }
  if (!REACHABLE.includes(runtime.state)) {
    return { ok: false, refusal: 'RUNTIME_NOT_REACHABLE', detail: `The runtime is ${runtime.state}.` };
  }
  if (!runtimeMayAct(runtime.state) && !SCOPES_WHEN_NOT_ACTING.includes(request.scope)) {
    // An owner may still reach in to export or manage; the agent may not act.
    return {
      ok: false,
      refusal: 'RUNTIME_SUSPENDED',
      // Named from the list rather than written out beside it, because the
      // sentence said "export and management" while the list also allowed
      // runtime.api, and a refusal that misdescribes what is still available
      // sends somebody looking for a route that was there all along.
      detail: `The runtime is ${runtime.state}, so ${request.scope} is not available. Still available: ${SCOPES_WHEN_NOT_ACTING.join(', ')}.`,
    };
  }

  if (grant.singleUse) {
    const spent = await hosting.consumeGrant(grant.id);
    if (!spent) {
      return { ok: false, refusal: 'GRANT_ALREADY_USED', detail: 'That grant had already been spent.' };
    }
    return { ok: true, runtime, grant: spent, scope: request.scope };
  }

  return { ok: true, runtime, grant, scope: request.scope };
}

/**
 * What a host daemon is told about a runtime it is asked to hold.
 *
 * Deliberately small. A host needs an id, a class, a version and a policy; it
 * does not need to know whose agent it is in order to run it. Owner email,
 * payment wallet, real name and X handle are absent because a host that never
 * receives them cannot leak them, and because an operator reading a host's
 * logs should not be reading a customer list.
 */
export interface HostAssignment {
  runtimeId: string;
  generation: number;
  runtimeClass: string;
  version: string;
  /** Opaque. Lets a host keep one tenant's things apart without knowing who they are. */
  tenantRef: string;
  keyCustody: 'HOST_SEALED' | 'ATTESTED_RELEASE';
}

export function assignmentFor(runtime: HostedRuntimeRow): HostAssignment {
  return {
    runtimeId: runtime.id,
    generation: runtime.generation,
    runtimeClass: runtime.runtimeClass,
    version: runtime.version,
    // The tenant's own id, which is meaningless outside this control plane.
    tenantRef: runtime.tenantId,
    keyCustody: runtime.keyCustody,
  };
}

/** The fields a host assignment must never carry, asserted by a test. */
export const ASSIGNMENT_FORBIDDEN_FIELDS: readonly string[] = [
  'email',
  'ownerEmail',
  'accountRef',
  'wallet',
  'walletAddress',
  'name',
  'realName',
  'handle',
  'xHandle',
  'entitlementRef',
];
