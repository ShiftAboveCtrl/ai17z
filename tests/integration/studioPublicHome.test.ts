import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityPermissions, jobs, ops, query } from '@xbam/database';
import { sealSecret } from '@xbam/shared';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture, type Fixture } from '../support/fixtures';
import { previewPublicHome, publishPublicHome, publicHomeState, publicHomeReply, unpublishPublicHome, proposePublicHomePost, setPublicHomePosting, publicHomeSendRefusal } from '../../packages/runtime/src/studioPublicHome';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { setStudioTransportForTests } from '../../packages/runtime/src/studioLink';
import { setStudioControl } from '../../packages/runtime/src/studioControl';
import { publicHomeStudioServer } from '../support/publicHomeStudioServer';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { drainJobs } from '../support/runner';
import { packAgent, unpackAgent } from '../../packages/runtime/src/agentPackage';
import { exportAgent, importAgent } from '../../packages/runtime/src/portableAgent';
import { buildServer } from '../../apps/api/src/server';

installHarness();
let f: Fixture;
let studio: Awaited<ReturnType<typeof publicHomeStudioServer>> | null = null;
beforeEach(async () => { f = await createFixture({ persona: { biography: 'An AI agent studying liquidity changes.', tone: 'Calm and precise.', customInstructions: 'PRIVATE-OPERATOR-PROMPT' } }); });
afterEach(async () => {
  setStudioTransportForTests(null);
  delete process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN;
  await studio?.close(); studio = null;
});
async function link() {
  const key = newInstallationKey();
  studio = await publicHomeStudioServer(key);
  process.env.AI17Z_STUDIO_UNSAFE_DEV_ORIGIN = studio.origin;
  await ops.setSetting('studio.installation.key', sealSecret(JSON.stringify(key)));
  await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio.origin, linkedAt: new Date().toISOString(), revokedAt: null });
  setStudioTransportForTests(async (url, init) => { const response = await fetch(url, init); return { status: response.status, text: await response.text() }; });
  await setStudioControl(true, f.ownerId);
}
async function publish() {
  const p = await previewPublicHome({ agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Night Owl' } });
  const result = await publishPublicHome({ agentId: f.agentId, ownerId: f.ownerId, digest: p.digest, confirmed: true });
  expect(result.ok).toBe(true);
  return p;
}
describe('public home consent persisted in Postgres', () => {
  it('starts unpublished and cannot confirm without a preview', async () => {
    expect((await publicHomeState(f.agentId)).confirmed).toBeNull();
    expect(await publicHomeReply(f.agentId)).toBe('I have no published public home.');
    expect((await publishPublicHome({ agentId: f.agentId, ownerId: f.ownerId, digest: '0'.repeat(64), confirmed: true })).ok).toBe(false);
  });
  it('builds an exact local preview and requires both control and owner confirmation', async () => {
    const p = await previewPublicHome({ agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Night Owl' } });
    expect(p.manifest.alias).toBe('Night Owl');
    expect(p.manifest.identity).toBe('AI_AGENT');
    expect((await publishPublicHome({ agentId: f.agentId, ownerId: f.ownerId, digest: p.digest, confirmed: false })).ok).toBe(false);
    expect((await publishPublicHome({ agentId: f.agentId, ownerId: f.ownerId, digest: p.digest, confirmed: true })).ok).toBe(false);
    expect((await publicHomeState(f.agentId)).confirmed).toBeNull();
  });
  it('refuses another owner for preview, publish and unpublish', async () => {
    const other = await createFixture();
    await expect(previewPublicHome({ agentId: f.agentId, ownerId: other.ownerId, choices: { alias: 'Night Owl' } })).rejects.toThrow();
    await expect(publishPublicHome({ agentId: f.agentId, ownerId: other.ownerId, digest: '0'.repeat(64), confirmed: true })).rejects.toThrow();
    await expect(unpublishPublicHome(f.agentId, other.ownerId)).rejects.toThrow();
  });
  it('does not present an old confirmation as live', async () => {
    await query('INSERT INTO agent_public_home(agent_id,confirmed) VALUES ($1,$2::jsonb)', [f.agentId, JSON.stringify({ published: true, slug: 'night-owl', origin: 'https://example.invalid', confirmedAt: '2020-01-01T00:00:00.000Z' })]);
    expect((await publicHomeState(f.agentId)).stale).toBe(true);
    expect(await publicHomeReply(f.agentId)).not.toContain('https://');
  });
  it('sends exact preview bytes with DPoP, retries the same key after a lost receipt, then removes the page', async () => {
    await link();
    const p = await previewPublicHome({ agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Night Owl', includeVoice: true } });
    expect(studio!.requests).toHaveLength(0);
    studio!.loseNextAnswer();
    const input = { agentId: f.agentId, ownerId: f.ownerId, digest: p.digest, confirmed: true };
    expect((await publishPublicHome(input)).ok).toBe(false);
    expect((await publicHomeState(f.agentId)).confirmed).toBeNull();
    expect((await publishPublicHome(input)).ok).toBe(true);
    expect(studio!.requests[0]).toEqual(studio!.requests[1]);
    expect(studio!.requests[0]!.manifest).toEqual(p.manifest);
    expect(JSON.stringify(studio!.requests)).not.toContain('PRIVATE-OPERATOR-PROMPT');
    expect(await publicHomeReply(f.agentId)).toBe(`${studio!.origin}/a/night-owl`);
    expect((await unpublishPublicHome(f.agentId, f.ownerId)).ok).toBe(true);
    expect(studio!.published).toBe(false);
    expect(await publicHomeReply(f.agentId)).toBe('I have no published public home.');
    await publish();
    expect((await unpublishPublicHome(f.agentId, f.ownerId)).ok).toBe(true);
    expect(studio!.published).toBe(false);
  });
  it('keeps last confirmed publication on failure and blocks stale sharing and queued posts', async () => {
    await link(); await publish();
    expect(await proposePublicHomePost(f.agentId)).toBe(false);
    await setPublicHomePosting(f.agentId, f.ownerId, true);
    expect(await proposePublicHomePost(f.agentId)).toBe(true);
    expect(await proposePublicHomePost(f.agentId)).toBe(false);
    const text = `AI agent. Simulated paper results. ${await publicHomeReply(f.agentId)}`;
    expect(await publicHomeSendRefusal(f.agentId, text, true)).toBeNull();
    studio!.setUnavailable(true);
    const before = (await publicHomeState(f.agentId)).confirmed;
    expect((await unpublishPublicHome(f.agentId, f.ownerId)).ok).toBe(false);
    expect((await publicHomeState(f.agentId)).confirmed).toEqual(before);
    expect((await publicHomeState(f.agentId)).stale).toBe(true);
    expect(await publicHomeSendRefusal(f.agentId, text, true)).toBeTruthy();
    expect(await publicHomeReply(f.agentId)).not.toContain('http');
  });
  it('refuses wrong digest, expired preview, changed Studio link and an acknowledgement for other bytes', async () => {
    await link();
    const p = await previewPublicHome({ agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Night Owl' } });
    const input = { agentId: f.agentId, ownerId: f.ownerId, digest: p.digest, confirmed: true };
    expect((await publishPublicHome({ ...input, digest: '0'.repeat(64) })).ok).toBe(false);
    expect((await publishPublicHome(input, new Date(Date.now() + 3_600_000))).ok).toBe(false);
    expect(studio!.requests).toHaveLength(0);
    studio!.mismatchNextReceipt();
    expect((await publishPublicHome(input)).ok).toBe(false);
    expect((await publicHomeState(f.agentId)).confirmed).toBeNull();
    await ops.setSetting('studio.link', { installationId: randomUUID(), origin: studio!.origin, revokedAt: null });
    expect((await publishPublicHome(input)).ok).toBe(false);
    expect(studio!.requests).toHaveLength(1);
  });
  it('answers a record-link question through the mock pipeline and honours dry run', async () => {
    await link(); await publish();
    const outcome = await ingestNormalizedEvent({ onlyAgentId: f.agentId, accountId: null, event: mockEvent('Where can I see your record?'), dryRun: true });
    await drainJobs();
    const job = await jobs.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('DRY_RUN_COMPLETED');
    expect(job.validatedOutput).toBe(`${studio!.origin}/a/night-owl`);
  });
  it('keeps both portable imports and SHARE/MOVE package installs unpublished', async () => {
    await link(); await publish(); await setPublicHomePosting(f.agentId, f.ownerId, true);
    const portable = await exportAgent(f.agentId);
    expect(JSON.stringify(portable)).not.toContain('public_home');
    const imported = await importAgent({ ownerId: f.ownerId, document: portable, name: 'Imported Home' });
    expect((await publicHomeState(imported.agentId)).confirmed).toBeNull();
    for (const mode of ['SHARE', 'MOVE'] as const) {
      const pkg = await packAgent(f.agentId, mode);
      expect(JSON.stringify(pkg)).not.toContain('public_home');
      const installed = await unpackAgent({ ownerId: f.ownerId, createdBy: f.ownerId, raw: JSON.stringify(pkg), name: `Installed ${mode}` });
      expect((await publicHomeState(installed.agentId)).confirmed).toBeNull();
      expect((await publicHomeState(installed.agentId)).postLink).toBe(false);
    }
  });
  it('refuses unauthenticated and foreign owners at every API route', async () => {
    const app = await buildServer();
    try {
      const other = await createFixture();
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: other.ownerEmail, password: 'test-password-1234' } });
      const authorization = `Bearer ${login.json().data.token}`;
      const base = `/api/agents/${f.agentId}/public-home`;
      for (const route of [
        { method: 'GET' as const, url: base },
        { method: 'POST' as const, url: `${base}/preview`, payload: { alias: 'Night Owl' } },
        { method: 'POST' as const, url: `${base}/publish`, payload: { digest: 'a'.repeat(64), confirmed: true } },
        { method: 'POST' as const, url: `${base}/unpublish`, payload: {} },
        { method: 'PUT' as const, url: `${base}/posting`, payload: { enabled: true } },
      ]) {
        expect((await app.inject(route)).statusCode).toBe(401);
        expect((await app.inject({ ...route, headers: { authorization } })).statusCode).toBe(404);
      }
    } finally { await app.close(); }
  });
  it('projects only granted, published receipt metadata and honours scrubs', async () => {
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'studio.activity_tape', permission: 'ALLOWED' });
    const [event] = await query<{ id: string }>(`INSERT INTO events(channel,type,remote_event_id,text,payload)
      VALUES ('mock','MENTION',$1,'PRIVATE', '{"ideaSource":"radar_receipt"}') RETURNING id`, [randomUUID()]);
    const [job] = await query<{ id: string }>(`INSERT INTO jobs(event_id,agent_id,channel,action_type,idempotency_key)
      VALUES ($1,$2,'mock','POST',$3) RETURNING id`, [event!.id, f.agentId, randomUUID()]);
    const [action] = await query<{ id: string }>(`INSERT INTO actions(job_id,agent_id,channel,type,status,dry_run,payload,idempotency_key,executed_at)
      VALUES ($1,$2,'x','POST','EXECUTED',false,'{"text":"PRIVATE","account":"PRIVATE"}',$3,now()) RETURNING id`, [job!.id, f.agentId, randomUUID()]);
    const input = { agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Night Owl', showActivity: true } };
    const p = await previewPublicHome(input);
    expect(p.manifest.receipts).toEqual([{ id: `receipt:${action!.id}`, kind: 'RECEIPT', at: expect.any(String), dryRun: false }]);
    expect(JSON.stringify(p.manifest)).not.toContain('PRIVATE');
    await ops.setSetting('studio.activity_tape.scrubs', [`receipt:${action!.id}`]);
    expect((await previewPublicHome(input)).manifest.receipts).toEqual([]);
    await ops.setSetting('studio.activity_tape.scrubs', []);
    await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'studio.activity_tape', permission: 'DISABLED' });
    expect((await previewPublicHome(input)).manifest.receipts).toEqual([]);
  });
  it('serializes concurrent confirmations and preserves expiry when replaying the same preview', async () => {
    await link();
    const p = await previewPublicHome({ agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Night Owl' } });
    const input = { agentId: f.agentId, ownerId: f.ownerId, digest: p.digest, confirmed: true };
    expect((await Promise.all([publishPublicHome(input), publishPublicHome(input)])).every((r) => r.ok)).toBe(true);
    expect(studio!.receipts.size).toBe(1);
    expect((await publicHomeState(f.agentId, new Date(Date.parse(p.expiresAt) + 1))).url).toBeNull();
    await setStudioControl(false, f.ownerId);
    expect(await publicHomeReply(f.agentId)).not.toContain('http');
    expect((await unpublishPublicHome(f.agentId, f.ownerId)).ok).toBe(true);
  });
  it('can withdraw a first publication whose acknowledgement was lost', async () => {
    await link();
    const p = await previewPublicHome({ agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Night Owl' } });
    studio!.loseNextAnswer();
    expect((await publishPublicHome({ agentId: f.agentId, ownerId: f.ownerId, digest: p.digest, confirmed: true })).ok).toBe(false);
    expect(studio!.published).toBe(true);
    expect((await publicHomeState(f.agentId)).canUnpublish).toBe(true);
    await expect(previewPublicHome({ agentId: f.agentId, ownerId: f.ownerId, choices: { alias: 'Other Alias' } })).rejects.toThrow('outcome is unknown');
    expect((await unpublishPublicHome(f.agentId, f.ownerId)).ok).toBe(true);
    expect(studio!.published).toBe(false);
  });
});
