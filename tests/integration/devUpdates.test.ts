import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, type PolicyConfig } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import { accountLease, accounts, actions, agents, capabilities, jobs, query } from '@xbam/database';
import { mockAdapter } from '@xbam/channels';
import { approveJob, devUpdateConnection, dispatchDevUpdates, reconcileDevUpdates, runDevUpdates } from '@xbam/runtime';
import { buildServer } from '../../apps/api/src/server';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';
import { drainAgentJobs, makeDue } from '../support/runner';

installHarness();

// Assembled at runtime so no credential-shaped literal sits in a tracked file
// for the release check (or anybody's scanner) to find.
const FAKE_GITHUB_TOKEN = ['gh', 'p_0123456789abcdefghijABCDEFGHIJ012345'].join('');

/**
 * Development updates, through the HTTP API a coding assistant and an owner
 * actually use, down to a post on the mock channel.
 *
 * No test here reaches X. Every account is `mock`, which runs the same
 * executor and stops at the adapter.
 */

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
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

async function signIn(email: string): Promise<{ authorization: string }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${(r.json() as Json).data.token}` };
}

async function setup(options: { policy?: Partial<PolicyConfig>; grantPost?: boolean } = {}): Promise<Ctx> {
  const fixture = await createFixture({ policy: options.policy });
  await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  const account = await accounts.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: `dev_${uniqueSuffix()}` });
  await accounts.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    actionType: options.grantPost === false ? 'REPLY' : 'POST',
  });
  return { ownerId: fixture.ownerId, agentId: fixture.agentId, accountId: account.id, owner: await signIn(fixture.ownerEmail) };
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

let counter = 0;
function facts(overrides: Json = {}): Json {
  counter += 1;
  return {
    projectKey: 'ai17z',
    kind: 'FIX',
    title: `Replies keep their thread after restart number ${counter}`,
    summary: `A worker restart used to drop the conversation a reply belonged to, case ${counter} of the recovery path.`,
    why: 'Long conversations no longer lose their context halfway.',
    evidence: [{ type: 'COMMIT', ref: `abc${String(counter).padStart(4, '0')}`, detail: 'Thread binding survives lease recovery' }],
    disclosure: 'PUBLIC',
    ...overrides,
  };
}

async function submit(token: string, body: Json) {
  return app.inject({ method: 'POST', url: '/api/dev-updates/sender/updates', headers: bearer(token), payload: body });
}

async function submitOk(token: string, body: Json = facts()): Promise<Json> {
  const r = await submit(token, body);
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as Json).data.update;
}

async function ownerUpdate(ctx: Ctx, id: string): Promise<Json> {
  const r = await app.inject({ method: 'GET', url: `/api/dev-updates/updates/${id}`, headers: ctx.owner });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as Json).data;
}

async function approve(ctx: Ctx, id: string, payload: Json = {}) {
  return app.inject({ method: 'POST', url: `/api/dev-updates/updates/${id}/approve`, headers: ctx.owner, payload });
}

async function setProject(ctx: Ctx, id: string, payload: Json) {
  const r = await app.inject({ method: 'PATCH', url: `/api/dev-updates/projects/${id}`, headers: ctx.owner, payload });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as Json).data;
}

/** Pretends this project's hand-overs and real sends both happened `minutes` earlier. */
async function backdateSends(projectId: string, minutes: number): Promise<void> {
  await query(
    `UPDATE dev_updates SET dispatched_at = dispatched_at - make_interval(mins => $2) WHERE project_id = $1 AND dispatched_at IS NOT NULL`,
    [projectId, minutes],
  );
  await query(
    `UPDATE actions SET executed_at = executed_at - make_interval(mins => $2)
      WHERE job_id IN (SELECT job_id FROM dev_updates WHERE project_id = $1 AND job_id IS NOT NULL)`,
    [projectId, minutes],
  );
}

/** Runs the agent's queue and reads back what happened, as the worker does. */
async function settle(ctx: Ctx): Promise<void> {
  await drainAgentJobs(ctx.agentId);
  await reconcileDevUpdates(20);
}

describe('the project mapping', () => {
  it('defaults to draft, two a day, spaced out, and rehearsing', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx);
    expect(project).toMatchObject({ mode: 'DRAFT', dailyCap: 2, minSpacingMinutes: 240, rehearse: true, enabled: true });
    expect(token).toMatch(/^ai17z_dus_/);
    // The token is shown once and never stored or returned again.
    const list = await app.inject({ method: 'GET', url: '/api/dev-updates/projects', headers: ctx.owner });
    expect(list.body).not.toContain(token);
    const [row] = await query<{ sender_token_hash: string }>('SELECT sender_token_hash FROM dev_update_projects WHERE id = $1', [project.id]);
    expect(row!.sender_token_hash).not.toContain(token);
  });

  it('refuses an agent that may not post through the account', async () => {
    const ctx = await setup({ grantPost: false });
    const r = await app.inject({
      method: 'POST',
      url: '/api/dev-updates/projects',
      headers: ctx.owner,
      payload: { projectKey: 'ai17z', displayName: 'AI17Z', agentId: ctx.agentId, accountId: ctx.accountId },
    });
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatch(/not permitted to POST/);
  });

  it("refuses another owner's agent or account", async () => {
    const mine = await setup();
    const theirs = await setup();
    const r = await app.inject({
      method: 'POST',
      url: '/api/dev-updates/projects',
      headers: mine.owner,
      payload: { projectKey: 'ai17z', displayName: 'AI17Z', agentId: mine.agentId, accountId: theirs.accountId },
    });
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatch(/another owner/);
  });
});

describe('two credentials that cannot stand in for each other', () => {
  it('keeps the sender out of every owner route, and the owner session out of sender routes', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx);
    const update = await submitOk(token);

    for (const [method, url] of [
      ['GET', '/api/dev-updates/connection'],
      ['GET', '/api/dev-updates/projects'],
      ['PATCH', `/api/dev-updates/projects/${project.id}`],
      ['POST', `/api/dev-updates/projects/${project.id}/sender-token`],
      ['GET', `/api/dev-updates/updates/${update.id}`],
      ['POST', `/api/dev-updates/updates/${update.id}/approve`],
      ['POST', `/api/dev-updates/updates/${update.id}/reject`],
    ] as const) {
      const r = await app.inject({ method, url, headers: bearer(token), payload: method === 'GET' ? undefined : { mode: 'AUTO' } });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    // There is no sender route that decides anything.
    const sneaky = await app.inject({ method: 'POST', url: `/api/dev-updates/sender/updates/${update.id}/approve`, headers: bearer(token) });
    expect(sneaky.statusCode).toBe(404);

    const ownerAsSender = await app.inject({ method: 'GET', url: '/api/dev-updates/sender/project', headers: ctx.owner });
    expect(ownerAsSender.statusCode).toBe(401);

    expect((await ownerUpdate(ctx, update.id)).status).toBe('PENDING_REVIEW');
    const after = await app.inject({ method: 'GET', url: `/api/dev-updates/projects/${project.id}`, headers: ctx.owner });
    expect((after.json() as Json).data.mode).toBe('DRAFT');
  });

  it('confines a sender token to its own project', async () => {
    const a = await setup();
    const b = await setup();
    const projectA = await createProject(a);
    const projectB = await createProject(b, { projectKey: 'other-project', displayName: 'Other' });
    const updateB = await submitOk(projectB.token, facts({ projectKey: 'other-project' }));

    const wrongKey = await submit(projectA.token, facts({ projectKey: 'other-project' }));
    expect(wrongKey.statusCode).toBe(403);
    const peek = await app.inject({ method: 'GET', url: `/api/dev-updates/sender/updates/${updateB.id}`, headers: bearer(projectA.token) });
    expect(peek.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/dev-updates/sender/updates', headers: bearer(projectA.token) });
    expect((list.json() as Json).data.items).toHaveLength(0);

    // Nor can one owner see or decide on another's.
    const ownerPeek = await app.inject({ method: 'GET', url: `/api/dev-updates/updates/${updateB.id}`, headers: a.owner });
    expect(ownerPeek.statusCode).toBe(403);
    expect((await approve(a, updateB.id)).statusCode).toBe(403);
  });

  it('tells the owner where this installation keeps its MCP server, and nobody else', async () => {
    const ctx = await setup();
    const anonymous = await app.inject({ method: 'GET', url: '/api/dev-updates/connection' });
    expect(anonymous.statusCode).toBe(401);

    const r = await app.inject({ method: 'GET', url: '/api/dev-updates/connection', headers: ctx.owner });
    expect(r.statusCode, r.body).toBe(200);
    const data = (r.json() as Json).data;
    expect(data.serverName).toBe('ai17z-dev-updates');
    // On a checkout or a native install the file is there and the path is
    // absolute, so the pasted command works from any directory.
    expect(data.reason).toBeNull();
    expect(data.mcpServerPath).toMatch(/[\\/]tools[\\/]dev-updates-mcp\.mjs$/);
    expect(existsSync(data.mcpServerPath)).toBe(true);
    expect(isAbsolute(data.mcpServerPath)).toBe(true);
  });

  it('offers no path from inside a container, because it would mean nothing on the owner machine', () => {
    const inside = devUpdateConnection({ inContainer: () => true, exists: () => true });
    expect(inside.mcpServerPath).toBeNull();
    expect(inside.reason).toMatch(/container/);
    expect(inside.serverName).toBe('ai17z-dev-updates');
  });

  it('offers no path when the MCP server file is missing, and says how to get it back', () => {
    const missing = devUpdateConnection({ inContainer: () => false, exists: () => false });
    expect(missing.mcpServerPath).toBeNull();
    expect(missing.reason).toMatch(/missing/);
    expect(missing.reason).toMatch(/dev-updates-mcp\.mjs/);
  });

  it('stops honouring a token once it is rotated or revoked', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx);
    const rotated = await app.inject({ method: 'POST', url: `/api/dev-updates/projects/${project.id}/sender-token`, headers: ctx.owner });
    const fresh = (rotated.json() as Json).data.senderToken as string;
    expect((await submit(token, facts())).statusCode).toBe(401);
    await submitOk(fresh);

    await app.inject({ method: 'DELETE', url: `/api/dev-updates/projects/${project.id}/sender-token`, headers: ctx.owner });
    expect((await submit(fresh, facts())).statusCode).toBe(401);
  });
});

describe('what never gets stored', () => {
  it('refuses a submission carrying a secret, stores nothing, and never echoes it', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const secret = FAKE_GITHUB_TOKEN;
    const r = await submit(token, facts({ summary: `Rotated the deploy credential ${secret} after the leak report came in.` }));
    expect(r.statusCode).toBe(422);
    expect(r.body).not.toContain(secret);
    expect((r.json() as Json).error.details.refusals.map((x: Json) => x.code)).toContain('SECRET');

    const [{ count }] = (await query<{ count: number }>('SELECT count(*)::int AS count FROM dev_updates')) as [{ count: number }];
    expect(count).toBe(0);
    const audit = await query<{ data: unknown }>(`SELECT data FROM audit_events WHERE action = 'dev_updates.refused'`);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain('deploy credential');
  });

  it.each([
    ['code', { summary: "Changed it to import { claim } from './jobs' so the lease is taken first." }, 'RAW_CODE'],
    ['a private address', { why: 'Shows up on http://localhost:8787 for everyone on the box now.' }, 'PRIVATE_LOCATION'],
    ['no public disclosure', { disclosure: 'yes' }, 'NOT_PUBLIC'],
    ['nothing meaningful', { title: 'Bug fixes', summary: 'Various improvements and fixes today.' }, 'NOT_MEANINGFUL'],
    ['an assistant credit', { post: 'fixed thread recovery after restarts, Claude found the race for me' }, 'ATTRIBUTION'],
    ['hashtag spam', { post: 'replies keep their thread after a restart now #devlog #buildinpublic #ai' }, 'HASHTAG_SPAM'],
  ])('refuses %s', async (_label, overrides, code) => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const r = await submit(token, facts(overrides));
    expect(r.statusCode, r.body).toBe(422);
    expect((r.json() as Json).error.details.refusals.map((x: Json) => x.code)).toContain(code);
    expect(await query('SELECT 1 FROM dev_updates')).toHaveLength(0);
  });

  it('lets the owner read a refusal on the audit log as codes and fields, never the words', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx);
    const r = await submit(token, facts({ why: 'Shows up on http://localhost:8787 for everyone on the box now.' }));
    expect(r.statusCode).toBe(422);

    // The screen's log reads refusals from here, so its shape is pinned.
    const audit = await app.inject({ method: 'GET', url: '/api/audit?action=dev_updates.refused', headers: ctx.owner });
    expect(audit.statusCode, audit.body).toBe(200);
    const items = (audit.json() as Json).data.items as Json[];
    const row = items.find((i) => i.entityId === project.id);
    expect(row, audit.body).toBeDefined();
    expect(row!.data.codes).toContain('PRIVATE_LOCATION');
    expect(row!.data.fields).toContain('why');
    expect(audit.body).not.toContain('localhost:8787');
  });

  it('forgets the words of a rejected update but still recognises it', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const body = facts();
    const update = await submitOk(token, body);
    const r = await app.inject({ method: 'POST', url: `/api/dev-updates/updates/${update.id}/reject`, headers: ctx.owner, payload: { note: 'not yet' } });
    expect(r.statusCode, r.body).toBe(200);

    const [row] = await query<Json>('SELECT title, summary, why, post_text, evidence FROM dev_updates WHERE id = $1', [update.id]);
    expect(row).toMatchObject({ title: '', summary: '', why: '', post_text: '', evidence: [] });

    const again = await submit(token, { ...body, clientRequestId: undefined });
    expect(again.statusCode).toBe(200);
    expect((again.json() as Json).data).toMatchObject({ outcome: 'DUPLICATE' });
    expect((again.json() as Json).data.reason).toMatch(/rejected/);
  });
});

describe('draft mode, end to end on the mock channel', () => {
  it('waits for the owner, posts the exact approved text once, and reports the link', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx, { rehearse: false });
    const update = await submitOk(token, facts({ post: 'replies keep their thread after a worker restart now, so long chats stop losing context.' }));
    expect(update.status).toBe('PENDING_REVIEW');

    // Nothing moves without the owner.
    expect((await dispatchDevUpdates(10)).filter((d) => d.dispatched)).toHaveLength(0);

    const edited = 'replies now keep their thread through a worker restart. long conversations stop forgetting halfway.';
    const approved = await approve(ctx, update.id, { editedText: edited });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((approved.json() as Json).data).toMatchObject({ status: 'APPROVED', post: edited, edited: true });

    const tick = await runDevUpdates(5);
    expect(tick.dispatched.filter((d) => d.dispatched)).toHaveLength(1);
    const dispatched = await ownerUpdate(ctx, update.id);
    expect(dispatched.status).toBe('DISPATCHED');

    await drainAgentJobs(ctx.agentId);
    await reconcileDevUpdates(10);

    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('PUBLISHED');
    expect(done.url).toMatch(/^mock:\/\/message\//);
    expect(done.history.map((h: Json) => h.status)).toEqual(['PENDING_REVIEW', 'APPROVED', 'DISPATCHED', 'PUBLISHED']);

    const sent = await actions.listJobActions(done.jobId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.text, 'what was approved is what was published').toBe(edited);
    expect(sent[0]!.type).toBe('POST');

    const senderView = await app.inject({ method: 'GET', url: `/api/dev-updates/sender/updates/${update.id}`, headers: bearer(token) });
    expect((senderView.json() as Json).data).toMatchObject({ status: 'PUBLISHED', url: done.url });
    expect((senderView.json() as Json).data.jobId).toBeUndefined();
    expect(project.id).toBeTruthy();
  });

  it('rehearses by default and publishes nothing', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const update = await submitOk(token);
    await approve(ctx, update.id);
    await runDevUpdates(5);
    await drainAgentJobs(ctx.agentId);
    await reconcileDevUpdates(10);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('REHEARSED');
    expect(done.url).toBeNull();
    expect((await actions.listJobActions(done.jobId)).every((a) => a.dryRun)).toBe(true);
    expect(done.reason, 'names the switch that held it').toMatch(/because this project rehearses/);
  });

  it("names the agent's own dry-run default when that, not the project, held the post", async () => {
    // A new agent's policy rehearses by default, so turning the project's
    // rehearsal off is not enough on its own and the owner has to be told why.
    const ctx = await setup({ policy: { automation: { mode: 'AUTONOMOUS', dryRunDefault: true } } as Partial<PolicyConfig> });
    const { token } = await createProject(ctx, { rehearse: false });
    const update = await submitOk(token);
    await approve(ctx, update.id);
    await runDevUpdates(5);
    await drainAgentJobs(ctx.agentId);
    await reconcileDevUpdates(10);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('REHEARSED');
    expect(done.reason).toMatch(/agent's own policy/);
    expect(done.reason).not.toMatch(/this project rehearses/);
    expect((await actions.listJobActions(done.jobId)).every((a) => a.dryRun)).toBe(true);
  });
});

describe('an approval never gets around policy', () => {
  it('refuses an edit that breaks a rule', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const update = await submitOk(token);
    const r = await approve(ctx, update.id, { editedText: 'shipped thread recovery, written by an AI assistant overnight' });
    expect(r.statusCode).toBe(422);
    expect((await ownerUpdate(ctx, update.id)).status).toBe('PENDING_REVIEW');
  });

  it('holds an approved update while the agent is switched off, and says why', async () => {
    const ctx = await setup({ policy: { automation: { mode: 'OFF', dryRunDefault: false } } as Partial<PolicyConfig> });
    const { project, token } = await createProject(ctx, { rehearse: false });
    const update = await submitOk(token);
    await approve(ctx, update.id);
    const [result] = await dispatchDevUpdates(5);
    expect(result!.dispatched).toBe(false);
    expect(result!.reason).toMatch(/automation is off/);
    expect((await ownerUpdate(ctx, update.id)).status).toBe('APPROVED');
    const rules = await app.inject({ method: 'GET', url: '/api/dev-updates/sender/project', headers: bearer(token) });
    expect((rules.json() as Json).data.lastDispatchReason).toMatch(/automation is off/);
    expect(project.id).toBeTruthy();
  });

  it('holds it when the POST grant is revoked after the mapping was made', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { rehearse: false });
    const update = await submitOk(token);
    await approve(ctx, update.id);
    await capabilities.setGrants(ctx.agentId, ctx.accountId, ['READ', 'GENERATE'], ctx.ownerId);
    const [result] = await dispatchDevUpdates(5);
    expect(result!.dispatched).toBe(false);
    expect(result!.reason).toMatch(/not permitted to POST/);
  });

  it("waits at the agent's own gate in auto mode when the agent asks before acting", async () => {
    const ctx = await setup({ policy: { automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } } as Partial<PolicyConfig> });
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    expect(update.status).toBe('APPROVED');
    await runDevUpdates(5);
    await drainAgentJobs(ctx.agentId);
    await reconcileDevUpdates(10);

    const waiting = await ownerUpdate(ctx, update.id);
    expect(waiting.status).toBe('DISPATCHED');
    expect(waiting.reason).toMatch(/approval gate/);
    expect((await jobs.requireJob(waiting.jobId)).status).toBe('WAITING_FOR_APPROVAL');

    const r = await approve(ctx, update.id);
    expect(r.statusCode, r.body).toBe(200);
    await drainAgentJobs(ctx.agentId);
    await reconcileDevUpdates(10);
    expect((await ownerUpdate(ctx, update.id)).status).toBe('PUBLISHED');
  });
});

describe('the ceiling and the spacing', () => {
  it('sends at most the daily cap, spaced apart, in auto mode', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, dailyCap: 2, minSpacingMinutes: 30 });
    for (let i = 0; i < 3; i += 1) expect((await submitOk(token)).status).toBe('APPROVED');

    const first = await dispatchDevUpdates(5);
    expect(first.filter((d) => d.dispatched)).toHaveLength(1);

    // One in flight at a time: nothing else is handed over until it settles.
    const inFlight = await dispatchDevUpdates(5);
    expect(inFlight.filter((d) => d.dispatched)).toHaveLength(0);
    expect(inFlight[0]!.reason).toMatch(/still on its way/);

    await settle(ctx);
    const tooSoon = await dispatchDevUpdates(5);
    expect(tooSoon.filter((d) => d.dispatched)).toHaveLength(0);
    expect(tooSoon[0]!.reason).toMatch(/Spacing/);

    await backdateSends(project.id, 31);
    expect((await dispatchDevUpdates(5)).filter((d) => d.dispatched)).toHaveLength(1);
    await settle(ctx);

    await backdateSends(project.id, 31);
    const capped = await dispatchDevUpdates(5);
    expect(capped.filter((d) => d.dispatched)).toHaveLength(0);
    expect(capped[0]!.reason).toMatch(/Daily ceiling reached \(2 of 2/);

    const waiting = await app.inject({ method: 'GET', url: '/api/dev-updates/sender/updates', headers: bearer(token) });
    const items = (waiting.json() as Json).data.items as Json[];
    expect(items.filter((u) => u.status === 'PUBLISHED')).toHaveLength(2);
    const stillApproved = items.filter((u) => u.status === 'APPROVED');
    expect(stillApproved).toHaveLength(1);
    expect(stillApproved[0]!.waitingBecause).toMatch(/Daily ceiling/);
  });

  it('measures spacing on the real send, so a held job cannot bunch up behind the last post', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, dailyCap: 6, minSpacingMinutes: 30 });
    const a = await submitOk(token);
    const b = await submitOk(token);
    await dispatchDevUpdates(5);
    await settle(ctx);
    expect((await ownerUpdate(ctx, a.id)).status).toBe('PUBLISHED');

    // The hand-over looks old enough, the post itself does not.
    await query(`UPDATE dev_updates SET dispatched_at = dispatched_at - interval '31 minutes' WHERE project_id = $1`, [project.id]);
    expect((await dispatchDevUpdates(5)).filter((d) => d.dispatched)).toHaveLength(1);
    await settle(ctx);
    const held = await ownerUpdate(ctx, b.id);
    expect(held.status).toBe('DISPATCHED');
    expect(held.reason).toMatch(/less than 30 minutes ago/);
    expect((await actions.listJobActions(held.jobId)).filter((x) => !x.dryRun)).toHaveLength(0);

    await backdateSends(project.id, 31);
    await makeDue(held.jobId);
    await settle(ctx);
    expect((await ownerUpdate(ctx, b.id)).status).toBe('PUBLISHED');
  });

  it('enforces the daily cap at the moment of sending too', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, dailyCap: 1, minSpacingMinutes: 30 });
    const a = await submitOk(token);
    const b = await submitOk(token);
    await dispatchDevUpdates(5);
    await settle(ctx);
    expect((await ownerUpdate(ctx, a.id)).status).toBe('PUBLISHED');

    // Only the hand-over is moved back, so the dispatcher lets the next one go
    // and the executor is the thing that has to say no.
    await query(`UPDATE dev_updates SET dispatched_at = dispatched_at - interval '25 hours' WHERE project_id = $1`, [project.id]);
    await query(`UPDATE actions SET executed_at = executed_at - interval '2 hours' WHERE job_id = (SELECT job_id FROM dev_updates WHERE id = $1)`, [a.id]);
    expect((await dispatchDevUpdates(5)).filter((d) => d.dispatched)).toHaveLength(1);
    await settle(ctx);
    const held = await ownerUpdate(ctx, b.id);
    expect(held.status).toBe('DISPATCHED');
    expect(held.reason).toMatch(/already posted 1 of 1/);
  });

  it('pauses when the owner turns the project off', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx, { mode: 'AUTO', rehearse: false });
    await submitOk(token);
    await setProject(ctx, project.id, { enabled: false });
    expect((await dispatchDevUpdates(5)).filter((d) => d.dispatched)).toHaveLength(0);
  });

  it('gets round to every project, even when the first ones are always blocked', async () => {
    const ctxs: Ctx[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ctx = await setup({ policy: { automation: { mode: 'OFF', dryRunDefault: false } } as Partial<PolicyConfig> });
      const { token } = await createProject(ctx, { mode: 'AUTO' });
      await submitOk(token);
      ctxs.push(ctx);
    }
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) for (const r of await dispatchDevUpdates(1)) seen.add(r.projectId);
    expect(seen.size).toBe(3);
  });
});

describe('at most once, whoever arrives together', () => {
  it('accepts one of several identical submissions made at the same moment', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const body = facts();
    const responses = await Promise.all(Array.from({ length: 6 }, () => submit(token, body)));
    const outcomes = responses.map((r) => (r.json() as Json).data?.outcome);
    expect(outcomes.filter((o) => o === 'ACCEPTED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(5);
    expect(await query('SELECT 1 FROM dev_updates')).toHaveLength(1);
  });

  it('treats the same request id, the same title, or only already-announced evidence as a duplicate', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const first = facts({ clientRequestId: 'request-0001' });
    await submitOk(token, first);

    const sameRequest = await submit(token, facts({ clientRequestId: 'request-0001' }));
    expect((sameRequest.json() as Json).data).toMatchObject({ outcome: 'DUPLICATE', reason: 'This request was already received.' });

    const sameTitle = await submit(token, facts({ title: first.title }));
    expect((sameTitle.json() as Json).data.outcome).toBe('DUPLICATE');

    const sameEvidence = await submit(token, facts({ evidence: first.evidence }));
    expect((sameEvidence.json() as Json).data).toMatchObject({ outcome: 'DUPLICATE' });
    expect((sameEvidence.json() as Json).data.reason).toMatch(/already announced/);
  });

  it('creates one job however many dispatchers run at once', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, dailyCap: 6, minSpacingMinutes: 30 });
    for (let i = 0; i < 3; i += 1) await submitOk(token);
    const results = (await Promise.all(Array.from({ length: 5 }, () => dispatchDevUpdates(5)))).flat();
    expect(results.filter((d) => d.dispatched)).toHaveLength(1);
    const [{ count }] = (await query<{ count: number }>(`SELECT count(*)::int AS count FROM jobs WHERE agent_id = $1`, [
      ctx.agentId,
    ])) as [{ count: number }];
    expect(count).toBe(1);
  });

  it('never makes a second job for an update, even if it is handed over again', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    await dispatchDevUpdates(5);
    const first = await ownerUpdate(ctx, update.id);

    // As if a restart replayed the hand-over.
    await query(`UPDATE dev_updates SET status = 'APPROVED', dispatched_at = NULL WHERE id = $1`, [update.id]);
    await dispatchDevUpdates(5);
    const again = await ownerUpdate(ctx, update.id);
    expect(again.jobId).toBe(first.jobId);
    expect(await query('SELECT 1 FROM jobs WHERE agent_id = $1', [ctx.agentId])).toHaveLength(1);
  });
});

describe('sends that fail', () => {
  it('never resends after a failed attempt it cannot confirm, so a timeout after acceptance cannot post twice', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    let calls = 0;
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async () => {
      calls += 1;
      throw PipelineError.retryable('network_blip', 'The channel did not answer in time.');
    });

    await runDevUpdates(5);
    const { jobId } = await ownerUpdate(ctx, update.id);
    await drainAgentJobs(ctx.agentId);
    await makeDue(jobId);
    await settle(ctx);

    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('FAILED');
    expect(done.reason).toMatch(/may or may not have reached/);
    expect(calls, 'the second attempt must not send').toBe(1);
  });

  it('retries when the channel confirms the first attempt never arrived, and posts once', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    const real = mockAdapter.executeAction.bind(mockAdapter);
    let calls = 0;
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      calls += 1;
      if (calls === 1) throw PipelineError.retryable('network_blip', 'The channel did not answer.');
      return real(c, request);
    });
    const adapter = mockAdapter as { wasAlreadyDone?: unknown };
    adapter.wasAlreadyDone = async () => ({ done: false, conclusive: true, remoteActionId: null, remoteActionUrl: null, detail: 'Not on the account.' });
    try {
      await runDevUpdates(5);
      const { jobId } = await ownerUpdate(ctx, update.id);
      await drainAgentJobs(ctx.agentId);
      await makeDue(jobId);
      await settle(ctx);
      const done = await ownerUpdate(ctx, update.id);
      expect(done.status).toBe('PUBLISHED');
      expect(calls).toBe(2);
      expect((await actions.listJobActions(jobId)).filter((a) => a.status === 'EXECUTED')).toHaveLength(1);
    } finally {
      delete adapter.wasAlreadyDone;
    }
  });

  it('stops when the read-back itself fails', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    let calls = 0;
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async () => {
      calls += 1;
      throw PipelineError.retryable('network_blip', 'The channel did not answer.');
    });
    const adapter = mockAdapter as { wasAlreadyDone?: unknown };
    adapter.wasAlreadyDone = async () => {
      throw new Error('could not read the timeline');
    };
    try {
      await runDevUpdates(5);
      const { jobId } = await ownerUpdate(ctx, update.id);
      await drainAgentJobs(ctx.agentId);
      await makeDue(jobId);
      await settle(ctx);
      expect((await ownerUpdate(ctx, update.id)).status).toBe('FAILED');
      expect(calls).toBe(1);
    } finally {
      delete adapter.wasAlreadyDone;
    }
  });

  it('reports a permanent failure with the reason the pipeline gave', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    vi.spyOn(mockAdapter, 'executeAction').mockRejectedValue(
      PipelineError.permanent('account_suspended', 'The account is suspended and cannot post.'),
    );
    await runDevUpdates(5);
    await settle(ctx);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('FAILED');
    expect(done.reason).toMatch(/suspended/);
  });
});

describe('what changed after the hand-over still counts at the moment of sending', () => {
  const GATED = { policy: { automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: false } } as Partial<PolicyConfig> };

  /** An update in auto mode, dispatched and parked at the agent's own approval gate. */
  async function parkedAtGate(projectBody: Json = {}) {
    const ctx = await setup(GATED);
    const created = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30, ...projectBody });
    const update = await submitOk(created.token);
    await runDevUpdates(5);
    await settle(ctx);
    const parked = await ownerUpdate(ctx, update.id);
    expect((await jobs.requireJob(parked.jobId)).status).toBe('WAITING_FOR_APPROVAL');
    return { ctx, project: created.project, update: parked };
  }

  it('holds a queued post while the project is paused, and sends it once resumed', async () => {
    const { ctx, project, update } = await parkedAtGate();
    await setProject(ctx, project.id, { enabled: false });
    expect((await approve(ctx, update.id)).statusCode).toBe(200);
    await settle(ctx);
    const paused = await ownerUpdate(ctx, update.id);
    expect(paused.status).toBe('DISPATCHED');
    expect(paused.reason).toMatch(/paused/);
    expect((await actions.listJobActions(update.jobId)).filter((a) => !a.dryRun)).toHaveLength(0);

    await setProject(ctx, project.id, { enabled: true });
    await makeDue(update.jobId);
    await settle(ctx);
    expect((await ownerUpdate(ctx, update.id)).status).toBe('PUBLISHED');
  });

  it('does not publish once the project is switched to rehearsal, and says so once', async () => {
    const { ctx, project, update } = await parkedAtGate();
    await setProject(ctx, project.id, { rehearse: true });
    await approve(ctx, update.id);
    await settle(ctx);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('FAILED');
    expect(done.reason).toMatch(/switched to rehearsal/);
    expect((await actions.listJobActions(update.jobId)).filter((a) => !a.dryRun)).toHaveLength(0);
  });

  it('does not post through an account the project was moved away from', async () => {
    const { ctx, project, update } = await parkedAtGate();
    const other = await accounts.createAccount({ ownerId: ctx.ownerId, channel: 'mock', handle: `dev2_${uniqueSuffix()}` });
    await accounts.linkAgentAccount({ agentId: ctx.agentId, accountId: other.id, actionType: 'POST' });
    await setProject(ctx, project.id, { accountId: other.id });
    await approve(ctx, update.id);
    await settle(ctx);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('FAILED');
    expect(done.reason).toMatch(/different agent or account/);
  });

  it('refuses unsafe text edited in through the ordinary review queue', async () => {
    const { ctx, update } = await parkedAtGate();
    await approveJob({ jobId: update.jobId, decidedBy: ctx.ownerId, editedOutput: 'thread recovery is out, Claude found the race for me' });
    await settle(ctx);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('FAILED');
    expect(done.reason).toMatch(/stopped before sending/);
    expect((await actions.listJobActions(update.jobId)).filter((a) => !a.dryRun)).toHaveLength(0);
  });

  it('records an edit made at the gate as the text that was approved and published', async () => {
    const { ctx, update } = await parkedAtGate();
    const edited = 'replies keep their thread through a worker restart now, so long chats stop losing context.';
    const r = await approve(ctx, update.id, { editedText: edited });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as Json).data).toMatchObject({ post: edited, edited: true });
    await settle(ctx);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('PUBLISHED');
    expect(done.post).toBe(edited);
    expect((await actions.listJobActions(update.jobId))[0]!.payload.text).toBe(edited);
  });

  it('asks the owner once when auto mode is switched back to draft, then posts after one approval', async () => {
    const ctx = await setup();
    const { project, token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    await runDevUpdates(5);
    await setProject(ctx, project.id, { mode: 'DRAFT' });
    await settle(ctx);
    const asking = await ownerUpdate(ctx, update.id);
    expect(asking.status).toBe('DISPATCHED');
    expect((await jobs.requireJob(asking.jobId)).status).toBe('REVIEW_REQUIRED');
    expect(asking.reason).toMatch(/draft mode/);

    expect((await approve(ctx, update.id)).statusCode).toBe(200);
    await settle(ctx);
    expect((await ownerUpdate(ctx, update.id)).status, 'one approval is enough; it must not ask again').toBe('PUBLISHED');
  });
});

describe('a rejection never races a hand-over or a send', () => {
  it('cancels a job that was already handed over, and nothing is posted', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    await runDevUpdates(5);
    const r = await app.inject({ method: 'POST', url: `/api/dev-updates/updates/${update.id}/reject`, headers: ctx.owner, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    await settle(ctx);
    const done = await ownerUpdate(ctx, update.id);
    expect(done.status).toBe('REJECTED');
    expect(await actions.listJobActions(done.jobId)).toHaveLength(0);
  });

  it('refuses to reject while the account is in the middle of sending', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    await runDevUpdates(5);
    const held = await accountLease.withAccountLease(
      { accountId: ctx.accountId, workerId: 'test-sender', reason: 'sending', ttlMs: 60_000 },
      () => app.inject({ method: 'POST', url: `/api/dev-updates/updates/${update.id}/reject`, headers: ctx.owner, payload: {} }),
    );
    expect(held.held).toBe(true);
    if (held.held) {
      expect(held.value.statusCode).toBe(409);
      expect(held.value.body).toMatch(/being sent right now/);
    }
    expect((await ownerUpdate(ctx, update.id)).status).toBe('DISPATCHED');
  });

  it('refuses a late rejection once a send was attempted', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token);
    vi.spyOn(mockAdapter, 'executeAction').mockRejectedValue(PipelineError.retryable('network_blip', 'No answer.'));
    await runDevUpdates(5);
    await drainAgentJobs(ctx.agentId);
    const r = await app.inject({ method: 'POST', url: `/api/dev-updates/updates/${update.id}/reject`, headers: ctx.owner, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatch(/already begun/);
    expect((await ownerUpdate(ctx, update.id)).status).toBe('DISPATCHED');
  });

  it('lets exactly one of a rejection and a hand-over win when they arrive together', async () => {
    for (let round = 0; round < 3; round += 1) {
      const ctx = await setup();
      const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
      const update = await submitOk(token);
      const [rejected] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/dev-updates/updates/${update.id}/reject`, headers: ctx.owner, payload: {} }),
        dispatchDevUpdates(5),
      ]);
      expect(rejected.statusCode, rejected.body).toBe(200);
      await settle(ctx);
      const done = await ownerUpdate(ctx, update.id);
      expect(done.status).toBe('REJECTED');
      const sent = done.jobId ? (await actions.listJobActions(done.jobId)).filter((a) => !a.dryRun) : [];
      expect(sent, 'a rejected update must never have been sent').toHaveLength(0);
    }
  });
});

describe('auto mode is not a way past the agent policy', () => {
  const TOPICAL = {
    policy: { content: { ...DEFAULT_POLICY.content, blockedTopics: ['quiet hours'] } } as Partial<PolicyConfig>,
  };

  it('holds for the owner what the validator would send to review', async () => {
    const ctx = await setup(TOPICAL);
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false });
    const update = await submitOk(token, facts({ post: 'scheduled posts now respect quiet hours, so nothing goes out at 3am by accident' }));
    expect(update.status).toBe('PENDING_REVIEW');
    expect(update.reason).toMatch(/despite auto mode/);
  });

  it('sends an approved update back to the owner if the text now needs review at hand-over', async () => {
    const ctx = await setup(TOPICAL);
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false });
    const update = await submitOk(token);
    await query(`UPDATE dev_updates SET post_text = 'scheduled posts now respect quiet hours, so nothing goes out at 3am by accident' WHERE id = $1`, [update.id]);
    const [result] = await dispatchDevUpdates(5);
    expect(result!.dispatched).toBe(false);
    expect((await ownerUpdate(ctx, update.id)).status).toBe('PENDING_REVIEW');
  });
});

describe('security and unreleased work', () => {
  it.each([
    ['an auth bypass', { title: 'Closed an authentication bypass in the login flow', summary: 'Anybody could skip the password check by replaying an old session cookie until today.' }],
    ['a CVE', { summary: 'Patched CVE-2026-12345 in the upload handler, which allowed reading other files.' }],
    ['embargoed work', { why: 'This stays under embargo until the partner announces it next week.' }],
    ['unreleased work', { summary: 'The unreleased billing redesign now handles annual plans and refunds properly.' }],
  ])('refuses %s whatever the disclosure says', async (_label, overrides) => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const r = await submit(token, facts(overrides));
    expect(r.statusCode, r.body).toBe(422);
    expect((r.json() as Json).error.details.refusals.map((x: Json) => x.code)).toContain('SENSITIVE');
    expect(await query('SELECT 1 FROM dev_updates')).toHaveLength(0);
  });

  it('refuses a request id that is prose, without repeating it, and stores only a hash of a valid one', async () => {
    const ctx = await setup();
    const { token } = await createProject(ctx);
    const prose = 'internal note: the staging password is hunter2';
    const bad = await submit(token, facts({ clientRequestId: prose }));
    expect(bad.statusCode).toBe(422);
    expect(bad.body).not.toContain('hunter2');
    expect(await query('SELECT 1 FROM dev_updates')).toHaveLength(0);

    await submitOk(token, facts({ clientRequestId: 'req-2026-11-07-0001' }));
    const [row] = await query<{ client_request_id: string }>('SELECT client_request_id FROM dev_updates');
    expect(row!.client_request_id).not.toContain('req-2026');
    expect(row!.client_request_id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('recovering an attempt whose text was edited afterwards', () => {
  const FIRST = 'replies keep their thread through a worker restart now, so long chats stop losing context.';
  const EDITED = 'long conversations survive a worker restart now; replies keep the thread they belong to.';

  /** An update whose first send failed locally, then edited at review to new wording. */
  async function failedThenEdited() {
    const ctx = await setup();
    const { token } = await createProject(ctx, { mode: 'AUTO', rehearse: false, minSpacingMinutes: 30 });
    const update = await submitOk(token, facts({ post: FIRST }));
    const real = mockAdapter.executeAction.bind(mockAdapter);
    const sent: string[] = [];
    let calls = 0;
    vi.spyOn(mockAdapter, 'executeAction').mockImplementation(async (c, request) => {
      calls += 1;
      sent.push(request.text ?? '');
      // The first attempt: the remote took it, and the local side timed out.
      if (calls === 1) throw PipelineError.retryable('timeout', 'The composer did not close in time.');
      return real(c, request);
    });
    await runDevUpdates(5);
    const { jobId } = await ownerUpdate(ctx, update.id);
    await drainAgentJobs(ctx.agentId);
    expect((await actions.listJobActions(jobId))[0]!.payload.text).toBe(FIRST);

    await query(`UPDATE jobs SET status = 'REVIEW_REQUIRED', run_at = now() WHERE id = $1`, [jobId]);
    const r = await approve(ctx, update.id, { editedText: EDITED });
    expect(r.statusCode, r.body).toBe(200);
    return { ctx, update, jobId, sent };
  }

  it('looks for the wording actually attempted, finds it, and never posts the edit as well', async () => {
    const asked: string[] = [];
    const adapter = mockAdapter as { wasAlreadyDone?: unknown };
    adapter.wasAlreadyDone = async (_c: unknown, request: { text: string }) => {
      asked.push(request.text);
      return request.text === FIRST
        ? { done: true, conclusive: true, remoteActionId: 'mock-first', remoteActionUrl: 'mock://message/mock-first', detail: 'Found it.' }
        : { done: false, conclusive: true, remoteActionId: null, remoteActionUrl: null, detail: 'Not there.' };
    };
    try {
      const { ctx, update, jobId, sent } = await failedThenEdited();
      await settle(ctx);
      expect(asked).toEqual([FIRST]);
      expect(sent, 'the edited wording must not go out on top of the first').toEqual([FIRST]);
      const done = await ownerUpdate(ctx, update.id);
      expect(done.status).toBe('PUBLISHED');
      expect(done.url).toBe('mock://message/mock-first');
      expect(done.post, 'the record says what was actually published').toBe(FIRST);
      const rows = await actions.listJobActions(jobId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.text).toBe(FIRST);
    } finally {
      delete adapter.wasAlreadyDone;
    }
  });

  it('sends the edit once the first wording is proved absent, and the record matches it', async () => {
    const adapter = mockAdapter as { wasAlreadyDone?: unknown };
    adapter.wasAlreadyDone = async () => ({ done: false, conclusive: true, remoteActionId: null, remoteActionUrl: null, detail: 'Not there.' });
    try {
      const { ctx, update, jobId, sent } = await failedThenEdited();
      await settle(ctx);
      expect(sent).toEqual([FIRST, EDITED]);
      const done = await ownerUpdate(ctx, update.id);
      expect(done.status).toBe('PUBLISHED');
      expect(done.post).toBe(EDITED);
      const rows = await actions.listJobActions(jobId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.text).toBe(EDITED);
    } finally {
      delete adapter.wasAlreadyDone;
    }
  });

  it('does not resend the edit when the absence is not conclusive', async () => {
    const adapter = mockAdapter as { wasAlreadyDone?: unknown };
    adapter.wasAlreadyDone = async () => ({ done: false, remoteActionId: null, remoteActionUrl: null, detail: 'Nothing seen.' });
    try {
      const { ctx, update, sent } = await failedThenEdited();
      await settle(ctx);
      expect(sent).toEqual([FIRST]);
      expect((await ownerUpdate(ctx, update.id)).status).toBe('FAILED');
    } finally {
      delete adapter.wasAlreadyDone;
    }
  });
});
