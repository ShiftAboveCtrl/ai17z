import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ops, studio as ledger } from '@xbam/database';
import {
  beginStudioLink,
  disconnectStudio,
  installFromRegistry,
  pollStudioLink,
  prepareStudioPurchase,
  recordStudioPurchaseSent,
  registryCatalog,
  studioPurchases,
  studioStatus,
  syncStudio,
  UNSAFE_DEV_ORIGIN_ENV,
} from '@xbam/runtime';
import { pluginCapabilityId } from '@xbam/shared';
import { AI17Z_PAYMENT, decodeTransfer } from '@xbam/shared/contracts';
import { getCapability, invokeCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { dpopProof, type InstallationKey } from '../../packages/runtime/src/studioJose';
import { openSecret } from '@xbam/shared';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

/**
 * AI17Z core against AI17Z Studio, both real.
 *
 * Nothing on either side is mocked. Studio is the website's own code running
 * as a server on this machine against a throwaway database; core is this
 * repository's connector, speaking to it over HTTP with real keys, real DPoP
 * proofs, real signed leases and real gateway calls, which reach a real public
 * echo service on the far side of the gateway. The one thing not done is
 * spending money: the purchase is prepared, checked, and reported with a hash
 * no chain has seen, which Studio records and grants nothing for.
 *
 * Run by `node tools/studio-contract.mts <path to ai17z-studio>`, which starts
 * Studio, prepares its database and sets STUDIO_CONTRACT_URL. Without it this
 * file skips and says so, as the real Chrome test does: it proves nothing
 * where Studio is not running, and must not look as though it passed.
 */

const URL_ = process.env.STUDIO_CONTRACT_URL;
const DIR = process.env.STUDIO_CONTRACT_DIR;
const ENV_FILE = process.env.STUDIO_CONTRACT_ENV;
const run = URL_ && DIR && ENV_FILE ? describe : describe.skip;
if (!URL_) {
  console.warn('studioContract: SKIPPED. Run node tools/studio-contract.mts <studio dir> to prove core against a running Studio.');
}

installHarness();

function fixture(...args: string[]): Record<string, any> {
  const env = { ...process.env, ...(JSON.parse(readFileSync(ENV_FILE!, 'utf8')) as Record<string, string>) };
  const out = spawnSync(process.execPath, [join(DIR!, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/contract/fixture.ts', ...args], {
    cwd: DIR,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = out.stdout.trim().split('\n').pop() ?? '';
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(line) as Record<string, any>;
  } catch {
    throw new Error(`fixture ${args[0]} printed no JSON: ${out.stdout}\n${out.stderr}`);
  }
  if (parsed.ok === false) throw new Error(`fixture ${args[0]} failed: ${parsed.error}`);
  return parsed;
}

async function linkAs(replaces: string | null = null) {
  const started = await beginStudioLink({ replacePrevious: replaces !== null });
  if (!started.ok) throw new Error(started.why);
  expect(started.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  expect((await pollStudioLink()).state).toBe('PENDING');
  fixture('approve', started.userCode, ...(replaces ? [replaces] : []));
  const done = await pollStudioLink();
  expect(done.state).toBe('LINKED');
  return (done as { installationId: string }).installationId;
}

const invoke = (agentId: string, id: string, input: Record<string, unknown>) =>
  invokeCapability({
    call: { id, input },
    context: { agentId, jobId: null, accountId: null, config: {}, logger: console as never },
    permission: { stored: 'ALLOWED', paused: false },
  });

run('AI17Z core against a running AI17Z Studio', () => {
  let setup: Record<string, any>;
  let agentId: string;

  beforeAll(async () => {
    process.env[UNSAFE_DEV_ORIGIN_ENV] = URL_;
    resetCapabilitiesForTest();
    registerBuiltinCapabilities();
    setup = fixture('setup');
  }, 180_000);

  it('links with a one-time code, verifies the signed lease, installs, runs, loses and regains a Plugin, and completes a purchase up to the wallet', async () => {
    // Made here: the harness empties the database before each test, after beforeAll.
    agentId = (await createFixture()).agentId;

    // Linking: device code, owner approval on Studio, DPoP token, pinned keys, first sync.
    const first = await linkAs();
    let status = await studioStatus();
    expect(status).toMatchObject({ state: 'LINKED', unsafeDev: true, installationId: first });
    expect(status.lease).toMatchObject({ ok: true, entitlements: [] });

    // The catalogue is public and every Plugin is entitled; the manifest is not served without a seat.
    const catalog = await registryCatalog();
    expect(catalog.ok && catalog.plugins.map((p) => p.id).sort()).toEqual(['contract-free', 'contract-hosted', 'contract-paid']);
    expect(catalog.ok && catalog.plugins.every((p) => p.entitled)).toBe(true);
    const refused = await installFromRegistry('contract-free');
    expect(refused.ok).toBe(false);

    // A free Plugin: acquired and seated on Studio, installed over DPoP, allowed by the lease, run for real.
    fixture('acquire', 'contract-free', first);
    expect((await installFromRegistry('contract-free')).ok).toBe(true);
    expect((await syncStudio()).ok).toBe(true);
    const freeId = pluginCapabilityId('contract-free', 'read_echo');
    const free = await invoke(agentId, freeId, { q: 'hello-from-core' });
    expect(free.outcome, free.detail).toBe('SUCCEEDED');
    expect(JSON.stringify(free.output)).toContain('hello-from-core');

    // A hosted Plugin: every call goes through Studio's gateway with a tool token and a proof.
    fixture('acquire', 'contract-hosted', first);
    expect((await installFromRegistry('contract-hosted')).ok).toBe(true);
    expect((await syncStudio()).ok).toBe(true);
    const hostedId = pluginCapabilityId('contract-hosted', 'echo_thing');
    const hosted = await invoke(agentId, hostedId, { query: 'through-the-gateway' });
    expect(hosted.outcome, hosted.detail).toBe('SUCCEEDED');
    expect(JSON.stringify(hosted.output)).toContain('through-the-gateway');

    // Revoked on Studio: the next sync signs it unusable, and both the gate and the gateway refuse it.
    fixture('revoke-entitlement', 'contract-hosted');
    expect((await syncStudio()).ok).toBe(true);
    expect((await getCapability(hostedId)!.readiness!({ agentId } as never)).status).toBe('UNAVAILABLE');
    expect((await invoke(agentId, hostedId, { query: 'after-revoke' })).outcome).not.toBe('SUCCEEDED');

    // Bypass attempts against the real server, with this installation's real key.
    const key = JSON.parse(openSecret((await ops.getSetting<string>('studio.installation.key'))!)) as InstallationKey;
    const tokenProof = dpopProof(key, 'POST', `${URL_}/api/v1/token`);
    const token = await fetch(`${URL_}/api/v1/token`, {
      method: 'POST',
      headers: { dpop: tokenProof, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aai17z%3Aparams%3Aoauth%3Agrant-type%3Ainstallation-key',
    }).then((r) => r.json() as Promise<{ access_token: string }>);
    const replay = await fetch(`${URL_}/api/v1/token`, {
      method: 'POST',
      headers: { dpop: tokenProof, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aai17z%3Aparams%3Aoauth%3Agrant-type%3Ainstallation-key',
    });
    expect(replay.status).toBe(400);
    const asBearer = await fetch(`${URL_}/api/v1/installation/entitlements`, { headers: { authorization: `Bearer ${token.access_token}` } });
    expect(asBearer.status).toBe(401);
    const wrongUrl = await fetch(`${URL_}/api/v1/installation/entitlements`, {
      headers: { authorization: `DPoP ${token.access_token}`, dpop: dpopProof(key, 'GET', `${URL_}/api/v1/installation/purchases`, token.access_token) },
    });
    expect(wrongUrl.status).toBe(400);

    // A purchase started on Studio for this installation, completed here up to the wallet.
    const intent = fixture('intent', 'contract-paid', first);
    const listed = await studioPurchases();
    expect(listed.ok && listed.purchases.map((p) => p.intent_id)).toContain(intent.intentId);
    const prepared = await prepareStudioPurchase(intent.intentId);
    if (!prepared.ok) throw new Error(prepared.why);
    expect(prepared.purchase.transaction).toMatchObject({ to: AI17Z_PAYMENT.token, from: setup.payer, value: '0x0' });
    expect(decodeTransfer(prepared.purchase.transaction.data)).toEqual({ recipient: setup.payout, amountBaseUnits: '1000000000000000000' });
    expect((await prepareStudioPurchase(intent.intentId)).ok).toBe(false);
    const unseenHash = `0x${'5a'.repeat(32)}`;
    const reported = await recordStudioPurchaseSent(intent.intentId, unseenHash);
    expect(reported.ok).toBe(true);
    expect(fixture('intent-status', intent.intentId)).toMatchObject({ txHash: unseenHash });
    expect(['SUBMITTED', 'FAILED']).toContain(fixture('intent-status', intent.intentId).status);
    expect(await ledger.getPurchase(intent.intentId)).toMatchObject({ state: 'SENT', txHash: unseenHash });

    // Disconnect, then relink as the replacement: Studio is told, the old key stops, the seat comes across.
    const gone = await disconnectStudio();
    expect(gone.studioTold).toBe(true);
    const second = await linkAs(first);
    expect(second).not.toBe(first);
    const listedInstalls = fixture('installations').installations as Array<{ id: string; state: string; replaces: string | null; seats: number }>;
    expect(listedInstalls.find((i) => i.id === first)).toMatchObject({ state: 'REVOKED', seats: 0 });
    expect(listedInstalls.find((i) => i.id === second)).toMatchObject({ state: 'ACTIVE', replaces: first, seats: 1 });
    expect((await syncStudio()).ok).toBe(true);
    expect((await invoke(agentId, freeId, { q: 'after-relink' })).outcome).toBe('SUCCEEDED');

    // Revoked from the website: the installation learns it on its next conversation, and stops.
    fixture('revoke-installation', second);
    expect((await syncStudio()).ok).toBe(false);
    status = await studioStatus();
    expect(status.state).toBe('REVOKED');
    expect((await getCapability(freeId)!.readiness!({ agentId } as never)).status).toBe('UNAVAILABLE');
    expect((await getCapability('time.now'))).not.toBeNull();
  }, 300_000);
});
