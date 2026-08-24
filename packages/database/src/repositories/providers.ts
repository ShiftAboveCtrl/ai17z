import type { ModelConfig, ModelRole, ProviderCredential, ProviderKind } from '@xbam/shared/contracts';
import { NotFoundError, openSecret, sealSecret, secretFingerprint } from '@xbam/shared';
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

/**
 * `sealed_api_key` is never selected into anything the API can return. The only
 * way to read a key is `getDecryptedApiKey`, which is called from the worker and
 * the connection tester, and whose result never leaves the process.
 */
const PUBLIC_COLUMNS = `
  id, owner_id, provider, label, base_url, key_fingerprint,
  (sealed_api_key IS NOT NULL) AS has_key,
  available_models, default_model, timeout_ms, enabled,
  last_checked_at, last_status, created_at, updated_at`;

export async function listProviders(ownerId: string): Promise<ProviderCredential[]> {
  return mapRows<ProviderCredential>(
    await query(`SELECT ${PUBLIC_COLUMNS} FROM provider_credentials WHERE owner_id = $1 ORDER BY created_at`, [
      ownerId,
    ]),
  );
}

export async function getProvider(id: string): Promise<ProviderCredential | null> {
  return mapRow<ProviderCredential>(
    await queryOne(`SELECT ${PUBLIC_COLUMNS} FROM provider_credentials WHERE id = $1`, [id]),
  );
}

export async function requireProvider(id: string): Promise<ProviderCredential> {
  const provider = await getProvider(id);
  if (!provider) throw new NotFoundError('Provider');
  return provider;
}

export async function createProvider(input: {
  ownerId: string;
  provider: ProviderKind;
  label: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  availableModels?: string[];
  defaultModel?: string | null;
  timeoutMs?: number;
  enabled?: boolean;
}): Promise<ProviderCredential> {
  const sealed = input.apiKey ? sealSecret(input.apiKey) : null;
  const row = await queryOne(
    `INSERT INTO provider_credentials
       (owner_id, provider, label, base_url, sealed_api_key, key_fingerprint,
        available_models, default_model, timeout_ms, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      input.ownerId,
      input.provider,
      input.label,
      input.baseUrl ?? null,
      sealed,
      input.apiKey ? secretFingerprint(input.apiKey) : null,
      JSON.stringify(input.availableModels ?? []),
      input.defaultModel ?? null,
      input.timeoutMs ?? 60_000,
      input.enabled ?? true,
    ],
  );
  return mapRow<ProviderCredential>(row) as ProviderCredential;
}

export async function updateProvider(
  id: string,
  patch: Partial<{
    label: string;
    baseUrl: string | null;
    apiKey: string | null;
    availableModels: string[];
    defaultModel: string | null;
    timeoutMs: number;
    enabled: boolean;
    lastStatus: string | null;
    touchChecked: boolean;
  }>,
): Promise<ProviderCredential> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (patch.label !== undefined) push('label = $?', patch.label);
  if (patch.baseUrl !== undefined) push('base_url = $?', patch.baseUrl);
  if (patch.apiKey !== undefined) {
    // An explicit null clears the key; undefined leaves it untouched.
    push('sealed_api_key = $?', patch.apiKey === null ? null : sealSecret(patch.apiKey));
    push('key_fingerprint = $?', patch.apiKey === null ? null : secretFingerprint(patch.apiKey));
  }
  if (patch.availableModels !== undefined) push('available_models = $?::jsonb', JSON.stringify(patch.availableModels));
  if (patch.defaultModel !== undefined) push('default_model = $?', patch.defaultModel);
  if (patch.timeoutMs !== undefined) push('timeout_ms = $?', patch.timeoutMs);
  if (patch.enabled !== undefined) push('enabled = $?', patch.enabled);
  if (patch.lastStatus !== undefined) push('last_status = $?', patch.lastStatus);
  if (patch.touchChecked) sets.push('last_checked_at = now()');
  if (sets.length === 0) return requireProvider(id);

  const row = await queryOne(
    `UPDATE provider_credentials SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    params,
  );
  if (!row) throw new NotFoundError('Provider');
  return mapRow<ProviderCredential>(row) as ProviderCredential;
}

export async function deleteProvider(id: string): Promise<void> {
  await query('DELETE FROM provider_credentials WHERE id = $1', [id]);
}

/** Server-side only. The plaintext key must never be put in an API response. */
export async function getDecryptedApiKey(id: string): Promise<string | null> {
  const row = await queryOne<{ sealed_api_key: string | null }>(
    'SELECT sealed_api_key FROM provider_credentials WHERE id = $1',
    [id],
  );
  if (!row?.sealed_api_key) return null;
  return openSecret(row.sealed_api_key);
}

const MODEL_CONFIG_COLUMNS = `
  mc.id, mc.agent_id, mc.role, mc.provider_credential_id, mc.model, mc.parameters,
  pc.provider, pc.label AS provider_label`;

export async function listModelConfigs(agentId: string): Promise<ModelConfig[]> {
  const rows = await query(
    `SELECT ${MODEL_CONFIG_COLUMNS} FROM model_configs mc
       JOIN provider_credentials pc ON pc.id = mc.provider_credential_id
      WHERE mc.agent_id = $1
      ORDER BY CASE mc.role WHEN 'primary' THEN 0 WHEN 'fallback_1' THEN 1 WHEN 'fallback_2' THEN 2 ELSE 3 END`,
    [agentId],
  );
  return mapRows<ModelConfig>(rows);
}

export async function setModelConfig(input: {
  agentId: string;
  role: ModelRole;
  providerCredentialId: string;
  model: string;
  parameters: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO model_configs (agent_id, role, provider_credential_id, model, parameters)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (agent_id, role) DO UPDATE
       SET provider_credential_id = excluded.provider_credential_id,
           model = excluded.model,
           parameters = excluded.parameters,
           updated_at = now()`,
    [input.agentId, input.role, input.providerCredentialId, input.model, JSON.stringify(input.parameters)],
  );
}

export async function deleteModelConfig(agentId: string, role: ModelRole): Promise<void> {
  await query('DELETE FROM model_configs WHERE agent_id = $1 AND role = $2', [agentId, role]);
}
