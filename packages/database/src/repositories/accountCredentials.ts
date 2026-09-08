import { openSecret, sealSecret } from '@xbam/shared';
import { query, queryOne } from '../pool';

/**
 * Optional stored sign-in details for an account.
 *
 * The same arrangement as `providers`: the sealed columns are never selected
 * into anything that can reach an API response, and the only way to read the
 * plaintext is `getDecryptedLogin`, which the worker calls and whose result
 * never leaves the process.
 *
 * Unlike a provider key there is no fingerprint. A key is high-entropy and a
 * short hash of one is a label; a username is a dictionary word and a hash of
 * one is the username. So the API is told presence and nothing else.
 */

/** Plaintext. Server-side only, and never put into a log line or a task row. */
export interface StoredLogin {
  loginUsername: string;
  loginPassword: string;
}

/** Everything the API is allowed to say about stored details. */
export interface CredentialPresence {
  hasCredentials: boolean;
  /** When they were last written. Null when there are none. */
  updatedAt: string | null;
}

export async function credentialPresence(accountId: string): Promise<CredentialPresence> {
  const row = await queryOne<{ updated_at: Date | string }>(
    'SELECT updated_at FROM account_credentials WHERE account_id = $1',
    [accountId],
  );
  if (!row) return { hasCredentials: false, updatedAt: null };
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return { hasCredentials: true, updatedAt };
}

/**
 * Writes or replaces the stored details.
 *
 * Both values are replaced together. A partial update would let somebody change
 * a username and leave a password that no longer goes with it, which fails at
 * the sign-in form with no way to tell why.
 */
export async function setCredentials(input: {
  accountId: string;
  loginUsername: string;
  loginPassword: string;
}): Promise<CredentialPresence> {
  await query(
    `INSERT INTO account_credentials (account_id, sealed_login_username, sealed_login_password)
     VALUES ($1,$2,$3)
     ON CONFLICT (account_id) DO UPDATE
       SET sealed_login_username = excluded.sealed_login_username,
           sealed_login_password = excluded.sealed_login_password,
           updated_at = now()`,
    [input.accountId, sealSecret(input.loginUsername), sealSecret(input.loginPassword)],
  );
  return credentialPresence(input.accountId);
}

/**
 * Forgets them.
 *
 * A DELETE rather than a null, so that "cleared" is the absence of a row and
 * not a column somebody has to interpret. Returns whether there was anything
 * there, because "cleared" and "there was nothing to clear" are different
 * things to tell a person.
 */
export async function clearCredentials(accountId: string): Promise<boolean> {
  const rows = await query('DELETE FROM account_credentials WHERE account_id = $1 RETURNING account_id', [accountId]);
  return rows.length > 0;
}

/**
 * Server-side only. The plaintext must never be put in an API response, a log
 * line, an audit row, a trace, or a browser task's parameters or result.
 */
export async function getDecryptedLogin(accountId: string): Promise<StoredLogin | null> {
  const row = await queryOne<{ sealed_login_username: string; sealed_login_password: string }>(
    'SELECT sealed_login_username, sealed_login_password FROM account_credentials WHERE account_id = $1',
    [accountId],
  );
  if (!row) return null;
  return {
    loginUsername: openSecret(row.sealed_login_username),
    loginPassword: openSecret(row.sealed_login_password),
  };
}
