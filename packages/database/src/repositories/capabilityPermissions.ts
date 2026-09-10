import { query } from '../pool';

/**
 * What an owner has decided about each capability, for one agent.
 *
 * A table of its own, reluctantly. `agent_tools` was the intended home and
 * cannot be one: its `tool_id` is a foreign key into the built-in tool
 * catalogue, and capability ids are registry-defined and have never been in it.
 * `setAgentTool` selects the catalogue row by key and inserts nothing when
 * there is none, so every capability permission an owner set was written
 * nowhere and read back as the default. See migration 0068.
 */

export interface CapabilityPermissionRow extends Record<string, unknown> {
  agent_id: string;
  capability_id: string;
  permission: 'DISABLED' | 'OWNER_APPROVAL' | 'ALLOWED';
  /** Named settings for this capability and this agent. Always an object. */
  config: Record<string, unknown>;
  updated_at: string;
}

/** Everything this owner has decided for one agent. */
export async function listForAgent(agentId: string): Promise<CapabilityPermissionRow[]> {
  return query<CapabilityPermissionRow>(
    'SELECT * FROM agent_capability_permissions WHERE agent_id = $1',
    [agentId],
  );
}

/**
 * Records a decision, replacing whatever was there.
 *
 * Returns the row it wrote. A caller that gets nothing back has not persisted
 * anything, which is the failure this whole table exists because of -- it must
 * be possible to tell the difference without reading the database again.
 */
export async function set(input: {
  agentId: string;
  capabilityId: string;
  permission: 'DISABLED' | 'OWNER_APPROVAL' | 'ALLOWED';
}): Promise<CapabilityPermissionRow | null> {
  const rows = await query<CapabilityPermissionRow>(
    `INSERT INTO agent_capability_permissions (agent_id, capability_id, permission)
     VALUES ($1,$2,$3)
     ON CONFLICT (agent_id, capability_id)
       -- Deliberately leaves the config column alone. Deciding whether a
       -- capability may run and deciding how it should behave are separate
       -- acts, and toggling one off and on again should not silently discard
       -- the other. (No backticks in here: this is a template literal, and one
       -- inside a SQL comment ends it thirty lines before the error appears.)
       DO UPDATE SET permission = excluded.permission, updated_at = now()
     RETURNING *`,
    [input.agentId, input.capabilityId, input.permission],
  );
  return rows[0] ?? null;
}

/**
 * Records the settings for one capability, replacing whatever was there.
 *
 * Replacing rather than merging, because a merge has no way to remove a
 * setting: an owner clearing a field would send an object without it and get
 * back the value they just cleared.
 *
 * The permission is left alone for the same reason `set` leaves the config
 * alone, and defaults when there is no row yet -- writing settings for a
 * capability nobody has decided about must not quietly allow it, so the column
 * default (DISABLED) is not used here; the caller's default is applied by the
 * reader instead. What goes in is the safest value, and the reader still
 * prefers the capability's own default when no decision was ever recorded.
 */
export async function setConfig(input: {
  agentId: string;
  capabilityId: string;
  permission: 'DISABLED' | 'OWNER_APPROVAL' | 'ALLOWED';
  config: Record<string, unknown>;
}): Promise<CapabilityPermissionRow | null> {
  const rows = await query<CapabilityPermissionRow>(
    `INSERT INTO agent_capability_permissions (agent_id, capability_id, permission, config)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (agent_id, capability_id)
       DO UPDATE SET config = excluded.config, updated_at = now()
     RETURNING *`,
    [input.agentId, input.capabilityId, input.permission, JSON.stringify(input.config ?? {})],
  );
  return rows[0] ?? null;
}

/** Forgets a decision, so the capability falls back to its own default. */
export async function clear(agentId: string, capabilityId: string): Promise<void> {
  await query('DELETE FROM agent_capability_permissions WHERE agent_id = $1 AND capability_id = $2', [
    agentId,
    capabilityId,
  ]);
}
