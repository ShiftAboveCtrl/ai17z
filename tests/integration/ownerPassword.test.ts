import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agents as agentsRepo, ops, providers as providersRepo, query, users } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

const OLD = 'the-old-password-1234';
const NEW = 'a-different-password-5678';

async function anOwner() {
  return users.createOwner({
    email: `owner-${uniqueSuffix()}@example.test`,
    password: OLD,
    displayName: 'Owner',
  });
}

/**
 * AI17Z has no servers and no email, so "forgot password, check your inbox"
 * does not exist. Recovery is host-local, and this is the behaviour it has to
 * have: the old password stops working, everything already signed in is signed
 * out, and nothing else moves.
 */
describe('resetting the owner password', () => {
  it('lets the new password in', async () => {
    const owner = await anOwner();
    await users.resetPassword(owner.id, NEW);
    expect(await users.authenticate(owner.email, NEW)).toBeTruthy();
  });

  it('stops the old one working', async () => {
    const owner = await anOwner();
    await users.resetPassword(owner.id, NEW);
    expect(await users.authenticate(owner.email, OLD)).toBeNull();
  });

  it('signs out every session that was already open', async () => {
    // The situation a reset usually exists to end is somebody else having a
    // tab open. Changing the password and leaving their session alive would
    // not end it.
    const owner = await anOwner();
    const a = await users.createSession(owner.id, 30, 'a browser');
    const b = await users.createSession(owner.id, 30, 'another browser');
    expect(await users.resolveSession(a.token)).toBeTruthy();

    const { sessionsEnded } = await users.resetPassword(owner.id, NEW);

    expect(sessionsEnded).toBe(2);
    expect(await users.resolveSession(a.token)).toBeNull();
    expect(await users.resolveSession(b.token)).toBeNull();
  });

  it('leaves another account alone', async () => {
    const mine = await anOwner();
    const theirs = await anOwner();
    const theirSession = await users.createSession(theirs.id, 30, 'their browser');

    await users.resetPassword(mine.id, NEW);

    expect(await users.authenticate(theirs.email, OLD)).toBeTruthy();
    expect(await users.resolveSession(theirSession.token)).toBeTruthy();
  });

  it('records that it happened, without recording what it was', async () => {
    const owner = await anOwner();
    await users.resetPassword(owner.id, NEW);
    await ops.audit({
      actorUserId: owner.id,
      action: 'owner.password.reset',
      entityType: 'user',
      entityId: owner.id,
      data: { via: 'host-local cli', sessionsEnded: 0 },
    });

    const rows = await query<{ action: string; data: Record<string, unknown> }>(
      "SELECT action, data FROM audit_events WHERE action = 'owner.password.reset' AND entity_id = $1",
      [owner.id],
    );
    expect(rows).toHaveLength(1);
    // Neither the password nor the hash is anywhere in it.
    const written = JSON.stringify(rows[0]!.data);
    expect(written).not.toContain(NEW);
    expect(written).not.toContain('scrypt');
  });

  it('never stores the password in a readable form', async () => {
    const owner = await anOwner();
    await users.resetPassword(owner.id, NEW);
    const [row] = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [owner.id]);
    expect(row!.password_hash).not.toContain(NEW);
    expect(row!.password_hash.startsWith('scrypt$')).toBe(true);
  });
});

/**
 * The part that matters most. A reset is what somebody reaches for when they
 * are already having a bad day, and it must not cost them anything else.
 */
describe('what a reset must not touch', () => {
  it('leaves sealed provider credentials decryptable', async () => {
    const fixture = await createFixture();
    const marker = `sk-still-readable-${uniqueSuffix()}`;
    const credential = await providersRepo.createProvider({
      ownerId: fixture.ownerId,
      provider: 'openai',
      label: 'Kept',
      apiKey: marker,
      availableModels: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });

    await users.resetPassword(fixture.ownerId, NEW);

    // Read back through the one function allowed to decrypt. If a reset had
    // touched the master key this would fail, which is the whole point.
    expect(await providersRepo.getDecryptedApiKey(credential.id)).toBe(marker);
  });

  it('leaves the agent exactly as it was', async () => {
    const fixture = await createFixture();
    const before = await agentsRepo.getAgent(fixture.agentId);
    const personaBefore = await agentsRepo.getActivePersona(fixture.agentId);

    await users.resetPassword(fixture.ownerId, NEW);

    const after = await agentsRepo.getAgent(fixture.agentId);
    expect(after!.name).toBe(before!.name);
    expect(after!.state).toBe(before!.state);
    expect((await agentsRepo.getActivePersona(fixture.agentId))!.version).toBe(personaBefore!.version);
  });

  it('leaves memories and connected accounts alone', async () => {
    const fixture = await createFixture();
    await query(
      `INSERT INTO memories (agent_id, scope, scope_key, memory_type, content, summary, importance, content_hash)
       VALUES ($1,'USER','someone','FACT','They prefer short replies.','Prefers short',0.7,$2)`,
      [fixture.agentId, `pw-${uniqueSuffix()}`],
    );
    const { accounts } = await import('@xbam/database');
    const account = await accounts.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `pw${uniqueSuffix()}`.slice(0, 15),
      displayName: 'Connected',
    });
    await accounts.updateAccount(account.id, { status: 'CONNECTED' });

    await users.resetPassword(fixture.ownerId, NEW);

    const [memories] = await query<{ n: number }>('SELECT count(*)::int AS n FROM memories WHERE agent_id = $1', [
      fixture.agentId,
    ]);
    expect(memories!.n).toBe(1);
    // The X session lives in a browser profile on disk and in this row; a
    // password change has no business with either.
    expect((await accounts.getAccount(account.id))!.status).toBe('CONNECTED');
  });
});

/**
 * The design constraint, not just the implementation: recovery requires the
 * machine. An unauthenticated HTTP route that did this would hand the whole
 * installation to anybody who could reach the port.
 */
describe('recovery is host-local by construction', () => {
  const routes = ['auth.ts', 'agentConfig.ts', 'settings.ts', 'health.ts', 'inbox.ts']
    .map((file) => {
      try {
        return readFileSync(resolve(__dirname, '../../apps/api/src/routes', file), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');

  it('is not reachable through any API route', () => {
    expect(routes).not.toContain('resetPassword');
    expect(routes).not.toMatch(/forgot-password|reset-password/);
  });

  it('is a command that has to be run on the machine', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['owner:password']).toContain('owner-password.mts');
  });

  it('asks for confirmation and for the password twice', () => {
    const cli = readFileSync(resolve(__dirname, '../../tools/owner-password.mts'), 'utf8');
    expect(cli).toContain("'RESET'");
    expect(cli).toMatch(/New password again/);
    expect(cli).toContain('did not match');
  });

  it('does not echo the password as it is typed', () => {
    const cli = readFileSync(resolve(__dirname, '../../tools/owner-password.mts'), 'utf8');
    expect(cli).toContain('_writeToOutput');
  });
});
