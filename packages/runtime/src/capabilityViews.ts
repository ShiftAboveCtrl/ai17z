import type { CapabilityPermission, CapabilityView } from '@xbam/shared/contracts';
import { defaultPermission } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { capabilityPermissions as permissionsRepo } from '@xbam/database';
import { listCapabilities, resolvePermission } from '@xbam/tools';
import { capabilityPermissions } from './capabilityPermissions';

/** A logger that says nothing, for the readiness probes a screen triggers. */
interface QuietLogger {
  info(): void;
  warn(): void;
  error(): void;
  debug(): void;
  child(): QuietLogger;
}

const QUIET: QuietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return QUIET;
  },
};

/**
 * Every capability, as the owner's screen needs to see it.
 *
 * Derived rather than stored. The permission is a setting; the status is a fact
 * about this minute -- "the browser is down so nothing on X can run" is not
 * something to write into a row. `docs/ENGINEERING.md` calls a control that
 * does nothing worse than no control at all, so a capability that cannot run
 * has to say which kind of cannot it is and why.
 *
 * The same `resolvePermission` the loop uses answers it, so the screen and the
 * runtime can never disagree about whether something would run.
 */
export async function capabilityViews(input: {
  agentId: string;
  accountId: string | null;
  paused: boolean;
}): Promise<CapabilityView[]> {
  const permissions = await capabilityPermissions(input.agentId);
  const views: CapabilityView[] = [];

  for (const capability of listCapabilities()) {
    const stored = permissions.get(capability.id) ?? null;
    const readiness = capability.readiness
      ? await capability
          .readiness({
            agentId: input.agentId,
            jobId: null,
            accountId: input.accountId,
            config: {},
            // Readiness only reports; nothing here logs, and a screen asking
            // ten capabilities how they are should not write ten lines.
            logger: QUIET as never,
          })
          .catch(() => undefined)
      : undefined;

    const decision = resolvePermission({ capability, stored, readiness, paused: input.paused });
    views.push({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      category: capability.category,
      effect: capability.effect,
      risk: capability.risk,
      modelCallable: capability.modelCallable,
      permission: decision.permission,
      status: decision.status,
      // Always carried when it is not simply available, because "why not" is
      // the only useful half of a disabled row.
      why: decision.status === 'AVAILABLE' ? undefined : decision.why,
    });
  }
  return views;
}

/**
 * What an owner just decided, written where the loop will read it.
 *
 * Stored in `agent_capability_permissions`, which exists because the intended
 * home could not work: `agent_tools.tool_id` is a foreign key into the tool
 * catalogue, capability ids were never in it, and the insert selected nothing
 * and wrote nothing without complaining. See migration 0068.
 */
export async function setCapabilityPermission(input: {
  agentId: string;
  capabilityId: string;
  permission: CapabilityPermission;
}): Promise<void> {
  // Refuses a capability that is not registered, rather than recording a
  // decision about something that will never be offered. The previous storage
  // failed the other way -- it accepted anything and wrote nothing -- and that
  // is precisely how an unswitchable write capability survived a release.
  if (!listCapabilities().some((capability) => capability.id === input.capabilityId)) {
    throw new NotFoundError('Capability');
  }
  const written = await permissionsRepo.set(input);
  if (!written) {
    throw new Error(`The permission for ${input.capabilityId} was not stored.`);
  }
}

/** What a capability would default to if nobody ever chose. For the screen. */
export function defaultFor(capabilityId: string): CapabilityPermission | null {
  const capability = listCapabilities().find((c) => c.id === capabilityId);
  return capability ? defaultPermission(capability.effect, capability.risk) : null;
}
