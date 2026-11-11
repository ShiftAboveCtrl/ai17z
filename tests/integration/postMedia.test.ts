import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { accounts, actions, agents, devUpdates, jobs, observability, ops, query, withTransaction } from '@xbam/database';
import { mockAdapter } from '@xbam/channels';
import { MEDIA_LIMITS, PipelineError } from '@xbam/shared';
import { reconcileDevUpdates, runDevUpdates, sweepUnattachedMedia } from '@xbam/runtime';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';
import { drainAgentJobs, makeDue } from '../support/runner';
import { fixtureBytes } from '../support/imageFixtures';
import { SVG_BYTES, mp4Bytes } from '../support/mediaFixtures';

installHarness();

/**
 * A post that carries a picture or a video, from the sender's upload to the
 * mock channel's read-back.
 *
 * No test here reaches X. Every account is `mock`, which runs the same
 * executor and stops at the adapter; the mock reads each file it is handed and
 * compares it with the approved hash, which is what an uploader would be
 * given. What the real composer does with the file is `composerAttachMedia`'s
 * fake page, and the part nothing here can reach.
 */

let app: FastifyInstance;
let storage: string;
let previousStorage: string | undefined;

beforeAll(async () => {
  previousStorage = process.env.AI17Z_STORAGE_DIR;
  storage = await mkdtemp(join(tmpdir(), 'ai17z-post-media-'));
  process.env.AI17Z_STORAGE_DIR = storage;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  if (previousStorage === undefined) delete process.env.AI17Z_STORAGE_DIR;
  else process.env.AI17Z_STORAGE_DIR = previousStorage;
  await rm(storage, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Json = Record<string, any>;

interface Ctx {
  ownerId: string;
  agentId: string;
  accountId: string;
  owner: { authorization: string };
}

async function setup(): Promise<Ctx> {
  const fixture = await createFixture();
  await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  const account = await accounts.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: `media_${uniqueSuffix()}` });
  await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, actionType: 'POST' });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: fixture.ownerEmail, password: 'test-password-1234' } });
  return {
    ownerId: fixture.ownerId,
    agentId: fixture.agentId,
    accountId: account.id,
    owner: { authorization: `Bearer ${(login.json() as Json).data.token}` },
  };
}

async function createProject(ctx: Ctx, body: Json = {}): Promise<{ project: Json; token: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/dev-updates/projects',
    headers: ctx.owner,
    payload: { projectKey: 'ai17z', displayName: 'AI17Z', agentId: ctx.agentId, accountId: ctx.accountId, ...body },
  });
  expect(r.statusCode, r.body).toBe(201);
  const data = (r.json() as Json).data;
  return { project: data.project, token: data.senderToken };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function upload(token: string, bytes: Buffer, contentType = 'application/octet-stream') {
  return app.inject({
    method: 'POST',
    url: '/api/dev-updates/sender/media',
    headers: { ...bearer(token), 'content-type': contentType },
    payload: bytes,
  });
}

async function uploadOk(token: string, bytes: Buffer): Promise<Json> {
  const r = await upload(token, bytes);
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as Json).data;
}

let counter = 0;
function facts(overrides: Json = {}): Json {
  counter += 1;
  return {
    projectKey: 'ai17z',
    kind: 'FEATURE',
    title: `The review screen shows the attachment next to the post number ${counter}`,
    summary: `Drafts that carry a screenshot now show it beside the words, so approving one means looking at both, case ${counter}.`,
    why: 'Nobody approves a picture they have not seen.',
    evidence: [{ type: 'COMMIT', ref: `def${String(counter).padStart(4, '0')}`, detail: 'Draft review shows attachments' }],
    disclosure: 'PUBLIC',
    ...overrides,
  };
}

async function submit(token: string, body: Json) {
  return app.inject({ method: 'POST', url: '/api/dev-updates/sender/updates', headers: bearer(token), payload: body });
}

async function ownerUpdate(ctx: Ctx, id: string): Promise<Json> {
  const r = await app.inject({ method: 'GET', url: `/api/dev-updates/updates/${id}`, headers: ctx.owner });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as Json).data;
}

async function approve(ctx: Ctx, id: string) {
  const r = await app.inject({ method: 'POST', url: `/api/dev-updates/updates/${id}/approve`, headers: ctx.owner, payload: {} });
  expect(r.statusCode, r.body).toBe(200);
}

async function settle(ctx: Ctx): Promise<void> {
  await drainAgentJobs(ctx.agentId);
  await reconcileDevUpdates(20);
}

/** An update with these files, submitted, approved and handed to the agent. */
async function approvedWith(ctx: Ctx, token: string, files: Buffer[]): Promise<{ id: string; mediaIds: string[] }> {
  const mediaIds: string[] = [];
  for (const bytes of files) mediaIds.push((await uploadOk(token, bytes)).id);
  const r = await submit(token, facts({ mediaIds }));
  expect(r.statusCode, r.body).toBe(201);
  const update = (r.json() as Json).data.update;
  await approve(ctx, update.id);
  return { id: update.id, mediaIds };
}

describe('a post with a picture, on the mock channel', () => {
  it('is uploaded, shown to the owner, approved, sent with the file, and confirmed with it on read-back', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const png = fixtureBytes('png');

    const uploaded = await uploadOk(token, png);
    expect(uploaded).toMatchObject({ kind: 'IMAGE', mime: 'image/png', bytes: png.length });

    const r = await submit(token, facts({ mediaIds: [uploaded.id] }));
    expect(r.statusCode, r.body).toBe(201);
    const update = (r.json() as Json).data.update;
    expect(update.status).toBe('PENDING_REVIEW');

    // The owner is shown the file next to the post, from the artifact route.
    const shown = await ownerUpdate(ctx, update.id);
    expect(shown.media).toEqual([{ artifactId: uploaded.id, kind: 'IMAGE', mime: 'image/png', bytes: png.length, url: `/api/artifacts/${uploaded.id}` }]);
    const served = await app.inject({ method: 'GET', url: shown.media[0].url, headers: ctx.owner });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(served.rawPayload, png)).toBe(0);

    // Nothing is sent before the owner decides.
    expect((await runDevUpdates(5)).dispatched.filter((d) => d.dispatched)).toHaveLength(0);

    const real = mockAdapter.executeAction.bind(mockAdapter);
    const seen: Array<{ kind: string; path: string; sha256: string }> = [];
    const spy = vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      for (const item of request.media ?? []) seen.push({ kind: item.kind, path: item.path, sha256: item.sha256 });
      return real(c, request);
    });

    await approve(ctx, update.id);
    expect((await runDevUpdates(5)).dispatched.filter((d) => d.dispatched)).toHaveLength(1);
    await settle(ctx);

    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('PUBLISHED');
    expect(done.url).toMatch(/^mock:\/\/message\//);

    // The adapter was handed the approved file, by a path inside the storage root.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('IMAGE');
    expect(resolve(seen[0]!.path).startsWith(resolve(storage))).toBe(true);
    expect(Buffer.compare(readFileSync(seen[0]!.path), png)).toBe(0);

    // EXECUTED with media read-back.
    const [action] = await actions.listJobActions(done.jobId);
    expect(action).toMatchObject({ status: 'EXECUTED', type: 'POST' });
    expect(action!.verification!.evidence).toMatchObject({ mediaConfirmed: true });
    expect((action!.verification!.evidence as Json).media).toEqual([
      { kind: 'IMAGE', mime: 'image/png', bytes: png.length, sha256: seen[0]!.sha256.slice(0, 12) },
    ]);

    // The trace says what went with the post, and never where it is held.
    const trace = await observability.listTrace(done.jobId);
    const started = trace.find((t) => t.type === 'ACTION_STARTED')!;
    expect((started.data as Json).media).toEqual([{ kind: 'IMAGE', mime: 'image/png', bytes: png.length, sha256: seen[0]!.sha256.slice(0, 12) }]);
    expect(JSON.stringify(trace)).not.toContain(storage.replace(/\\/g, '\\\\'));
    expect(JSON.stringify(trace)).not.toContain('post-media');
  });

  it('carries a video the same way', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const video = mp4Bytes(2048);
    const { id } = await approvedWith(ctx, token, [video]);

    const real = mockAdapter.executeAction.bind(mockAdapter);
    const kinds: string[] = [];
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      for (const item of request.media ?? []) kinds.push(`${item.kind}:${item.mime}`);
      return real(c, request);
    });
    await runDevUpdates(5);
    await settle(ctx);

    const done = await ownerUpdate(ctx, id);
    expect(done.status).toBe('PUBLISHED');
    expect(kinds).toEqual(['VIDEO:video/mp4']);
    const [action] = await actions.listJobActions(done.jobId);
    expect(action!.verification!.evidence).toMatchObject({ mediaConfirmed: true });
  });
});

describe('a post whose media cannot be read back', () => {
  it('is held as ambiguous, not marked posted, and never sent again', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const { id } = await approvedWith(ctx, token, [fixtureBytes('png')]);

    // The post was found on the timeline (it has an address), but without its picture.
    const real = mockAdapter.executeAction.bind(mockAdapter);
    const spy = vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      const result = await real(c, request);
      return { ...result, verification: { ...result.verification, evidence: { ...result.verification.evidence, mediaConfirmed: false } } };
    });

    await runDevUpdates(5);
    await settle(ctx);

    const update = await ownerUpdate(ctx, id);
    const job = await jobs.requireJob(update.jobId);
    expect(job.status).toBe('REVIEW_REQUIRED');
    expect(job.errorClass).toBe('REVIEW_REQUIRED');

    const [action] = await actions.listJobActions(update.jobId);
    expect(action).toMatchObject({ status: 'FAILED', errorClass: 'REVIEW_REQUIRED' });
    expect(action!.verification).toMatchObject({ postOutcome: 'AMBIGUOUS' });
    const [signed] = await query<{ content_signature: string | null }>(`SELECT content_signature FROM actions WHERE id = $1`, [action!.id]);
    expect(signed!.content_signature).toBeNull();

    await drainAgentJobs(ctx.agentId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(update.status).not.toBe('PUBLISHED');
  });

  it('is held when the adapter says nothing about the media at all', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const { id } = await approvedWith(ctx, token, [fixtureBytes('jpeg')]);

    // An adapter that forgot to look cannot pass for one that looked.
    const real = mockAdapter.executeAction.bind(mockAdapter);
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      const result = await real(c, request);
      const { mediaConfirmed: _gone, ...evidence } = result.verification.evidence as Json;
      return { ...result, verification: { ...result.verification, evidence } };
    });
    await runDevUpdates(5);
    await settle(ctx);

    const update = await ownerUpdate(ctx, id);
    expect((await jobs.requireJob(update.jobId)).status).toBe('REVIEW_REQUIRED');
  });
});

describe('a rehearsal shows the attachment', () => {
  it('names it in the trace, sends nothing, and keeps the file for the real run', async () => {
    const ctx = await setup();
    // A new project rehearses.
    const { token } = await createProject(ctx);
    const png = fixtureBytes('png');
    const { id, mediaIds } = await approvedWith(ctx, token, [png]);
    await runDevUpdates(5);
    await settle(ctx);

    const done = await ownerUpdate(ctx, id);
    expect(done.status).toBe('REHEARSED');
    const sent = await actions.listJobActions(done.jobId);
    expect(sent.every((a) => a.dryRun)).toBe(true);

    const trace = await observability.listTrace(done.jobId);
    const started = trace.find((t) => t.type === 'ACTION_STARTED')!;
    expect(started.message).toMatch(/Dry run: POST/);
    expect((started.data as Json).media).toEqual([expect.objectContaining({ kind: 'IMAGE', mime: 'image/png', bytes: png.length })]);
    const verified = trace.find((t) => t.type === 'TARGET_VERIFIED')!;
    expect((verified.data as Json).media).toEqual([expect.objectContaining({ kind: 'IMAGE', bytes: png.length })]);
    expect(await ops.getArtifact(mediaIds[0]!)).not.toBeNull();
  });
});

describe('what is accepted at the door', () => {
  it('refuses a file by its bytes, whatever it says it is', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);

    for (const [name, bytes, type] of [
      ['an SVG', SVG_BYTES, 'image/png'],
      ['text called a video', Buffer.from('not a movie, whatever the header says'), 'video/mp4'],
      ['a movie with no index', Buffer.concat([mp4Bytes().subarray(0, 24)]), 'video/mp4'],
      ['nothing', Buffer.alloc(0), 'application/octet-stream'],
    ] as const) {
      const r = await upload(token, bytes, type);
      expect(r.statusCode, name).toBe(400);
    }
    expect(await query(`SELECT 1 FROM artifacts WHERE kind = 'POST_MEDIA'`)).toHaveLength(0);
  });

  it('refuses an image over its cap and says which cap', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const r = await upload(token, Buffer.concat([fixtureBytes('png'), Buffer.alloc(MEDIA_LIMITS.IMAGE)]));
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/limit is 5MB/);
  });

  it('takes uploads only from the sender, and only for its own project', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const owner = await app.inject({
      method: 'POST',
      url: '/api/dev-updates/sender/media',
      headers: { ...ctx.owner, 'content-type': 'application/octet-stream' },
      payload: fixtureBytes('png'),
    });
    expect(owner.statusCode).toBe(401);
    const anonymous = await app.inject({ method: 'POST', url: '/api/dev-updates/sender/media', headers: { 'content-type': 'application/octet-stream' }, payload: fixtureBytes('png') });
    expect(anonymous.statusCode).toBe(401);

    // Another project's upload cannot be attached.
    const other = await setup();
    const theirs = await createProject(other, { projectKey: 'other-project', displayName: 'Other' });
    const foreign = await uploadOk(theirs.token, fixtureBytes('png'));
    const r = await submit(token, facts({ mediaIds: [foreign.id] }));
    expect(r.statusCode, r.body).toBe(422);
    expect(r.body).toMatch(/not uploaded for this project/);
  });

  it('lets a file go on one update only, and refuses sets X would not post', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const first = await uploadOk(token, fixtureBytes('png'));
    expect((await submit(token, facts({ mediaIds: [first.id] }))).statusCode).toBe(201);
    const again = await submit(token, facts({ mediaIds: [first.id] }));
    expect(again.statusCode, again.body).toBe(422);

    const five = [];
    for (let i = 0; i < 5; i += 1) five.push((await uploadOk(token, fixtureBytes('jpeg'))).id);
    const tooMany = await submit(token, facts({ mediaIds: five }));
    expect(tooMany.statusCode, tooMany.body).toBe(422);

    const gif = await uploadOk(token, fixtureBytes('gif'));
    const mixed = await submit(token, facts({ mediaIds: [(await uploadOk(token, fixtureBytes('webp'))).id, gif.id] }));
    expect(mixed.statusCode, mixed.body).toBe(422);
    expect(mixed.body).toMatch(/cannot be mixed/);
  });

  it('refuses uploads for a channel that cannot carry them', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const adapter = mockAdapter as { supportsMedia?: boolean };
    adapter.supportsMedia = false;
    try {
      const r = await upload(token, fixtureBytes('png'));
      expect(r.statusCode, r.body).toBe(422);
      expect(r.body).toMatch(/cannot attach pictures or video/);
    } finally {
      adapter.supportsMedia = true;
    }
  });
});

describe('a file that is not what was approved', () => {
  it('stops the send when it changed on disk after approval, with nothing sent', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const { id, mediaIds } = await approvedWith(ctx, token, [fixtureBytes('png')]);

    const artifact = (await ops.getArtifact(mediaIds[0]!))!;
    writeFileSync(join(storage, artifact.relPath), fixtureBytes('jpeg'));

    const spy = vi.spyOn(mockAdapter, 'executeAction');
    await runDevUpdates(5);
    await settle(ctx);

    const update = await ownerUpdate(ctx, id);
    const job = await jobs.requireJob(update.jobId);
    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.lastError).toMatch(/not the one that was approved/);
    expect(spy).not.toHaveBeenCalled();
    expect(await actions.listJobActions(update.jobId)).toHaveLength(0);
  });

  it('stops the send when the channel cannot carry the file, with nothing sent', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const { id } = await approvedWith(ctx, token, [fixtureBytes('png')]);

    const adapter = mockAdapter as { supportsMedia?: boolean };
    adapter.supportsMedia = false;
    const spy = vi.spyOn(mockAdapter, 'executeAction');
    try {
      await runDevUpdates(5);
      await settle(ctx);
    } finally {
      adapter.supportsMedia = true;
    }
    const update = await ownerUpdate(ctx, id);
    const job = await jobs.requireJob(update.jobId);
    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.lastError).toMatch(/cannot attach files to a post/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('housekeeping', () => {
  it('removes the file with the words when the owner rejects the update', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const { id, mediaIds } = await approvedWith(ctx, token, [fixtureBytes('png')]);
    // Approved but not yet handed over: still rejectable.
    const artifact = (await ops.getArtifact(mediaIds[0]!))!;
    const onDisk = join(storage, artifact.relPath);
    expect(existsSync(onDisk)).toBe(true);

    const r = await app.inject({ method: 'POST', url: `/api/dev-updates/updates/${id}/reject`, headers: ctx.owner, payload: { note: 'not announced' } });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as Json).data.media).toEqual([]);
    expect(await ops.getArtifact(mediaIds[0]!)).toBeNull();
    expect(existsSync(onDisk)).toBe(false);
  });

  it('removes an upload nobody attached after a day, and keeps a fresh one', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const old = await uploadOk(token, fixtureBytes('png'));
    const fresh = await uploadOk(token, fixtureBytes('jpeg'));
    await query(`UPDATE artifacts SET created_at = now() - interval '25 hours' WHERE id = $1`, [old.id]);

    await runDevUpdates(5);
    expect(await ops.getArtifact(old.id)).toBeNull();
    expect(await ops.getArtifact(fresh.id)).not.toBeNull();
  });

  it('stops piling up uploads that nothing uses', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    for (let i = 0; i < 8; i += 1) await uploadOk(token, fixtureBytes('png'));
    const r = await upload(token, fixtureBytes('png'));
    expect(r.statusCode, r.body).toBe(409);
  });
});

describe('cleanup racing a submission', () => {
  it('leaves an upload alone when an update takes it after the sweep chose it', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const up = await uploadOk(token, fixtureBytes('png'));
    await query(`UPDATE artifacts SET created_at = now() - interval '25 hours' WHERE id = $1`, [up.id]);
    const onDisk = join(storage, (await ops.getArtifact(up.id))!.relPath);

    // A submission that has locked the file to attach it and has not committed.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const submission = withTransaction(async (tx) => {
      await tx.query(`SELECT id FROM artifacts WHERE id = $1 FOR UPDATE`, [up.id]);
      held();
      await gate;
      await devUpdates.markMediaAttached(tx, [up.id], randomUUID());
    });
    await holding;

    // The sweep reads the id as stale, then its delete waits on that lock.
    const sweep = sweepUnattachedMedia();
    for (let i = 0; i < 200; i += 1) {
      const waiting = await query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query ILIKE '%DELETE FROM artifacts%' AND query NOT ILIKE '%pg_stat_activity%'`,
      );
      if (waiting.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await submission;

    expect(await sweep, 'nothing was removed').toBe(0);
    expect(await ops.getArtifact(up.id), 'the row an update now names is still there').not.toBeNull();
    expect(existsSync(onDisk), 'and so is its file').toBe(true);
  });

  it('still removes an upload that stayed unattached', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const up = await uploadOk(token, fixtureBytes('png'));
    await query(`UPDATE artifacts SET created_at = now() - interval '25 hours' WHERE id = $1`, [up.id]);
    const onDisk = join(storage, (await ops.getArtifact(up.id))!.relPath);
    expect(await sweepUnattachedMedia()).toBe(1);
    expect(await ops.getArtifact(up.id)).toBeNull();
    expect(existsSync(onDisk)).toBe(false);
  });
});

describe('recovering a post that carries files', () => {
  /** An update whose first send failed locally, so the retry asks the remote whether it arrived. */
  async function interruptedSend(wasAlreadyDone: () => Promise<unknown>) {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const { id } = await approvedWith(ctx, token, [fixtureBytes('png')]);
    const real = mockAdapter.executeAction.bind(mockAdapter);
    let calls = 0;
    const spy = vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      calls += 1;
      if (calls === 1) throw PipelineError.retryable('timeout', 'The composer did not close in time.');
      return real(c, request);
    });
    (mockAdapter as { wasAlreadyDone?: unknown }).wasAlreadyDone = wasAlreadyDone;
    await runDevUpdates(5);
    const { jobId } = await ownerUpdate(ctx, id);
    await drainAgentJobs(ctx.agentId);
    await makeDue(jobId);
    await settle(ctx);
    return { ctx, id, jobId, spy };
  }

  const found = { done: true, remoteActionId: 'mock-found', remoteActionUrl: 'mock://message/mock-found', detail: 'Found the text.' };

  it('holds, and never resends, when the remote found the text but not that the files came with it', async () => {
    try {
      const { ctx, id, jobId, spy } = await interruptedSend(async () => found);
      expect(spy, 'only the first, interrupted attempt sent').toHaveBeenCalledTimes(1);
      const job = await jobs.requireJob(jobId);
      expect(job.status).toBe('PERMANENT_FAILURE');
      expect(job.lastError).toMatch(/may or may not have reached the account/);
      expect((await actions.listJobActions(jobId))[0]!.status).not.toBe('EXECUTED');
      expect((await ownerUpdate(ctx, id)).status).not.toBe('PUBLISHED');
    } finally {
      delete (mockAdapter as { wasAlreadyDone?: unknown }).wasAlreadyDone;
    }
  });

  it('holds when the remote says the files were not seen', async () => {
    try {
      const { ctx, id, jobId, spy } = await interruptedSend(async () => ({ ...found, mediaConfirmed: false }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await actions.listJobActions(jobId))[0]!.status).not.toBe('EXECUTED');
      expect((await ownerUpdate(ctx, id)).status).not.toBe('PUBLISHED');
    } finally {
      delete (mockAdapter as { wasAlreadyDone?: unknown }).wasAlreadyDone;
    }
  });

  it('records it as published when the remote confirms the text and the files', async () => {
    try {
      const { ctx, id, jobId, spy } = await interruptedSend(async () => ({ ...found, mediaConfirmed: true }));
      expect(spy, 'recovered, not resent').toHaveBeenCalledTimes(1);
      expect((await actions.listJobActions(jobId))[0]).toMatchObject({ status: 'EXECUTED', remoteActionId: 'mock-found' });
      expect((await ownerUpdate(ctx, id)).status).toBe('PUBLISHED');
    } finally {
      delete (mockAdapter as { wasAlreadyDone?: unknown }).wasAlreadyDone;
    }
  });
});

describe('what a storage failure says', () => {
  it('names no local path when an approved file cannot be read at send time', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const { id, mediaIds } = await approvedWith(ctx, token, [fixtureBytes('png')]);
    const artifact = (await ops.getArtifact(mediaIds[0]!))!;
    // A directory where the file should be: a path that exists and cannot be read as a file.
    rmSync(join(storage, artifact.relPath));
    mkdirSync(join(storage, artifact.relPath));

    const spy = vi.spyOn(mockAdapter, 'executeAction');
    await runDevUpdates(5);
    await settle(ctx);

    const update = await ownerUpdate(ctx, id);
    const job = await jobs.requireJob(update.jobId);
    expect(job.status).toBe('PERMANENT_FAILURE');
    expect(job.lastError).toMatch(/could not be read from storage/);
    expect(job.lastError).not.toContain(storage);
    expect(job.lastError).not.toMatch(/EISDIR|ENOENT/);
    expect(JSON.stringify(await observability.listTrace(update.jobId))).not.toContain(storage);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers a failed upload write with a classed error and no local path', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    // The agent's folder cannot be created because a file sits in its place.
    mkdirSync(join(storage, 'post-media'), { recursive: true });
    const blocker = join(storage, 'post-media', ctx.agentId);
    writeFileSync(blocker, 'in the way');
    try {
      const r = await upload(token, fixtureBytes('png'));
      expect(r.statusCode, r.body).toBe(503);
      const body = r.json() as Json;
      expect(body.error.code).toBe('POST_MEDIA_STORE_FAILED');
      expect(body.error.message).toMatch(/could not be saved/);
      expect(r.body).not.toContain(storage);
      expect(r.body).not.toMatch(/ENOTDIR|EEXIST/);
    } finally {
      rmSync(blocker, { force: true });
    }
    expect(await query(`SELECT 1 FROM artifacts WHERE kind = 'POST_MEDIA' AND agent_id = $1`, [ctx.agentId])).toHaveLength(0);
  });
});

describe('who is heard before a body is read', () => {
  it('refuses an unauthenticated upload before buffering a body over the cap', async () => {
    // Over the route's limit. With authentication after the parser this is a
    // 413-class refusal from the parser, which means the server had begun to
    // take the upload for somebody who never proved who they were.
    const oversize = Buffer.alloc(MEDIA_LIMITS.VIDEO + 4096);
    for (const headers of [
      { 'content-type': 'video/mp4' },
      { 'content-type': 'video/mp4', authorization: 'Bearer not-a-sender-token' },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/dev-updates/sender/media', headers, payload: oversize });
      expect(r.statusCode, r.body).toBe(401);
    }
  });

  it('refuses an unauthenticated update before parsing its body', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/dev-updates/sender/updates',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });
    expect(r.statusCode, r.body).toBe(401);
  });

  it('still takes an authenticated upload and update', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const up = await uploadOk(token, fixtureBytes('png'));
    expect((await submit(token, facts({ mediaIds: [up.id] }))).statusCode).toBe(201);
  });
});
