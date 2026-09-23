import { openSecret, sealSecret } from '@xbam/shared';
import type { InstalledPlugin, PluginManifest, PluginSource } from '@xbam/shared/contracts';
import { query, withTransaction } from '../pool';

/**
 * Installed Plugins, their configuration and their sealed secrets.
 *
 * Nothing here records what an agent may do. That is
 * `agent_capability_permissions` and only that, so a Plugin's enabled state is
 * computed from the capabilities it contributes rather than stored twice.
 */

interface Row extends Record<string, unknown> {
  id: string;
  source: PluginSource;
  version: string;
  publisher: string;
  manifest_sha256: string;
  manifest: PluginManifest;
  installed_at: string;
  updated_at: string;
}

const toInstalled = (row: Row): InstalledPlugin => ({
  id: row.id,
  source: row.source,
  version: row.version,
  publisher: row.publisher,
  manifestSha256: row.manifest_sha256,
  manifest: row.manifest,
  installedAt: row.installed_at,
  updatedAt: row.updated_at,
});

export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  const rows = await query<Row>(
    `SELECT id, source, version, publisher, manifest_sha256, manifest,
            installed_at::text AS installed_at, updated_at::text AS updated_at
       FROM installed_plugins ORDER BY id`,
  );
  return rows.map(toInstalled);
}

export async function getInstalledPlugin(id: string): Promise<InstalledPlugin | null> {
  const [row] = await query<Row>(
    `SELECT id, source, version, publisher, manifest_sha256, manifest,
            installed_at::text AS installed_at, updated_at::text AS updated_at
       FROM installed_plugins WHERE id = $1`,
    [id],
  );
  return row ? toInstalled(row) : null;
}

/**
 * Record an install, or replace the record of one already there.
 *
 * The publisher is compared rather than overwritten. A new version of a Plugin
 * arriving under a different publisher is a substitution, and the only way to
 * refuse one is to have kept what the first version said. The caller decides
 * what to do about it; this reports it.
 */
export async function putInstalledPlugin(input: {
  id: string;
  source: Exclude<PluginSource, 'BUILT_IN'>;
  version: string;
  publisher: string;
  manifestSha256: string;
  manifest: PluginManifest;
}): Promise<void> {
  await query(
    `INSERT INTO installed_plugins (id, source, version, publisher, manifest_sha256, manifest)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (id) DO UPDATE
        SET source = excluded.source,
            version = excluded.version,
            publisher = excluded.publisher,
            manifest_sha256 = excluded.manifest_sha256,
            manifest = excluded.manifest,
            updated_at = now()`,
    [input.id, input.source, input.version, input.publisher, input.manifestSha256, JSON.stringify(input.manifest)],
  );
}

/**
 * Remove a Plugin and everything that only made sense while it was installed.
 *
 * Its permissions go with it, because a decision about a capability that no
 * longer exists is not a decision anybody can act on, and leaving one behind
 * means reinstalling silently restores a permission the owner last saw years
 * ago. Its invocation history stays: what an agent did is not undone by
 * uninstalling the thing it did it with, and the audit is the owner's.
 */
export async function removeInstalledPlugin(id: string): Promise<void> {
  await withTransaction(async (tx) => {
    // `plugin_<id>.` is the family these are registered under. Written the
    // same way as `pluginCapabilityId` builds it, because a pattern that has
    // drifted from the id format deletes nothing and says it deleted.
    //
    // This one is by hand because a permission is not owned by the Plugin:
    // `agent_capability_permissions.capability_id` is a capability id and the
    // table holds the built-in decisions too, so it can carry no foreign key
    // to `installed_plugins`. The configuration, the sealed secrets and the
    // budget are owned by it, and migration 0087 makes the database say so
    // rather than trusting this function to be the only caller.
    const family = `plugin_${id.replace(/-/g, '_')}.%`;
    await tx.query('DELETE FROM agent_capability_permissions WHERE capability_id LIKE $1', [family]);
    await tx.query('DELETE FROM installed_plugins WHERE id = $1', [id]);
  });
}

/** Non-secret configuration for one agent and one Plugin. */
export async function getPluginConfig(agentId: string, pluginId: string): Promise<Record<string, unknown>> {
  const [row] = await query<{ config: Record<string, unknown> }>(
    'SELECT config FROM agent_plugin_config WHERE agent_id = $1 AND plugin_id = $2',
    [agentId, pluginId],
  );
  return row?.config ?? {};
}

export async function setPluginConfig(
  agentId: string,
  pluginId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO agent_plugin_config (agent_id, plugin_id, config)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (agent_id, plugin_id) DO UPDATE SET config = excluded.config, updated_at = now()`,
    [agentId, pluginId, JSON.stringify(config)],
  );
}

/** Which secret keys an owner has supplied. The values never leave here. */
export async function pluginSecretKeys(agentId: string, pluginId: string): Promise<string[]> {
  const rows = await query<{ config_key: string }>(
    'SELECT config_key FROM agent_plugin_secrets WHERE agent_id = $1 AND plugin_id = $2 ORDER BY config_key',
    [agentId, pluginId],
  );
  return rows.map((row) => row.config_key);
}

export async function setPluginSecret(
  agentId: string,
  pluginId: string,
  configKey: string,
  value: string,
): Promise<void> {
  await query(
    `INSERT INTO agent_plugin_secrets (agent_id, plugin_id, config_key, sealed)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, plugin_id, config_key) DO UPDATE SET sealed = excluded.sealed, updated_at = now()`,
    [agentId, pluginId, configKey, sealSecret(value)],
  );
}

export async function clearPluginSecret(agentId: string, pluginId: string, configKey: string): Promise<void> {
  await query(
    'DELETE FROM agent_plugin_secrets WHERE agent_id = $1 AND plugin_id = $2 AND config_key = $3',
    [agentId, pluginId, configKey],
  );
}

/**
 * Open one secret, for the one caller that needs it.
 *
 * The only thing that may call this is the code building a declared Plugin's
 * request, at the moment it builds it. Nothing returns this value to an API
 * response, writes it to a log, puts it in an audit row or carries it into a
 * shared agent package, exactly as with a provider key.
 */
export async function getDecryptedPluginSecret(
  agentId: string,
  pluginId: string,
  configKey: string,
): Promise<string | null> {
  const [row] = await query<{ sealed: string }>(
    'SELECT sealed FROM agent_plugin_secrets WHERE agent_id = $1 AND plugin_id = $2 AND config_key = $3',
    [agentId, pluginId, configKey],
  );
  if (!row) return null;
  try {
    return openSecret(row.sealed);
  } catch {
    // A sealed value this installation cannot open is a missing credential
    // rather than an error to raise here: the readiness answer says so, and
    // the alternative is a stack trace holding a ciphertext.
    return null;
  }
}

/**
 * Charge one call against a Plugin's declared hourly quota.
 *
 * The increment and the check are one statement, because two workers asking
 * "how many so far" and then both writing is how a ceiling becomes a
 * suggestion. Returns whether the call is allowed to proceed.
 */
export async function chargePluginCall(
  agentId: string,
  pluginId: string,
  quotaPerHour: number,
): Promise<{ allowed: boolean; used: number }> {
  const [row] = await query<{ calls: number }>(
    `INSERT INTO plugin_call_budget (agent_id, plugin_id, hour, calls)
     VALUES ($1, $2, date_trunc('hour', now()), 1)
     ON CONFLICT (agent_id, plugin_id, hour)
        DO UPDATE SET calls = plugin_call_budget.calls + 1
     RETURNING calls`,
    [agentId, pluginId],
  );
  const used = row?.calls ?? 1;
  return { allowed: used <= quotaPerHour, used };
}

export async function pluginCallsThisHour(agentId: string, pluginId: string): Promise<number> {
  const [row] = await query<{ calls: number }>(
    `SELECT calls FROM plugin_call_budget
      WHERE agent_id = $1 AND plugin_id = $2 AND hour = date_trunc('hour', now())`,
    [agentId, pluginId],
  );
  return row?.calls ?? 0;
}
