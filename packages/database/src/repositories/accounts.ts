import type { Account, AgentAccountLink, BrowserSession, ChannelId } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { query, queryOne, withTransaction } from '../pool';
import { mapRow, mapRows } from '../mapper';

const ACCOUNT_COLUMNS = `
  id, owner_id, channel, remote_account_id, handle, display_name, status, enabled,
  capabilities, settings, last_health_check_at, last_health_status, last_activity_at,
  last_error, created_at, updated_at`;

export async function listAccounts(ownerId: string): Promise<Account[]> {
  return mapRows<Account>(
    await query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE owner_id = $1 ORDER BY created_at`, [ownerId]),
  );
}

export async function getAccount(id: string): Promise<Account | null> {
  return mapRow<Account>(await queryOne(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]));
}

export async function requireAccount(id: string): Promise<Account> {
  const account = await getAccount(id);
  if (!account) throw new NotFoundError('Account');
  return account;
}

export async function findAccountByHandle(
  ownerId: string,
  channel: ChannelId,
  handle: string,
): Promise<Account | null> {
  return mapRow<Account>(
    await queryOne(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE owner_id = $1 AND channel = $2 AND lower(handle) = lower($3)`,
      [ownerId, channel, handle],
    ),
  );
}

export async function createAccount(input: {
  ownerId: string;
  channel: ChannelId;
  handle: string;
  displayName?: string;
  remoteAccountId?: string | null;
  capabilities?: string[];
  settings?: Record<string, unknown>;
  browser?: { mode: 'MANAGED' | 'CDP'; cdpUrl?: string; profileDir?: string };
}): Promise<Account> {
  return withTransaction(async (tx) => {
    const row = await tx.one(
      `INSERT INTO accounts (owner_id, channel, handle, display_name, remote_account_id, capabilities, settings)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        input.ownerId,
        input.channel,
        input.handle,
        input.displayName ?? input.handle,
        input.remoteAccountId ?? null,
        JSON.stringify(input.capabilities ?? []),
        JSON.stringify(input.settings ?? {}),
      ],
    );
    const account = mapRow<Account>(row) as Account;
    if (input.browser) {
      await tx.query(
        `INSERT INTO browser_sessions (account_id, mode, cdp_url, profile_dir, status)
         VALUES ($1,$2,$3,$4,'UNKNOWN')`,
        [account.id, input.browser.mode, input.browser.cdpUrl ?? null, input.browser.profileDir ?? null],
      );
    }
    return account;
  });
}

export async function updateAccount(
  id: string,
  patch: Partial<{
    displayName: string;
    remoteAccountId: string | null;
    status: Account['status'];
    enabled: boolean;
    capabilities: string[];
    settings: Record<string, unknown>;
    lastHealthStatus: string | null;
    lastError: string | null;
    touchHealthCheck: boolean;
    touchActivity: boolean;
  }>,
): Promise<Account> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace('$?', `$${params.length}`));
  };
  if (patch.displayName !== undefined) push('display_name = $?', patch.displayName);
  if (patch.remoteAccountId !== undefined) push('remote_account_id = $?', patch.remoteAccountId);
  if (patch.status !== undefined) push('status = $?', patch.status);
  if (patch.enabled !== undefined) push('enabled = $?', patch.enabled);
  if (patch.capabilities !== undefined) push('capabilities = $?::jsonb', JSON.stringify(patch.capabilities));
  if (patch.settings !== undefined) push('settings = $?::jsonb', JSON.stringify(patch.settings));
  if (patch.lastHealthStatus !== undefined) push('last_health_status = $?', patch.lastHealthStatus);
  if (patch.lastError !== undefined) push('last_error = $?', patch.lastError);
  if (patch.touchHealthCheck) sets.push('last_health_check_at = now()');
  if (patch.touchActivity) sets.push('last_activity_at = now()');
  if (sets.length === 0) return requireAccount(id);

  const row = await queryOne(
    `UPDATE accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
    params,
  );
  if (!row) throw new NotFoundError('Account');
  return mapRow<Account>(row) as Account;
}

export async function deleteAccount(id: string): Promise<void> {
  await query('DELETE FROM accounts WHERE id = $1', [id]);
}

export interface AgentAccountRow extends AgentAccountLink {
  channel: ChannelId;
  handle: string;
  displayName: string;
  status: Account['status'];
  accountEnabled: boolean;
}

export async function listAgentAccounts(agentId: string): Promise<AgentAccountRow[]> {
  const rows = await query(
    `SELECT aa.agent_id, aa.account_id, aa.trigger_event_types, aa.action_type, aa.enabled,
            a.channel, a.handle, a.display_name, a.status, a.enabled AS account_enabled
       FROM agent_accounts aa JOIN accounts a ON a.id = aa.account_id
      WHERE aa.agent_id = $1 ORDER BY aa.created_at`,
    [agentId],
  );
  return mapRows<AgentAccountRow>(rows);
}

/** Agents that should receive events from this account, in link creation order. */
export async function listAccountAgents(accountId: string): Promise<AgentAccountRow[]> {
  const rows = await query(
    `SELECT aa.agent_id, aa.account_id, aa.trigger_event_types, aa.action_type, aa.enabled,
            a.channel, a.handle, a.display_name, a.status, a.enabled AS account_enabled
       FROM agent_accounts aa JOIN accounts a ON a.id = aa.account_id
      WHERE aa.account_id = $1 AND aa.enabled AND a.enabled ORDER BY aa.created_at`,
    [accountId],
  );
  return mapRows<AgentAccountRow>(rows);
}

export async function linkAgentAccount(input: {
  agentId: string;
  accountId: string;
  triggerEventTypes?: string[];
  actionType?: string;
  enabled?: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO agent_accounts (agent_id, account_id, trigger_event_types, action_type, enabled)
     VALUES ($1,$2,$3::jsonb,$4,$5)
     ON CONFLICT (agent_id, account_id) DO UPDATE
       SET trigger_event_types = excluded.trigger_event_types,
           action_type = excluded.action_type,
           enabled = excluded.enabled`,
    [
      input.agentId,
      input.accountId,
      JSON.stringify(input.triggerEventTypes ?? ['MENTION']),
      input.actionType ?? 'REPLY',
      input.enabled ?? true,
    ],
  );
}

export async function unlinkAgentAccount(agentId: string, accountId: string): Promise<void> {
  await query('DELETE FROM agent_accounts WHERE agent_id = $1 AND account_id = $2', [agentId, accountId]);
}

export async function getBrowserSession(accountId: string): Promise<BrowserSession | null> {
  return mapRow<BrowserSession>(await queryOne('SELECT * FROM browser_sessions WHERE account_id = $1', [accountId]));
}

export async function upsertBrowserSession(input: {
  accountId: string;
  mode: 'MANAGED' | 'CDP';
  profileDir?: string | null;
  cdpUrl?: string | null;
  status?: string;
  lastError?: string | null;
}): Promise<BrowserSession> {
  const row = await queryOne(
    `INSERT INTO browser_sessions (account_id, mode, profile_dir, cdp_url, status, last_error, last_checked_at)
     VALUES ($1,$2,$3,$4,coalesce($5,'UNKNOWN'),$6, CASE WHEN $5 IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (account_id) DO UPDATE
       SET mode = excluded.mode,
           profile_dir = coalesce(excluded.profile_dir, browser_sessions.profile_dir),
           cdp_url = excluded.cdp_url,
           status = coalesce(excluded.status, browser_sessions.status),
           last_error = excluded.last_error,
           last_checked_at = coalesce(excluded.last_checked_at, browser_sessions.last_checked_at),
           updated_at = now()
     RETURNING *`,
    [
      input.accountId,
      input.mode,
      input.profileDir ?? null,
      input.cdpUrl ?? null,
      input.status ?? null,
      input.lastError ?? null,
    ],
  );
  return mapRow<BrowserSession>(row) as BrowserSession;
}

/** Wipes the stored session pointer. The profile directory is removed separately. */
export async function clearBrowserSession(accountId: string): Promise<void> {
  await query(
    `UPDATE browser_sessions SET status = 'CLEARED', last_error = NULL, last_checked_at = now(), updated_at = now()
      WHERE account_id = $1`,
    [accountId],
  );
}
