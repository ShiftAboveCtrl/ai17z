import { defaultPermission, type CapabilityPermission } from '@xbam/shared/contracts';
import { ops } from '@xbam/database';
import { listCapabilities } from '@xbam/tools';

/**
 * What an owner has decided about each capability, for one agent.
 *
 * Read out of `agent_tools`, which already exists and already carries a
 * per-agent switch and a config blob. `docs/ENGINEERING.md` is clear that only
 * genuinely new concepts get new tables, and "may this agent use this" is not
 * new -- only the invocation record was.
 *
 * Three sources, in order:
 *
 *   1. `config.permission`, when the owner chose one of the three states. The
 *      boolean cannot express OWNER_APPROVAL, and an owner who wants to watch
 *      the first few uses should not have to choose between off and unattended.
 *   2. the `enabled` boolean, for a row written before that existed.
 *   3. the capability's own default -- reads allowed, writes not.
 *
 * A capability with no row at all falls to its default, which is what makes a
 * newly registered read work without anybody configuring anything, and a newly
 * registered write not.
 */
export async function capabilityPermissions(agentId: string): Promise<Map<string, CapabilityPermission>> {
  const stored = await ops.listAgentTools(agentId).catch(() => []);
  const byKey = new Map(stored.map((row) => [row.key, row]));
  const permissions = new Map<string, CapabilityPermission>();

  for (const capability of listCapabilities()) {
    const row = byKey.get(capability.id);
    const configured = (row?.config as { permission?: unknown } | undefined)?.permission;
    if (configured === 'ALLOWED' || configured === 'OWNER_APPROVAL' || configured === 'DISABLED') {
      permissions.set(capability.id, configured);
      continue;
    }
    if (row) {
      permissions.set(capability.id, row.enabled ? 'ALLOWED' : 'DISABLED');
      continue;
    }
    permissions.set(capability.id, defaultPermission(capability.effect, capability.risk));
  }
  return permissions;
}
