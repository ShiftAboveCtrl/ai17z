import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { accountCredentials, accounts as accountsRepo, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

async function signIn(email: string): Promise<{ authorization: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-1234' },
  });
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}

async function xAccount(ownerId: string) {
  return accountsRepo.createAccount({ ownerId, channel: 'x', handle: `creds_${uniqueSuffix()}` });
}

/** Distinctive enough that a substring search for it means something. */
const LOGIN = {
  loginUsername: `owner-${uniqueSuffix()}@example.test`,
  loginPassword: `pw-${uniqueSuffix()}-Zq7!`,
};

/**
 * Optional stored sign-in details.
 *
 * Two properties matter more than the feature does. They are sealed at rest,
 * exactly like a provider API key, so the master key is what stands between a
 * copy of the database and somebody's X account. And nothing that answers an
 * HTTP request can read them back -- the API's whole vocabulary here is
 * "there is something stored" and "there is not".
 */
describe('storing sign-in details for an account', () => {
  it('seals both values at rest and can read back only through the accessor', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}/credentials`,
      headers: auth,
      payload: LOGIN,
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const rows = await query<{ sealed_login_username: string; sealed_login_password: string }>(
      'SELECT sealed_login_username, sealed_login_password FROM account_credentials WHERE account_id = $1',
      [account.id],
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0]!;

    // Neither value is on disk in a form anybody can read, and neither is
    // merely encoded: the sealed shape is v1.<iv>.<tag>.<ciphertext>.
    for (const sealed of [stored.sealed_login_username, stored.sealed_login_password]) {
      expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    }
    expect(stored.sealed_login_username).not.toContain(LOGIN.loginUsername);
    expect(stored.sealed_login_password).not.toContain(LOGIN.loginPassword);
    // Base64 of the plaintext would satisfy the check above and be no secret.
    expect(stored.sealed_login_password).not.toContain(
      Buffer.from(LOGIN.loginPassword, 'utf8').toString('base64url'),
    );

    // And the one path that is allowed to read them gets them back intact.
    expect(await accountCredentials.getDecryptedLogin(account.id)).toEqual(LOGIN);
  });

  it('never returns either value from any route that can see the account', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}/credentials`,
      headers: auth,
      payload: LOGIN,
    });

    const presence = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/credentials`,
      headers: auth,
    });
    const session = await app.inject({ method: 'GET', url: `/api/accounts/${account.id}/session`, headers: auth });
    const list = await app.inject({ method: 'GET', url: '/api/accounts', headers: auth });

    for (const response of [saved, presence, session, list]) {
      expect(response.statusCode).toBe(200);
      // The whole body, not a named field: a leak would arrive through a
      // column somebody added to a SELECT, not through a field anybody meant.
      expect(response.body).not.toContain(LOGIN.loginPassword);
      expect(response.body).not.toContain(LOGIN.loginUsername);
      expect(response.body).not.toContain('sealed_login');
      expect(response.body).not.toContain('sealedLogin');
    }

    // What it does say is that there is something there, and when.
    const { data } = presence.json() as { data: { hasCredentials: boolean; updatedAt: string | null; supported: boolean } };
    expect(data.hasCredentials).toBe(true);
    expect(data.supported).toBe(true);
    expect(data.updatedAt).toBeTruthy();
  });

  it('says there is nothing stored before anything is', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    const presence = await app.inject({
      method: 'GET',
      url: `/api/accounts/${account.id}/credentials`,
      headers: auth,
    });
    const { data } = presence.json() as { data: { hasCredentials: boolean; updatedAt: string | null } };
    expect(data.hasCredentials).toBe(false);
    expect(data.updatedAt).toBeNull();
    expect(await accountCredentials.getDecryptedLogin(account.id)).toBeNull();
  });

  it('replaces both values together rather than leaving a mismatched pair', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/credentials`, headers: auth, payload: LOGIN });
    const second = { loginUsername: 'someone-else@example.test', loginPassword: 'a-different-one' };
    await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/credentials`, headers: auth, payload: second });

    expect(await accountCredentials.getDecryptedLogin(account.id)).toEqual(second);
    // Still one row. A replace that inserted would leave the old password
    // behind in a table nobody looks at.
    const rows = await query('SELECT 1 FROM account_credentials WHERE account_id = $1', [account.id]);
    expect(rows).toHaveLength(1);
  });
});

describe('forgetting sign-in details', () => {
  it('deletes them rather than blanking them', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/credentials`, headers: auth, payload: LOGIN });

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${account.id}/credentials`,
      headers: auth,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as { data: { cleared: boolean } }).data.cleared).toBe(true);

    // Gone from the table, not nulled in it.
    expect(await query('SELECT 1 FROM account_credentials WHERE account_id = $1', [account.id])).toHaveLength(0);
    expect(await accountCredentials.getDecryptedLogin(account.id)).toBeNull();
    expect(await accountCredentials.credentialPresence(account.id)).toEqual({
      hasCredentials: false,
      updatedAt: null,
    });
  });

  it('reports honestly when there was nothing to forget', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${account.id}/credentials`,
      headers: auth,
    });
    expect((cleared.json() as { data: { cleared: boolean } }).data.cleared).toBe(false);
  });

  it('forgets them when the account itself is deleted', async () => {
    // A property of the schema rather than of somebody remembering to write it:
    // account_credentials cascades from accounts.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}/credentials`, headers: auth, payload: LOGIN });
    expect(await query('SELECT 1 FROM account_credentials WHERE account_id = $1', [account.id])).toHaveLength(1);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}`, headers: auth });
    expect(deleted.statusCode, deleted.body).toBe(200);

    expect(await query('SELECT 1 FROM account_credentials WHERE account_id = $1', [account.id])).toHaveLength(0);
  });
});

describe('asking to sign in with details that are not there', () => {
  it('refuses with something a person can act on rather than queueing a failure', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const account = await xAccount(fixture.ownerId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/session/tasks`,
      headers: auth,
      payload: { kind: 'CREDENTIAL_SIGN_IN' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/no sign-in details are stored/i);
    // The refusal names the way out that does not need any of this.
    expect(response.body).toMatch(/open sign-in/i);
  });
});
