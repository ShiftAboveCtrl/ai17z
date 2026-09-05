import { hashPassword, hashToken, newId, randomToken, verifyPassword } from '@xbam/shared';
import { query, queryOne, withTransaction } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: 'OWNER' | 'MEMBER';
  createdAt: string;
  updatedAt: string;
}

interface UserWithHash extends UserRow {
  passwordHash: string;
}

const PUBLIC_COLUMNS = 'id, email, display_name, role, created_at, updated_at';

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ count: number }>('SELECT count(*)::int AS count FROM users');
  return row?.count ?? 0;
}

export async function createOwner(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<UserRow> {
  const row = await queryOne(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, 'OWNER')
     RETURNING ${PUBLIC_COLUMNS}`,
    [input.email, hashPassword(input.password), input.displayName],
  );
  return mapRow<UserRow>(row) as UserRow;
}

export async function findUserByEmail(email: string): Promise<UserWithHash | null> {
  const row = await queryOne(`SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email_lower = lower($1)`, [
    email,
  ]);
  return mapRow<UserWithHash>(row);
}

export async function findUserById(id: string): Promise<UserRow | null> {
  return mapRow<UserRow>(await queryOne(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]));
}

export async function listUsers(): Promise<UserRow[]> {
  return mapRows<UserRow>(await query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at`));
}

export async function authenticate(email: string, password: string): Promise<UserRow | null> {
  const user = await findUserByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  const { passwordHash: _ignored, ...pub } = user;
  return pub;
}

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

/** Sessions are opaque server-side rows so they can be revoked immediately. */
export async function createSession(userId: string, ttlDays = 30, userAgent?: string): Promise<IssuedSession> {
  const token = `${newId()}.${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  await query('INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4)', [
    userId,
    hashToken(token),
    userAgent ?? null,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<UserRow | null> {
  const row = await queryOne(
    `UPDATE sessions SET last_seen_at = now()
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)],
  );
  if (!row) return null;
  return findUserById(row.user_id as string);
}

export async function revokeSession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/**
 * Replaces a password and signs every session out.
 *
 * For host-local recovery only, and the two halves are one operation on
 * purpose. A password change that left old sessions alive would mean somebody
 * who already had a browser tab open kept their access, which is exactly the
 * situation a reset usually exists to end.
 *
 * Deliberately narrow: it touches `users` and `sessions` and nothing else. The
 * master key, sealed provider credentials, browser profiles, agents, memories
 * and knowledge are all untouched, because forgetting a password is not a
 * reason to lose any of them.
 *
 * Returns how many sessions were ended, so the caller can say so.
 */
export async function resetPassword(userId: string, newPassword: string): Promise<{ sessionsEnded: number }> {
  return withTransaction(async (tx) => {
    const updated = await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id', [
      userId,
      hashPassword(newPassword),
    ]);
    if (updated.rows.length === 0) throw new Error('That user no longer exists.');

    const ended = await tx.query('DELETE FROM sessions WHERE user_id = $1 RETURNING id', [userId]);
    return { sessionsEnded: ended.rows.length };
  });
}

export async function purgeExpiredSessions(): Promise<number> {
  const rows = await query('DELETE FROM sessions WHERE expires_at <= now() RETURNING id');
  return rows.length;
}
