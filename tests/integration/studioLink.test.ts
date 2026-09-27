import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ops, plugins as pluginsRepo, query, studio as ledger } from '@xbam/database';
import { installPlugin, marketplaceGate, studioGatewayHeaders, studioStatus, LEASE_AUDIENCE, LEASE_TYPE } from '@xbam/runtime';
import { buildVersion, pluginCapabilityId, sealSecret } from '@xbam/shared';
import { getCapability, invokeCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { newInstallationKey } from '../../packages/runtime/src/studioJose';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * The Studio gate, inside a real registered capability, against the real
 * database. Studio itself is not here: what it says is a lease signed with a
 * key made for this test, which is exactly what core receives from it. That
 * the real Studio produces such a lease is proved separately, against the
 * running website, by `tools/studio-contract.mts`.
 */

const requests: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
const served = new Map<string, { status: number; text: string }>();
vi.mock('@xbam/upstream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xbam/upstream')>();
  return {
    ...actual,
    safeFetch: async (url: string, options: { headers?: Record<string, string>; body?: string }) => {
      requests.push({ url, headers: options.headers ?? {}, ...(options.body ? { body: options.body } : {}) });
      for (const [match, answer] of served) {
        if (url.includes(match)) return { status: answer.status, text: answer.text, url, headers: new Headers() };
      }
      throw new Error(`nothing served for ${url}`);
    },
  };
});

installHarness();

const ORIGIN = 'https://studio.example';
const INSTALLATION = '0b7d8f0e-0000-4000-8000-000000000001';
const core = buildVersion().version.replace(/-.*$/, '');
const json = (value: unknown) => JSON.stringify(value);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function manifest(id: string, url: string, host: string) {
  return json({
    schemaVersion: 1,
    id,
    name: `Probe ${id}`,
    summary: 'A Plugin used to prove the Studio gate.',
    publisher: 'AI17Z Test',
    version: '1.0.0',
    compatibility: { minimum: core },
    kind: 'HTTP_CAPABILITY',
    config: [],
    capabilities: [
      {
        name: 'read_thing',
        title: 'Read a thing',
        description: 'Reads one thing, for proving the Studio gate.',
        category: 'RESEARCH',
        effect: 'READ',
        risk: 'LOW',
        input: { fields: [{ name: 'what', type: 'string', required: true }] },
        output: { fields: [{ name: 'answer', type: 'string', from: 'answer' }] },
        http: { method: 'GET', url, hosts: [host], timeoutMs: 5_000, quotaPerHour: 50 },
      },
    ],
    features: [],
  });
}

const studioKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const studioPub = { kid: 'lease-test', kty: 'EC' as const, crv: 'P-256' as const, ...(studioKey.publicKey.export({ format: 'jwk' }) as { x: string; y: string }) };
const install = newInstallationKey();

function signLease(entitlements: unknown[], overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: LEASE_TYPE, kid: 'lease-test' })}.${b64({
    iss: ORIGIN,
    aud: LEASE_AUDIENCE,
    sub: INSTALLATION,
    jti: 'l1',
    iat: now - 10,
    exp: now + 3600,
    cnf: { jkt: install.thumbprint },
    entitlements,
    ...overrides,
  })}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: studioKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

async function link(lease: string | null) {
  await ops.setSetting('plugins.registry.url', ORIGIN);
  await ops.setSetting('studio.installation.key', sealSecret(json(install)));
  await ops.setSetting('studio.link', { installationId: INSTALLATION, origin: ORIGIN, linkedAt: new Date().toISOString(), revokedAt: null });
  await ops.setSetting('studio.lease.jwks', sealSecret(json({ origin: ORIGIN, keys: [studioPub] })));
  await ops.setSetting('studio.lease', lease ? { lease, syncedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 3600e3).toISOString() } : null);
}

const entry = async (id: string, overrides: Record<string, unknown> = {}) => {
  const record = await pluginsRepo.getInstalledPlugin(id);
  return {
    entitlement_id: 'e-1',
    plugin_id: id,
    revision: 1,
    usable: true,
    reason: null,
    delivery_mode: 'REGISTRY_MANIFEST',
    version: record!.version,
    manifest_sha256: record!.manifestSha256,
    capability_ids: [pluginCapabilityId(id, 'read_thing')],
    ...overrides,
  };
};

const run = (agentId: string, id: string) =>
  invokeCapability({
    call: { id: pluginCapabilityId(id, 'read_thing'), input: { what: 'x' } },
    context: { agentId, jobId: null, accountId: null, config: {}, logger: console as never },
    permission: { stored: 'ALLOWED', paused: false },
  });

beforeEach(async () => {
  served.clear();
  requests.length = 0;
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  for (const record of await pluginsRepo.listInstalledPlugins()) await pluginsRepo.removeInstalledPlugin(record.id);
  for (const key of ['studio.installation.key', 'studio.link', 'studio.lease.jwks', 'studio.lease', 'plugins.registry.url']) await ops.setSetting(key, null);
});

describe('the Studio gate on a marketplace Plugin', () => {
  it('runs only while a verified lease covers this exact version, and a free registry Plugin is untouched', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: manifest('paid-probe', 'https://api.probe.test/read?what={what}', 'api.probe.test'), source: 'AI17Z_REGISTRY', requiresEntitlement: true });
    await installPlugin({ raw: manifest('free-probe', 'https://free.probe.test/read?what={what}', 'free.probe.test'), source: 'AI17Z_REGISTRY' });
    served.set('api.probe.test', { status: 200, text: json({ answer: 'paid answer' }) });
    served.set('free.probe.test', { status: 200, text: json({ answer: 'free answer' }) });
    const ctx = { agentId: fixture.agentId } as never;
    const paid = getCapability(pluginCapabilityId('paid-probe', 'read_thing'))!;
    const free = getCapability(pluginCapabilityId('free-probe', 'read_thing'))!;

    // Not linked at all.
    expect((await paid.readiness!(ctx)).status).toBe('UNAVAILABLE');
    expect((await run(fixture.agentId, 'paid-probe')).outcome).not.toBe('SUCCEEDED');
    expect((await free.readiness!(ctx)).status).toBe('AVAILABLE');
    expect((await run(fixture.agentId, 'free-probe')).outcome).toBe('SUCCEEDED');

    // Linked, with a lease that covers it.
    await link(signLease([await entry('paid-probe')]));
    expect((await paid.readiness!(ctx)).status).toBe('AVAILABLE');
    const ran = await run(fixture.agentId, 'paid-probe');
    expect(ran.outcome).toBe('SUCCEEDED');
    expect(json(ran.output)).toContain('paid answer');

    // A lease for another seat, another version, or a revoked entitlement.
    for (const variant of [{ usable: false, reason: 'NO_SEAT_FOR_THIS_INSTALLATION' }, { version: '9.9.9' }, { usable: false, reason: 'ENTITLEMENT_REVOKED' }]) {
      await link(signLease([await entry('paid-probe', variant)]));
      const verdict = await paid.readiness!(ctx);
      expect(verdict.status).toBe('UNAVAILABLE');
      expect((await run(fixture.agentId, 'paid-probe')).outcome).not.toBe('SUCCEEDED');
    }
  });

  it('refuses a lease edited in the database, and one past its horizon, while everything else keeps working', async () => {
    const fixture = await createFixture();
    await installPlugin({ raw: manifest('paid-probe', 'https://api.probe.test/read?what={what}', 'api.probe.test'), source: 'AI17Z_REGISTRY', requiresEntitlement: true });
    await installPlugin({ raw: manifest('local-probe', 'https://local.probe.test/read?what={what}', 'local.probe.test'), source: 'LOCAL' });
    served.set('local.probe.test', { status: 200, text: json({ answer: 'local' }) });
    const ctx = { agentId: fixture.agentId } as never;
    const paid = getCapability(pluginCapabilityId('paid-probe', 'read_thing'))!;

    // Somebody rewrites the stored lease to say what they would like it to say.
    const genuine = signLease([await entry('paid-probe', { usable: false, reason: 'NO_SEAT_FOR_THIS_INSTALLATION', capability_ids: [] })]);
    const [h, , s] = genuine.split('.');
    const forged = `${h}.${b64({ iss: ORIGIN, aud: LEASE_AUDIENCE, sub: INSTALLATION, jti: 'f', iat: 1, exp: 9_999_999_999, cnf: { jkt: install.thumbprint }, entitlements: [await entry('paid-probe')] })}.${s}`;
    await link(forged);
    expect((await paid.readiness!(ctx)).status).toBe('UNAVAILABLE');

    // Or swaps in a pinned key of their own: the lease was still signed by Studio's.
    const theirs = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await link(signLease([await entry('paid-probe')]));
    await ops.setSetting(
      'studio.lease.jwks',
      json({ origin: ORIGIN, keys: [{ ...studioPub, ...(theirs.publicKey.export({ format: 'jwk' }) as object) }] }),
    );
    expect((await paid.readiness!(ctx)).status).toBe('UNAVAILABLE');

    // Offline past the lease: marketplace pauses, nothing else does.
    await link(signLease([await entry('paid-probe')], { exp: Math.floor(Date.now() / 1000) - 1 }));
    const expired = await paid.readiness!(ctx);
    expect(expired.status).toBe('UNAVAILABLE');
    expect(expired.why).toMatch(/nothing else is affected/);
    expect((await run(fixture.agentId, 'local-probe')).outcome).toBe('SUCCEEDED');
    expect((await getCapability('time.now')!.readiness?.(ctx))?.status ?? 'AVAILABLE').toBe('AVAILABLE');
  });

  it("governs anything that reaches Studio's gateway, however it was installed, and sends the credentials only there", async () => {
    const fixture = await createFixture();
    const gatewayUrl = `${ORIGIN}/api/gateway/v1/hosted-probe/read_thing?what={what}`;
    await installPlugin({ raw: manifest('hosted-probe', gatewayUrl, 'studio.example'), source: 'LOCAL' });
    const ctx = { agentId: fixture.agentId } as never;
    const hosted = getCapability(pluginCapabilityId('hosted-probe', 'read_thing'))!;
    await ops.setSetting('plugins.registry.url', ORIGIN);
    expect((await hosted.readiness!(ctx)).status).toBe('UNAVAILABLE');

    await link(signLease([await entry('hosted-probe')]));
    served.set('/api/v1/token', { status: 200, text: json({ access_token: 'at-1', token_type: 'DPoP', expires_in: 600, installation_id: INSTALLATION }) });
    served.set('/api/v1/tool-authorizations', { status: 200, text: json({ tool_token: 'tt-1', token_type: 'DPoP', expires_in: 300 }) });
    served.set('/api/gateway/v1/hosted-probe/read_thing', { status: 200, text: json({ result: { answer: 'hosted answer' }, provenance: { via: 'ai17z-studio-gateway' } }) });
    const ran = await run(fixture.agentId, 'hosted-probe');
    expect(ran.outcome).toBe('SUCCEEDED');
    expect(JSON.stringify(ran.output)).toContain('hosted answer');
    const call = requests.find((r) => r.url.includes('/api/gateway/v1/'))!;
    expect(call.headers.authorization).toBe('DPoP tt-1');
    const proof = JSON.parse(Buffer.from(call.headers.dpop!.split('.')[1]!, 'base64url').toString());
    expect(proof).toMatchObject({ htm: 'GET', htu: `${ORIGIN}/api/gateway/v1/hosted-probe/read_thing` });
    expect(Object.values(call.headers).join(' ')).not.toMatch(/"d":/);

    const elsewhere = await studioGatewayHeaders('hosted-probe', 'read_thing', 'https://evil.example/api/gateway/v1/x/y', 'GET');
    expect(elsewhere.ok).toBe(false);
    const offPath = await studioGatewayHeaders('hosted-probe', 'read_thing', `${ORIGIN}/api/v1/installation/revoke`, 'GET');
    expect(offPath.ok).toBe(false);
  });

  it('shows the owner what the lease says and never the key', async () => {
    await installPlugin({ raw: manifest('paid-probe', 'https://api.probe.test/read?what={what}', 'api.probe.test'), source: 'AI17Z_REGISTRY', requiresEntitlement: true });
    await link(signLease([await entry('paid-probe')]));
    const status = await studioStatus();
    expect(status.state).toBe('LINKED');
    expect(status.lease).toMatchObject({ ok: true, entitlements: [expect.objectContaining({ plugin_id: 'paid-probe', usable: true })] });
    const shown = json(status);
    expect(shown).not.toContain(install.thumbprint);
    expect(shown).not.toMatch(/"d":|privateJwk|BEGIN/);
    expect((await marketplaceGate({ id: 'x', version: '1', manifestSha256: 'a'.repeat(64), requiresEntitlement: false, hosts: ['other.test'] }, 'c')).ok).toBe(true);
  });
});

describe('the local purchase ledger', () => {
  const terms = {
    intentId: '6b1f2a0e-1c1d-4c2e-9f00-0123456789ab',
    pluginId: 'weather-pro',
    pluginName: 'Weather Pro',
    chainId: 4663,
    tokenAddress: '0x16cb7cbb26295b60df7f4b3b39a99a9a3c585e81',
    payerAddress: '0x1111111111111111111111111111111111111111',
    recipientAddress: '0x2222222222222222222222222222222222222222',
    amountBaseUnits: '250500000000000000000',
  };
  const hash = `0x${'ab'.repeat(32)}`;

  it('lets the wallet be asked once, however many times the button is pressed at once', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ledger.claimPrepare(terms)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await ledger.claimPrepare(terms)).ok).toBe(false);
  });

  it('never prepares a purchase again once a transaction is known, and only a person can say nothing was sent', async () => {
    expect((await ledger.claimPrepare(terms)).ok).toBe(true);
    expect((await ledger.markAbandoned(terms.intentId)).ok).toBe(true);
    expect((await ledger.claimPrepare(terms)).ok).toBe(true);
    expect((await ledger.markSent(terms.intentId, hash)).ok).toBe(true);
    expect((await ledger.markSent(terms.intentId, hash)).ok).toBe(true);
    expect((await ledger.markSent(terms.intentId, `0x${'cd'.repeat(32)}`)).ok).toBe(false);
    expect((await ledger.markAbandoned(terms.intentId)).ok).toBe(false);
    const again = await ledger.claimPrepare(terms);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.why).toMatch(/will not be paid again/);
  });

  it('refuses terms that changed, and a stored record cannot be edited into different ones', async () => {
    expect((await ledger.claimPrepare(terms)).ok).toBe(true);
    await ledger.markAbandoned(terms.intentId);
    const moved = await ledger.claimPrepare({ ...terms, recipientAddress: '0x3333333333333333333333333333333333333333' });
    expect(moved.ok).toBe(false);
    await expect(query(`UPDATE studio_purchase_ledger SET amount_base_units = 1 WHERE intent_id = $1`, [terms.intentId])).rejects.toThrow(/frozen/);
    await expect(query(`DELETE FROM studio_purchase_ledger WHERE intent_id = $1`, [terms.intentId])).rejects.toThrow(/cannot be deleted/);
  });

  it('settles from what Studio says', async () => {
    await ledger.claimPrepare(terms);
    await ledger.markSent(terms.intentId, hash);
    await ledger.noteStudioStatus(terms.intentId, 'CONFIRMED', null);
    expect(await ledger.getPurchase(terms.intentId)).toMatchObject({ state: 'CONFIRMED', studioStatus: 'CONFIRMED', txHash: hash });
  });
});
