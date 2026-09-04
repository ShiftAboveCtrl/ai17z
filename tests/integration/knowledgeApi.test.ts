import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { knowledge as knowledgeRepo } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

// A knowledge source is confined to the folders this installation may read, and
// these fixtures live in the system temp directory. Permitting it here is the
// test saying where its documents are, not the guard being switched off: the
// case where a folder is refused has its own test.
process.env.AI17Z_KNOWLEDGE_ROOTS = tmpdir();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

/** Signs in and returns the authorization header these routes expect. */
async function signIn(email: string): Promise<{ authorization: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'test-password-1234' },
  });
  expect(response.statusCode, response.body).toBe(200);
  // Responses are enveloped as { ok, data }.
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}

async function docsFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai17z-api-source-'));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'guide.md'),
    '# Guide\n\n## Installing\n\nNode 22 or newer, Docker Desktop, and Google Chrome. That is the whole list.',
  );
  return root;
}

/**
 * Attaching a source is the moment an owner hands the agent a folder to read,
 * which is a filesystem read this API performs on their behalf. So the two
 * things worth proving here are that it works and that it belongs to them.
 */
describe('the knowledge API', () => {
  it('attaches a source, reads it immediately, and reports what it found', async () => {
    // A source that exists but has never been read is a row that looks like
    // knowledge and answers nothing, so creation indexes.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const root = await docsFolder();

    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/knowledge`,
      headers: auth,
      payload: { name: 'Product documentation', kind: 'PATH', location: root },
    });

    expect(created.statusCode, created.body).toBe(200);
    const { data: body } = created.json() as {
      data: { source: { chunkCount: number; revision: string | null }; report: { chunks: number; error: string | null } };
    };
    expect(body.report.error).toBeNull();
    expect(body.report.chunks).toBeGreaterThan(0);
    expect(body.source.chunkCount).toBe(body.report.chunks);
    expect(body.source.revision).toBeTruthy();

    await rm(root, { recursive: true, force: true });
  });

  it('says which folders this installation can read, before somebody types one it cannot', async () => {
    // A containerised API and a folder on somebody's desktop is a common and
    // otherwise baffling combination.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const listed = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/knowledge`,
      headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { data: { roots: string[] } }).data.roots.length).toBeGreaterThan(0);
  });

  it('refuses to teach an agent belonging to somebody else', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    const auth = await signIn(mine.ownerEmail);

    const attempt = await app.inject({
      method: 'POST',
      url: `/api/agents/${theirs.agentId}/knowledge`,
      headers: auth,
      payload: { name: 'Not mine', kind: 'TEXT', location: 'Some facts about somebody else.' },
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('refuses an anonymous request outright', async () => {
    const fixture = await createFixture();
    const attempt = await app.inject({
      method: 'GET',
      url: `/api/agents/${fixture.agentId}/knowledge`,
    });
    expect(attempt.statusCode).toBe(401);
  });

  it('refuses a second source with the same name, rather than making two', () => {
    // Two sources called "Product documentation" makes an attribution useless.
    return (async () => {
      const fixture = await createFixture();
      const auth = await signIn(fixture.ownerEmail);
      const payload = { name: 'Docs', kind: 'TEXT', location: 'Something worth knowing about it.' };

      const first = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/knowledge`, headers: auth, payload });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/knowledge`, headers: auth, payload });
      expect(second.statusCode).toBe(409);
    })();
  });

  it('re-reads when the folder it points at changes', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const first = await docsFolder();
    const second = await mkdtemp(join(tmpdir(), 'ai17z-api-source2-'));
    await writeFile(join(second, 'other.md'), '# Other\n\nA completely different set of facts lives over here now.');

    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/knowledge`,
      headers: auth,
      payload: { name: 'Docs', kind: 'PATH', location: first },
    });
    const sourceId = (created.json() as { data: { source: { id: string } } }).data.source.id;

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/knowledge/${sourceId}`,
      headers: auth,
      payload: { location: second },
    });
    expect(moved.statusCode).toBe(200);
    // A changed folder is a different source; yesterday's chunks must not stay
    // answering for today's configuration.
    expect((moved.json() as { data: { report: { chunks: number } | null } }).data.report).not.toBeNull();

    const chunks = await app.inject({ method: 'GET', url: `/api/knowledge/${sourceId}/chunks`, headers: auth });
    const listed = (chunks.json() as { data: { chunks: { content: string }[] } }).data.chunks;
    expect(listed.some((c) => c.content.includes('completely different'))).toBe(true);
    expect(listed.some((c) => c.content.includes('Docker Desktop'))).toBe(false);

    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  it('deleting a source takes what it taught with it', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${fixture.agentId}/knowledge`,
      headers: auth,
      payload: { name: 'Docs', kind: 'TEXT', location: '# Facts\n\nA fact that should disappear with its source.' },
    });
    const sourceId = (created.json() as { data: { source: { id: string } } }).data.source.id;
    expect(await knowledgeRepo.countChunks(sourceId)).toBeGreaterThan(0);

    const removed = await app.inject({ method: 'DELETE', url: `/api/knowledge/${sourceId}`, headers: auth });
    expect(removed.statusCode).toBe(200);
    expect(await knowledgeRepo.getSource(sourceId)).toBeNull();
  });
});
