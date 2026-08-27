import type { Capability } from '@xbam/shared/contracts';
import { CAPABILITIES } from '@xbam/shared/contracts';
import { query, withTransaction } from '../pool';

/** Everything a link grants, in a set that is cheap to ask questions of. */
export async function grantsFor(agentId: string, accountId: string): Promise<Set<Capability>> {
  const rows = await query<{ capability: string }>(
    'SELECT capability FROM agent_account_capabilities WHERE agent_id = $1 AND account_id = $2',
    [agentId, accountId],
  );
  return new Set(rows.map((r) => r.capability as Capability));
}

/** Grants for every account an agent is linked to, keyed by account id. */
export async function grantsForAgent(agentId: string): Promise<Map<string, Capability[]>> {
  const rows = await query<{ account_id: string; capability: string }>(
    'SELECT account_id, capability FROM agent_account_capabilities WHERE agent_id = $1',
    [agentId],
  );
  const map = new Map<string, Capability[]>();
  for (const row of rows) {
    const list = map.get(row.account_id) ?? [];
    list.push(row.capability as Capability);
    map.set(row.account_id, list);
  }
  return map;
}

/**
 * Replaces the grants on a link.
 *
 * Written as a delete plus an insert inside one transaction rather than a diff,
 * because the set is small and a partially applied permission change is the one
 * outcome that must not be possible.
 */
export async function setGrants(
  agentId: string,
  accountId: string,
  capabilities: Capability[],
  grantedBy: string | null,
): Promise<Capability[]> {
  const wanted = CAPABILITIES.filter((c) => capabilities.includes(c));
  await withTransaction(async (tx) => {
    await tx.query('DELETE FROM agent_account_capabilities WHERE agent_id = $1 AND account_id = $2', [
      agentId,
      accountId,
    ]);
    for (const capability of wanted) {
      await tx.query(
        `INSERT INTO agent_account_capabilities (agent_id, account_id, capability, granted_by)
         VALUES ($1,$2,$3,$4)`,
        [agentId, accountId, capability, grantedBy],
      );
    }
  });
  return [...wanted];
}
