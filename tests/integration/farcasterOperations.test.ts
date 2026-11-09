import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { accounts, channelState, farcasterSigners, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { TEST_SIGNER, fakeFarcaster } from '../support/fakeFarcaster';

installHarness();
let app: FastifyInstance;
beforeAll(async () => { app = await buildServer(); await app.ready(); });
afterAll(async () => { await app?.close(); });
afterEach(() => vi.unstubAllGlobals());
async function login(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  return { authorization: `Bearer ${response.json().data.token as string}` };
}
async function setup() {
  const hub = fakeFarcaster();
  const fixture = await createFixture();
  const headers = await login(fixture.ownerEmail);
  const response = await app.inject({ method: 'POST', url: '/api/accounts', headers,
    payload: { channel: 'farcaster', handle: 'fid:11', remoteAccountId: '11', settings: { farcaster: { hubUrl: 'https://hub.example.test' } } } });
  expect(response.statusCode, response.body).toBe(200);
  return { hub, fixture, headers, id: response.json().data.id as string };
}

describe('owner-managed Farcaster signer', () => {
  it('stores and connects through the owner route, returning only presence', async () => {
    const { id, headers, hub } = await setup();
    const saved = await app.inject({ method: 'PUT', url: `/api/accounts/${id}/farcaster/signer`, headers,
      payload: { signerKey: TEST_SIGNER } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toEqual({ hasSigner: true });
    const listed = await app.inject({ method: 'GET', url: '/api/accounts', headers });
    expect(listed.body).not.toContain(TEST_SIGNER);
    expect((await accounts.requireAccount(id)).status).toBe('CONNECTED');
    expect(hub.submitted).toHaveLength(0);
    const [audit] = await query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events WHERE data::text LIKE $1', [`%${TEST_SIGNER}%`]);
    expect(audit!.n).toBe(0);
  });

  it('refuses another owner for all signer operations', async () => {
    const { id } = await setup();
    const stranger = await createFixture();
    const headers = await login(stranger.ownerEmail);
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const response = await app.inject({ method, url: `/api/accounts/${id}/farcaster/signer`, headers,
        ...(method === 'PUT' ? { payload: { signerKey: TEST_SIGNER } } : {}) });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(TEST_SIGNER);
    }
    expect(await farcasterSigners.signerPresence(id)).toEqual({ hasSigner: false });
  });

  it('clears the signer on disconnect and cannot reconnect without explicit authorization', async () => {
    const { id, headers } = await setup();
    await farcasterSigners.setSigner(id, TEST_SIGNER);
    const response = await app.inject({ method: 'POST', url: `/api/accounts/${id}/disconnect`, headers });
    expect(response.statusCode).toBe(200);
    expect(await farcasterSigners.signerPresence(id)).toEqual({ hasSigner: false });
    const reconnect = await app.inject({ method: 'POST', url: `/api/accounts/${id}/reconnect`, headers });
    expect(reconnect.statusCode).toBe(200);
    expect(reconnect.json().data.status).toBe('NEEDS_AUTH');
  });

  it('rejects secret-shaped public settings and credential-bearing node URLs', async () => {
    const { headers } = await setup();
    for (const settings of [
      { farcaster: { hubUrl: 'https://hub.example.test', signerKey: TEST_SIGNER } },
      { farcaster: { hubUrl: 'https://user:password@hub.example.test' } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/accounts', headers,
        payload: { channel: 'farcaster', handle: 'another', remoteAccountId: '12', settings } });
      expect(response.statusCode).toBe(422);
      expect(response.body).not.toContain(TEST_SIGNER);
    }
  });

  it('does not undo an owner disconnect when an earlier validation finishes late', async () => {
    const { id, headers, hub } = await setup();
    const gate = hub.holdValidation();
    const connecting = app.inject({ method: 'PUT', url: `/api/accounts/${id}/farcaster/signer`, headers,
      payload: { signerKey: TEST_SIGNER } });
    const finished = connecting.then((response) => response);
    await gate.entered;
    try {
      const disconnected = await app.inject({ method: 'POST', url: `/api/accounts/${id}/disconnect`, headers });
      expect(disconnected.statusCode).toBe(200);
    } finally { gate.release(); }
    await finished;
    expect((await accounts.requireAccount(id)).status).toBe('DISCONNECTED');
    expect(await farcasterSigners.signerPresence(id)).toEqual({ hasSigner: false });
  });

  it('invalidates a pending validation and its node cursor when the owner changes nodes', async () => {
    const { id, headers, hub } = await setup();
    const state = await channelState.pollState(id);
    await channelState.advancePoll(id, state.version, 'old-node-token');
    const saved = await channelState.pollState(id);
    const gate = hub.holdValidation();
    const finished = app.inject({ method: 'PUT', url: `/api/accounts/${id}/farcaster/signer`, headers,
      payload: { signerKey: TEST_SIGNER } }).then((response) => response);
    await gate.entered;
    try {
      const updated = await app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, headers,
        payload: { settings: { farcaster: { hubUrl: 'https://new-node.example.test' } } } });
      expect(updated.statusCode, updated.body).toBe(200);
    } finally { gate.release(); }
    await finished;
    expect((await accounts.requireAccount(id)).status).toBe('DISCONNECTED');
    expect((await channelState.pollState(id)).cursor).toBeNull();
    expect(await channelState.advancePoll(id, saved.version, 'late-old-node-token')).toBe(false);
  });

  it('keeps a newer connection attempt when an earlier validation finishes', async () => {
    const { id, headers, hub } = await setup();
    const gate = hub.holdValidation();
    const finished = app.inject({ method: 'PUT', url: `/api/accounts/${id}/farcaster/signer`, headers,
      payload: { signerKey: TEST_SIGNER } }).then((response) => response);
    await gate.entered;
    await farcasterSigners.setSigner(id, '02'.repeat(32));
    gate.release();
    await finished;
    expect((await accounts.requireAccount(id)).status).toBe('DISCONNECTED');
    expect(await farcasterSigners.getDecryptedSigner(id)).toBe('02'.repeat(32));
    const reconnect = await app.inject({ method: 'POST', url: `/api/accounts/${id}/reconnect`, headers });
    expect(reconnect.json().data.status).toBe('CONNECTED');
  });
});
