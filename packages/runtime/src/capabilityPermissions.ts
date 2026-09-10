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
  return (await capabilitySettings(agentId)).permissions;
}

/** Both halves of what an owner has said about a capability, read once. */
export interface CapabilitySettings {
  permissions: Map<string, CapabilityPermission>;
  /**
   * Named settings, by capability id, for capabilities that have any.
   *
   * Only the ones with something stored. A capability with an empty bag is
   * absent rather than present-and-empty, because the loop already answers a
   * missing entry with `{}` and two ways of saying nothing is one too many.
   */
  configs: Map<string, Record<string, unknown>>;
}

/**
 * What the owner has decided, and how they have set it up, in one read.
 *
 * One query for both because they are one row. `stepGenerate` runs on every
 * job, and asking the same table twice for two columns of the same row is a
 * second round trip for nothing.
 *
 * ### Why the config half existed and did nothing
 *
 * `CapabilityContext.config` has been in the contract since capabilities were,
 * described as "per-agent configuration, from `agent_tools.config`". It was
 * never any such thing. Capabilities left `agent_tools` when migration 0068
 * gave them their own table, and before that nothing wrote the row anyway; and
 * `stepGenerate`, the only production caller of `runCapabilityLoop`, passed
 * `permissions` and never `configs`. So every capability was handed `{}` and
 * the sentence describing where it came from was false. See migration 0069.
 */
export async function capabilitySettings(agentId: string): Promise<CapabilitySettings> {
  const stored = await permissionsRepo.listForAgent(agentId).catch(() => []);
  const byId = new Map(stored.map((row) => [row.capability_id, row]));
  const permissions = new Map<string, CapabilityPermission>();
  const configs = new Map<string, Record<string, unknown>>();

  for (const capability of listCapabilities()) {
    const row = byId.get(capability.id);
    permissions.set(capability.id, row?.permission ?? defaultPermission(capability.effect, capability.risk));
    // `config` is `NOT NULL DEFAULT '{}'` and checked to be an object, so the
    // only question is whether there is anything in it worth carrying.
    if (row?.config && Object.keys(row.config).length > 0) configs.set(capability.id, row.config);
  }
  return { permissions, configs };
}
