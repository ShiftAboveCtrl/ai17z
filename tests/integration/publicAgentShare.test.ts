import { describe, expect, it } from 'vitest';
import { agents, capabilityPermissions, ops, query } from '@xbam/database';
import { inspectPackage, packAgent, serialisePackage, unpackAgent } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import publicFixture from '../fixtures/public-agent-share.json';
import { writeFile } from 'node:fs/promises';
import { buildServer } from '../../apps/api/src/server';

installHarness();

describe('public SHARE profile', () => {
  it('AC1 exports only the consentable voice and structure, through SHARE', async () => {
    const f = await createFixture();
    const persona = await agents.getActivePersona(f.agentId);
    await agents.savePersonaVersion(f.agentId, { ...persona, biography: 'PRIVATE biography', customInstructions: 'PRIVATE prompt', styleGuidelines: 'PRIVATE guidance', personality: 'Curious and patient', tone: 'Plain spoken' } as never, f.ownerId);
    const pkg = await packAgent(f.agentId, 'SHARE', { publicAlias: 'Night Owl' } as never);
    expect(pkg.agent.name).toBe('Night Owl');
    expect(pkg.agent.persona.personality).toBe('Curious and patient');
    expect(pkg.agent.persona.tone).toBe('Plain spoken');
    expect(serialisePackage(pkg)).not.toContain('PRIVATE');
    expect(pkg).toMatchObject({ mode: 'SHARE', avatar: null, learned: null, credentials: [], containsCredentials: false });
    expect(pkg.agent).toMatchObject({ description: '', cadence: null, posting: null, models: [], tools: [], knowledge: [], capabilities: [], toolspace: [], plugins: [] });
    // Exact cross-repository fixture parity: adding a default or field cannot
    // silently widen Studio's public allowlist.
    expect({ ...pkg, exportedAt: publicFixture.exportedAt, exportedByVersion: publicFixture.exportedByVersion, checksum: publicFixture.checksum,
      agent: { ...pkg.agent, exportedAt: publicFixture.agent.exportedAt, exportedBy: publicFixture.agent.exportedBy } }).toEqual(publicFixture);
    expect(inspectPackage(serialisePackage(pkg))).toMatchObject({ valid: true, checksumOk: true, counts: { models: 0, tools: 0, knowledgeSources: 0, memories: 0, toolspace: 0, plugins: 0 } });
    if (process.env.PUBLIC_SHARE_EXPORT_PROOF) await writeFile(process.env.PUBLIC_SHARE_EXPORT_PROOF, serialisePackage(pkg));
  });

  it('serves the public profile only to its owner and uses the public filename', async () => {
    const f = await createFixture();
    const other = await createFixture();
    const app = await buildServer();
    try {
      const url = `/api/agents/${f.agentId}/package?mode=SHARE&publicAlias=Night%20Owl`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } })).json().data.token as string;
      expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await login(other.ownerEmail)}` } })).statusCode).toBe(403);
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await login(f.ownerEmail)}` } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toBe('attachment; filename="night-owl.ai17z-agent"');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().agent).toMatchObject({ name: 'Night Owl', tools: [], models: [], plugins: [] });
      expect(inspectPackage(response.body).valid).toBe(true);
    } finally { await app.close(); }
  });

  it('AC2 imports the public file with the existing importer, off and with no grants', async () => {
    const f = await createFixture();
    const pkg = await packAgent(f.agentId, 'SHARE', { publicAlias: 'Night Owl' } as never);
    const result = await unpackAgent({ ownerId: f.ownerId, raw: serialisePackage(pkg), createdBy: f.ownerId });
    const imported = await agents.getAgent(result.agentId);
    expect(imported?.name).toBe('Night Owl');
    expect(imported?.state).toBe('DRAFT');
    expect(await capabilityPermissions.listForAgent(result.agentId)).toEqual([]);
    expect((await ops.listAgentTools(result.agentId)).every(tool => !tool.enabled)).toBe(true);
    expect(await query('SELECT * FROM agent_accounts WHERE agent_id = $1', [result.agentId])).toEqual([]);
    expect(result.imported).toEqual({ memories: 0, avatar: false, credentials: 0 });
  });
});
