import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server';
import { agents, regression, query } from '@xbam/database';
import { EasySetup, PersonaDraft, PolicyConfig } from '@xbam/shared/contracts';
import { rehearse } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();
let app: FastifyInstance;
beforeAll(async () => { app = await buildServer(); await app.ready(); });
afterAll(async () => { await app?.close(); });

it('saves, edits, runs and archives an owned case and refuses cross-owner access', async () => {
  const f = await createFixture();
  const other = await createFixture();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: f.ownerEmail, password: 'test-password-1234' } });
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const run = await rehearse({ agentId: f.agentId, subject: { channel: 'mock', authorHandle: 'reader', text: 'How can an owner check software?' } });
  await drainJobs();
  const base = `/api/agents/${f.agentId}/lab`;
  const created = await app.inject({ method: 'POST', url: `${base}/cases`, headers, payload: { jobId: run.jobId, title: 'Software', checks: {} } });
  expect(created.statusCode).toBe(200);
  const id = created.json().data.id as string;
  const edited = await app.inject({ method: 'PATCH', url: `${base}/cases/${id}`, headers, payload: { title: 'Software question', checks: { forbid: ['secret'] } } });
  expect(edited.json().data.title).toBe('Software question');
  const foreign = await app.inject({ method: 'GET', url: `/api/agents/${other.agentId}/lab/cases`, headers });
  expect(foreign.statusCode).toBe(403);
  const rejected = await app.inject({ method: 'POST', url: `${base}/preview`, headers, payload: { candidate: { model: 'other-model' } } });
  expect(rejected.statusCode).toBe(422);
  const started = await app.inject({ method: 'POST', url: `${base}/runs`, headers, payload: {} });
  expect(started.statusCode).toBe(200);
  await drainJobs();
  const detail = await app.inject({ method: 'GET', url: `${base}/runs/${started.json().data.id}`, headers });
  expect(detail.json().data.results[0].digest.decision).toBe('ANSWERED');
  const archived = await app.inject({ method: 'PATCH', url: `${base}/cases/${id}`, headers, payload: { archive: true } });
  expect(archived.json().data.archivedAt).toBeTruthy();
  const list = await app.inject({ method: 'GET', url: `${base}/cases`, headers });
  expect(list.json().data.items).toHaveLength(0);
});


it.each(['easy', 'character', 'learned-persona', 'tool-allow'] as const)('notifies the lab after a %s save', async surface => {
  const f = await createFixture();
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: f.ownerEmail, password: 'test-password-1234' } });
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const base = `/api/agents/${f.agentId}`;
  let response;
  if (surface === 'easy') {
    response = await app.inject({ method: 'PUT', url: `${base}/easy`, headers, payload: EasySetup.parse({ character: { name: 'Changed', tone: 'Dry' } }) });
  } else if (surface === 'character') {
    response = await app.inject({ method: 'POST', url: `${base}/character/apply`, headers, payload: { answers: { name: 'Changed', tone: 'Dry' } } });
  } else if (surface === 'learned-persona') {
    await query("INSERT INTO persona_traits(agent_id,kind,content,confidence) VALUES($1,'style','Dry and concise',0.9)", [f.agentId]);
    response = await app.inject({ method: 'POST', url: `${base}/persona-sources/apply`, headers, payload: {} });
  } else {
    const policy = (await agents.getActivePolicy(f.agentId))!;
    await agents.savePolicyVersion(f.agentId, PolicyConfig.parse({ ...policy.config, tools: { ...policy.config.tools, allowed: [] } }), 'Restrict tools', f.ownerId);
    await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
    await app.inject({ method: 'PUT', url: `${base}/tools/memory.search`, headers, payload: { enabled: true, config: {} } });
    response = await app.inject({ method: 'POST', url: `${base}/tools/memory.search/allow`, headers });
  }
  expect(response.statusCode, response.body).toBe(200);
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: surface === 'easy' || surface === 'tool-allow' ? 'POLICY' : 'PERSONA' });
});


it('does not request a regression while the persona editor is autosaving', async () => {
  const f = await createFixture();
  await query('DELETE FROM agent_regression_changes WHERE agent_id=$1', [f.agentId]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: f.ownerEmail, password: 'test-password-1234' } });
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const draft = PersonaDraft.parse({ ...(await agents.getActivePersona(f.agentId))!, tone: 'Unfinished typing' });
  const base = `/api/agents/${f.agentId}/persona`;
  expect((await app.inject({ method: 'PUT', url: `${base}?autosave=1`, headers, payload: draft })).statusCode).toBe(200);
  expect(await regression.changeNotice(f.agentId)).toBeNull();
  expect((await app.inject({ method: 'PUT', url: base, headers, payload: draft })).statusCode).toBe(200);
  expect(await regression.changeNotice(f.agentId)).toMatchObject({ pending: true, trigger: 'PERSONA' });
});
