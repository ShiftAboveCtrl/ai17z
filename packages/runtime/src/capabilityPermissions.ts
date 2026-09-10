import { defaultPermission, type CapabilityPermission } from '@xbam/shared/contracts';
import { capabilityPermissions as permissionsRepo } from '@xbam/database';
import { listCapabilities } from '@xbam/tools';

/**
 * What an owner has decided about each capability, for one agent.
 *
 * Two sources, in order:
 *
 *   1. the decision the owner recorded, in `agent_capability_permissions`;
 *   2. the capability's own default -- reads allowed, writes not.
 *
 * A capability with no row falls to its default, which is what makes a newly
 * registered read work without anybody configuring anything, and a newly
 * registered write not.
 *
 * ### Why this is not `agent_tools`
 *
 * It was, and it silently did nothing. `agent_tools.tool_id` is a foreign key
 * into the built-in tool catalogue and `setAgentTool` selects that row by key,
 * so a capability id -- which is registry-defined and has never been in the
 * catalogue -- selected nothing and inserted nothing. Every permission an owner
 * set was written nowhere and read back as the default. Reads default to
 * allowed so they worked; writes default to disabled, so `x.like` and
 * `x.repost` could not be switched on from the interface at all.
 *
 * The screen said Allowed, the runtime said "switched off for this agent", and
 * nothing anywhere raised. See migration 0068.
 */
export async function capabilityPermissions(agentId: string): Promise<Map<string, CapabilityPermission>> {
  const stored = await permissionsRepo.listForAgent(agentId).catch(() => []);
  const byId = new Map(stored.map((row) => [row.capability_id, row.permission]));
  const permissions = new Map<string, CapabilityPermission>();

  for (const capability of listCapabilities()) {
    const chosen = byId.get(capability.id);
    permissions.set(capability.id, chosen ?? defaultPermission(capability.effect, capability.risk));
  }
  return permissions;
}
