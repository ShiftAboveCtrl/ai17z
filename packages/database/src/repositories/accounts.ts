import type { Account, AgentAccountLink, BrowserEngine, BrowserSession, ChannelId } from '@xbam/shared/contracts';
import { DEFAULT_TRIGGER_EVENT_TYPES } from '@xbam/shared/contracts';
import { NotFoundError } from '@xbam/shared';
import { query, queryOne, withTransaction } from '../pool';
import { mapRow, mapRows } from '../mapper';

const ACCOUNT_COLUMNS = `
  id, owner_id, channel, remote_account_id, handle, display_name, status, enabled,
  capabilities, settings, last_health_check_at, last_health_status, last_activity_at,
  last_error, auth_started_at, auth_deadline_at, challenge_kind, created_at, updated_at`;

export async function listAccounts(ownerId: string): Promise<Account[]> {
  return mapRows<Account>(
    await query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE owner_id = $1 ORDER BY created_at`, [ownerId]),
  );
}

export async function getAccount(id: string): Promise<Account | null> {
  return mapRow<Account>(await queryOne(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]));
}

/**
 * An account this owner already has on this channel, by handle.
 *
 * Case-insensitive, matching the unique index, so "@Alice" and "@alice" are the
 * same account rather than a constraint violation nobody can read.
 */
export async function findByHandle(ownerId: string, channel: string, handle: string): Promise<Account | null> {
  return mapRow<Account>(
    await queryOne(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts
        WHERE owner_id = $1 AND channel = $2 AND lower(handle) = lower($3)`,
      [ownerId, channel, handle.replace(/^@+/, '')],
    ),
  );
}

export async function requireAccount(id: string): Promise<Account> {
  const account = await getAccount(id);
  if (!account) throw new NotFoundError('Account');
  return account;
}

/**
 * Accounts the sign-in watcher should look at.
 *
 * Deliberately only the states that mean the OPEN_AUTH task has finished and
 * released the browser. STARTING_BROWSER and BROWSER_READY are held by the task
 * itself while it is still launching and navigating; watching those raced the
 * navigation and had the watcher declare a window gone half a second after
 * opening it.
 *
 * A challenge is not in this list either: once a person is being asked for a
 * code, the watcher has nothing left to contribute and must not keep polling
 * the page they are typing into.
 */
export async function accountsAwaitingSignIn(): Promise<Account[]> {
  return mapRows<Account>(
    await query(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts
        WHERE status IN ('AWAITING_LOGIN', 'AUTHENTICATING')
        ORDER BY auth_started_at NULLS LAST`,
    ),
  );
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
    /** Sign-in progress. Null clears a wait that is over, however it ended. */
    authStartedAt: string | null;
    authDeadlineAt: string | null;
    challengeKind: string | null;
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
  if (patch.authStartedAt !== undefined) push('auth_started_at = $?', patch.authStartedAt);
  if (patch.authDeadlineAt !== undefined) push('auth_deadline_at = $?', patch.authDeadlineAt);
  if (patch.challengeKind !== undefined) push('challenge_kind = $?', patch.challengeKind);
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

/**
 * Links an agent to an account.
 *
 * The default capabilities are granted here rather than by the caller, because a
 * link with no grants is an agent that silently does nothing, and a caller that
 * forgets is indistinguishable from one that meant to revoke everything. An
 * existing link keeps whatever capabilities it already has: editing which events
 * trigger an agent must not quietly widen or reset what it may do.
 */
export async function linkAgentAccount(input: {
  agentId: string;
  accountId: string;
  triggerEventTypes?: string[];
  actionType?: string;
  enabled?: boolean;
}): Promise<void> {
  const actionType = input.actionType ?? 'REPLY';
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO agent_accounts (agent_id, account_id, trigger_event_types, action_type, enabled)
       VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (agent_id, account_id) DO UPDATE
         SET trigger_event_types = excluded.trigger_event_types,
             action_type = excluded.action_type,
             enabled = excluded.enabled`,
      [
        input.agentId,
        input.accountId,
        JSON.stringify(input.triggerEventTypes ?? [...DEFAULT_TRIGGER_EVENT_TYPES]),
        actionType,
        input.enabled ?? true,
      ],
    );

    const defaults = ['READ', 'GENERATE', ...(actionType === 'NONE' ? [] : [actionType])];
    await tx.query(
      `INSERT INTO agent_account_capabilities (agent_id, account_id, capability)
       SELECT $1, $2, unnest($3::text[])
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_account_capabilities WHERE agent_id = $1 AND account_id = $2
        )
       ON CONFLICT DO NOTHING`,
      [input.agentId, input.accountId, defaults],
    );
  });
}

export async function unlinkAgentAccount(agentId: string, accountId: string): Promise<void> {
  await query('DELETE FROM agent_accounts WHERE agent_id = $1 AND account_id = $2', [agentId, accountId]);
}

export async function getBrowserSession(accountId: string): Promise<BrowserSession | null> {
  return mapRow<BrowserSession>(await queryOne('SELECT * FROM browser_sessions WHERE account_id = $1', [accountId]));
}

export async function upsertBrowserSession(input: {
  accountId: string;
  engine?: BrowserEngine | null;
  mode: 'MANAGED' | 'CDP';
  channel?: 'chrome' | 'msedge' | 'chromium' | null;
  profileDir?: string | null;
  cdpUrl?: string | null;
  status?: string;
  lastError?: string | null;
}): Promise<BrowserSession> {
  const row = await queryOne(
    `INSERT INTO browser_sessions (account_id, engine, mode, channel, profile_dir, cdp_url, status, last_error, last_checked_at)
     VALUES ($1,coalesce($8,'GOOGLE_CHROME'),$2,coalesce($3,'chromium'),$4,$5,coalesce($6,'UNKNOWN'),$7, CASE WHEN $6 IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (account_id) DO UPDATE
       SET engine = coalesce($8, browser_sessions.engine),
           mode = excluded.mode,
           channel = coalesce($3, browser_sessions.channel),
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
      input.channel ?? null,
      input.profileDir ?? null,
      input.cdpUrl ?? null,
      input.status ?? null,
      input.lastError ?? null,
      input.engine ?? null,
    ],
  );
  return mapRow<BrowserSession>(row) as BrowserSession;
}

/**
 * Records what actually launched.
 *
 * Written after the browser is up and has answered over CDP, so the diagnostics
 * show two independent signals: the executable AI17Z chose, and what the
 * running browser says it is. A claim of "real Chrome" that rests on only one
 * of those is a claim somebody has to take on trust.
 */
/**
 * Snapshots what each tab is doing.
 *
 * Overwritten, never appended: this is live process state, and a stale row is
 * worse than none. `tabs_updated_at` is what tells the reader whether to
 * believe it.
 */
export async function recordBrowserTabs(accountId: string, tabs: unknown[]): Promise<void> {
  await query(
    `UPDATE browser_sessions
        SET tabs = $2::jsonb, tabs_updated_at = now(), updated_at = now()
      WHERE account_id = $1`,
    [accountId, JSON.stringify(tabs)],
  );
}

export async function recordBrowserIdentity(input: {
  accountId: string;
  executablePath: string | null;
  browserProduct: string | null;
  browserVersion: string | null;
  browserPid: number | null;
  cdpProduct: string | null;
  cdpUrl: string | null;
}): Promise<void> {
  await query(
    `UPDATE browser_sessions
        SET executable_path = $2, browser_product = $3, browser_version = $4,
            browser_pid = $5, cdp_product = $6,
            cdp_url = coalesce($7, cdp_url),
            verified_at = now(), updated_at = now()
      WHERE account_id = $1`,
    [
      input.accountId,
      input.executablePath,
      input.browserProduct,
      input.browserVersion,
      input.browserPid,
      input.cdpProduct,
      input.cdpUrl,
    ],
  );
}

/** Wipes the stored session pointer. The profile directory is removed separately. */
export async function clearBrowserSession(accountId: string): Promise<void> {
  await query(
    `UPDATE browser_sessions SET status = 'CLEARED', last_error = NULL, last_checked_at = now(), updated_at = now()
      WHERE account_id = $1`,
    [accountId],
  );
}
