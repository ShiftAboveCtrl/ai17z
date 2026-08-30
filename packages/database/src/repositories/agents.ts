import type { Agent, PersonaDraft, PersonaVersion, PolicyConfig } from '@xbam/shared/contracts';
import { PolicyConfig as PolicyConfigSchema } from '@xbam/shared/contracts';
import { DEFAULT_POLICY, NotFoundError, slugify } from '@xbam/shared';
import { query, queryOne, withTransaction, type Tx } from '../pool';
import { mapRow, mapRows } from '../mapper';

const AGENT_COLUMNS = `
  id, owner_id, slug, name, description, avatar_url, avatar_mode, state, last_error,
  persona_version_id, policy_version_id, pipeline_version_id, created_at, updated_at`;

export async function listAgents(ownerId: string): Promise<Agent[]> {
  return mapRows<Agent>(
    await query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE owner_id = $1 ORDER BY created_at DESC`, [ownerId]),
  );
}

export async function getAgent(id: string): Promise<Agent | null> {
  return mapRow<Agent>(await queryOne(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [id]));
}

export async function getAgentBySlug(ownerId: string, slug: string): Promise<Agent | null> {
  return mapRow<Agent>(
    await queryOne(`SELECT ${AGENT_COLUMNS} FROM agents WHERE owner_id = $1 AND slug = $2`, [ownerId, slug]),
  );
}

export async function requireAgent(id: string): Promise<Agent> {
  const agent = await getAgent(id);
  if (!agent) throw new NotFoundError('Agent');
  return agent;
}

async function nextVersion(tx: Tx, table: string, column: string, parentId: string): Promise<number> {
  const row = await tx.one<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM ${table} WHERE ${column} = $1`,
    [parentId],
  );
  return row?.next ?? 1;
}

async function insertPersonaVersion(
  tx: Tx,
  personaId: string,
  agentId: string,
  draft: PersonaDraft,
  createdBy: string | null,
): Promise<PersonaVersion> {
  const version = await nextVersion(tx, 'persona_versions', 'persona_id', personaId);
  const row = await tx.one(
    `INSERT INTO persona_versions (
       persona_id, version, identity_kind, display_name, biography, personality, tone,
       style_guidelines, style_examples, topics, language_policy, response_length,
       prohibited_behaviors, custom_instructions, change_note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16)
     RETURNING *`,
    [
      personaId,
      version,
      draft.identityKind,
      draft.displayName,
      draft.biography,
      draft.personality,
      draft.tone,
      draft.styleGuidelines,
      JSON.stringify(draft.styleExamples),
      JSON.stringify(draft.topics),
      draft.languagePolicy,
      draft.responseLength,
      JSON.stringify(draft.prohibitedBehaviors),
      draft.customInstructions,
      draft.changeNote,
      createdBy,
    ],
  );
  return { ...(mapRow<PersonaVersion>(row) as PersonaVersion), agentId };
}

async function insertPolicyVersion(
  tx: Tx,
  policyId: string,
  config: PolicyConfig,
  changeNote: string,
  createdBy: string | null,
): Promise<{ id: string; version: number; config: PolicyConfig }> {
  const version = await nextVersion(tx, 'policy_versions', 'policy_id', policyId);
  const row = await tx.one<{ id: string; version: number; config: PolicyConfig }>(
    `INSERT INTO policy_versions (policy_id, version, config, change_note, created_by)
     VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id, version, config`,
    [policyId, version, JSON.stringify(config), changeNote, createdBy],
  );
  return row as { id: string; version: number; config: PolicyConfig };
}

export interface CreateAgentRecord {
  ownerId: string;
  name: string;
  slug?: string;
  description?: string;
  avatarUrl?: string | null;
  avatarMode?: 'IMAGE' | 'PORTRAIT_25D' | 'MODEL_3D';
  persona: PersonaDraft;
  policy?: PolicyConfig;
  createdBy?: string | null;
}

/**
 * Creates an agent together with version 1 of its persona and policy in one
 * transaction. An agent without an active persona/policy pointer is never valid,
 * so the two cannot be created separately.
 */
export async function createAgent(input: CreateAgentRecord): Promise<Agent> {
  return withTransaction(async (tx) => {
    const slug = input.slug ?? slugify(input.name);
    const agentRow = await tx.one<{ id: string }>(
      `INSERT INTO agents (owner_id, slug, name, description, avatar_url, avatar_mode, state)
       VALUES ($1,$2,$3,$4,$5,$6,'DRAFT') RETURNING id`,
      [
        input.ownerId,
        slug,
        input.name,
        input.description ?? '',
        input.avatarUrl ?? null,
        input.avatarMode ?? 'PORTRAIT_25D',
      ],
    );
    const agentId = agentRow!.id;

    const persona = await tx.one<{ id: string }>('INSERT INTO personas (agent_id) VALUES ($1) RETURNING id', [agentId]);
    const policy = await tx.one<{ id: string }>('INSERT INTO policies (agent_id) VALUES ($1) RETURNING id', [agentId]);

    const personaVersion = await insertPersonaVersion(tx, persona!.id, agentId, input.persona, input.createdBy ?? null);
    const policyVersion = await insertPolicyVersion(
      tx,
      policy!.id,
      input.policy ?? DEFAULT_POLICY,
      'initial',
      input.createdBy ?? null,
    );

    const updated = await tx.one(
      `UPDATE agents SET persona_version_id = $2, policy_version_id = $3, updated_at = now()
       WHERE id = $1 RETURNING ${AGENT_COLUMNS}`,
      [agentId, personaVersion.id, policyVersion.id],
    );
    return mapRow<Agent>(updated) as Agent;
  });
}

export async function updateAgent(
  id: string,
  patch: Partial<Pick<Agent, 'name' | 'description' | 'avatarUrl' | 'avatarMode' | 'state' | 'lastError'>>,
): Promise<Agent> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.description !== undefined) push('description', patch.description);
  if (patch.avatarUrl !== undefined) push('avatar_url', patch.avatarUrl);
  if (patch.avatarMode !== undefined) push('avatar_mode', patch.avatarMode);
  if (patch.state !== undefined) push('state', patch.state);
  if (patch.lastError !== undefined) push('last_error', patch.lastError);
  if (sets.length === 0) return requireAgent(id);

  const row = await queryOne(
    `UPDATE agents SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${AGENT_COLUMNS}`,
    params,
  );
  if (!row) throw new NotFoundError('Agent');
  return mapRow<Agent>(row) as Agent;
}

export async function deleteAgent(id: string): Promise<void> {
  await query('DELETE FROM agents WHERE id = $1', [id]);
}

export async function getPersonaVersion(id: string): Promise<PersonaVersion | null> {
  const row = await queryOne(
    `SELECT pv.*, p.agent_id FROM persona_versions pv JOIN personas p ON p.id = pv.persona_id WHERE pv.id = $1`,
    [id],
  );
  return mapRow<PersonaVersion>(row);
}

export async function getActivePersona(agentId: string): Promise<PersonaVersion | null> {
  const row = await queryOne(
    `SELECT pv.*, p.agent_id FROM agents a
       JOIN persona_versions pv ON pv.id = a.persona_version_id
       JOIN personas p ON p.id = pv.persona_id
      WHERE a.id = $1`,
    [agentId],
  );
  return mapRow<PersonaVersion>(row);
}

export async function listPersonaVersions(agentId: string): Promise<PersonaVersion[]> {
  const rows = await query(
    `SELECT pv.*, p.agent_id FROM personas p JOIN persona_versions pv ON pv.persona_id = p.id
      WHERE p.agent_id = $1 ORDER BY pv.version DESC`,
    [agentId],
  );
  return mapRows<PersonaVersion>(rows);
}

/** Every persona edit creates a new version and repoints the agent at it. */
export async function savePersonaVersion(
  agentId: string,
  draft: PersonaDraft,
  createdBy: string | null,
): Promise<PersonaVersion> {
  return withTransaction(async (tx) => {
    const persona = await tx.one<{ id: string }>('SELECT id FROM personas WHERE agent_id = $1', [agentId]);
    if (!persona) throw new NotFoundError('Persona');
    const version = await insertPersonaVersion(tx, persona.id, agentId, draft, createdBy);
    await tx.query('UPDATE agents SET persona_version_id = $2, updated_at = now() WHERE id = $1', [
      agentId,
      version.id,
    ]);
    return version;
  });
}

export interface PolicyVersionRow {
  id: string;
  policyId: string;
  version: number;
  config: PolicyConfig;
  changeNote: string;
  createdAt: string;
}

/**
 * Reads a stored policy forward into the current shape.
 *
 * A row written before a field existed simply does not have it, and every
 * reader would then have to guard for a section that is undefined rather than
 * defaulted. Parsing through the schema fills the gaps with the same defaults a
 * new agent gets, which is what "the config is versioned" is supposed to mean.
 *
 * This is a read: the row is not rewritten. The next save records the filled-in
 * shape as an ordinary new version, with its change note.
 */
function fillDefaults(row: PolicyVersionRow): PolicyVersionRow {
  const parsed = PolicyConfigSchema.safeParse(row.config ?? {});
  return { ...row, config: parsed.success ? parsed.data : DEFAULT_POLICY };
}

function readPolicyRow(row: Record<string, unknown> | null): PolicyVersionRow | null {
  const mapped = mapRow<PolicyVersionRow>(row);
  return mapped ? fillDefaults(mapped) : null;
}

export async function getActivePolicy(agentId: string): Promise<PolicyVersionRow | null> {
  const row = await queryOne(
    `SELECT pv.* FROM agents a JOIN policy_versions pv ON pv.id = a.policy_version_id WHERE a.id = $1`,
    [agentId],
  );
  return readPolicyRow(row);
}

export async function getPolicyVersion(id: string): Promise<PolicyVersionRow | null> {
  return readPolicyRow(await queryOne('SELECT * FROM policy_versions WHERE id = $1', [id]));
}

export async function listPolicyVersions(agentId: string): Promise<PolicyVersionRow[]> {
  const rows = await query(
    `SELECT pv.* FROM policies p JOIN policy_versions pv ON pv.policy_id = p.id
      WHERE p.agent_id = $1 ORDER BY pv.version DESC`,
    [agentId],
  );
  return mapRows<PolicyVersionRow>(rows).map(fillDefaults);
}

export async function savePolicyVersion(
  agentId: string,
  config: PolicyConfig,
  changeNote: string,
  createdBy: string | null,
): Promise<PolicyVersionRow> {
  return withTransaction(async (tx) => {
    const policy = await tx.one<{ id: string }>('SELECT id FROM policies WHERE agent_id = $1', [agentId]);
    if (!policy) throw new NotFoundError('Policy');
    const version = await insertPolicyVersion(tx, policy.id, config, changeNote, createdBy);
    await tx.query('UPDATE agents SET policy_version_id = $2, updated_at = now() WHERE id = $1', [agentId, version.id]);
    return { ...version, policyId: policy.id, changeNote, createdAt: new Date().toISOString() };
  });
}

export interface AgentStats {
  memories: number;
  accounts: number;
  jobsTotal: number;
  jobsNeedingReview: number;
  jobsFailed: number;
  lastActivityAt: string | null;
}

export async function getAgentStats(agentId: string): Promise<AgentStats> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM memories WHERE agent_id = $1) AS memories,
       (SELECT count(*)::int FROM agent_accounts WHERE agent_id = $1) AS accounts,
       (SELECT count(*)::int FROM jobs WHERE agent_id = $1) AS jobs_total,
       (SELECT count(*)::int FROM jobs WHERE agent_id = $1 AND status IN ('REVIEW_REQUIRED','WAITING_FOR_APPROVAL')) AS jobs_needing_review,
       (SELECT count(*)::int FROM jobs WHERE agent_id = $1 AND status = 'PERMANENT_FAILURE') AS jobs_failed,
       (SELECT max(created_at) FROM jobs WHERE agent_id = $1) AS last_activity_at`,
    [agentId],
  );
  return mapRow<AgentStats>(row) as AgentStats;
}

export async function countMemoriesByScope(agentId: string): Promise<Record<string, number>> {
  const rows = await query<{ scope: string; count: number }>(
    'SELECT scope, count(*)::int AS count FROM memories WHERE agent_id = $1 GROUP BY scope',
    [agentId],
  );
  return Object.fromEntries(rows.map((r) => [r.scope, r.count]));
}
