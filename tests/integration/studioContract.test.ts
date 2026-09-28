import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ops, plugins as installedPlugins, studio as ledger } from '@xbam/database';
import {
  beginStudioLink,
  disconnectStudio,
  installFromRegistry,
  pollStudioLink,
  prepareStudioPurchase,
  capabilitySettings,
  runCapabilityLoop,
  setPluginEnabled,
  recordStudioPurchaseSent,
  registryCatalog,
  reviewStudioPurchase,
  setPaymentRpcForTests,
  studioLinkWallet,
  studioWalletChallenge,
  studioWallets,
  studioPurchases,
  studioStatus,
  syncStudio,
  UNSAFE_DEV_ORIGIN_ENV,
} from '@xbam/runtime';
import { pluginCapabilityId } from '@xbam/shared';
import { AI17Z_PAYMENT, decodeTransfer, isExactPurchaseTransaction } from '@xbam/shared/contracts';
import { getCapability, invokeCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { dpopProof, type InstallationKey } from '../../packages/runtime/src/studioJose';
import { openSecret } from '@xbam/shared';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { FakeChain } from '../support/fakeChain';

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

/**
 * Runs one Studio fixture command. Asynchronous on purpose: Studio reads the
 * stand-in chain this process hosts, and a synchronous child would hold this
 * process's event loop while Studio waited on it.
 */
async function fixture(...args: string[]): Promise<Record<string, any>> {
  const env = { ...process.env, ...(JSON.parse(readFileSync(ENV_FILE!, 'utf8')) as Record<string, string>) };
  const out = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [join(DIR!, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'tests/contract/fixture.ts', ...args],
      { cwd: DIR, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      // A failing command still prints its JSON, which is read below.
      (_error, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr) }),
    );
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
  await fixture('approve', started.userCode, ...(replaces ? [replaces] : []));
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

  // Studio was started reading this stand-in chain; every checkout touches it, even one never paid.
  const chain = new FakeChain(8547, {
    poolId: '0x67a9703b571d37bfab8d864bcdff9f3508d19eef6929d21301a3692a7be5b346',
    token: AI17Z_PAYMENT.tokenChecksum,
    // 10,000,000 AI17Z per ETH, as DexScreener states it: ETH per AI17Z.
    priceNative: '0.0000001',
  });
  afterAll(() => chain.stop());

  beforeAll(async () => {
    await chain.start();
    process.env[UNSAFE_DEV_ORIGIN_ENV] = URL_;
    resetCapabilitiesForTest();
    registerBuiltinCapabilities();
    setup = await fixture('setup');
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
    expect(catalog.ok && catalog.plugins.map((p) => p.id).sort()).toEqual([
      'contract-free',
      'contract-hosted',
      'contract-monthly',
      'contract-onetime',
      'contract-paid',
      'contract-proprietary',
      'contract-yearly',
    ]);
    expect(catalog.ok && catalog.plugins.every((p) => p.entitled)).toBe(true);
    const refused = await installFromRegistry('contract-free');
    expect(refused.ok).toBe(false);

    // A free Plugin: acquired and seated on Studio, installed over DPoP, allowed by the lease, run for real.
    await fixture('acquire', 'contract-free', first);
    expect((await installFromRegistry('contract-free')).ok).toBe(true);
    expect((await syncStudio()).ok).toBe(true);
    const freeId = pluginCapabilityId('contract-free', 'read_echo');
    const free = await invoke(agentId, freeId, { q: 'hello-from-core' });
    expect(free.outcome, free.detail).toBe('SUCCEEDED');
    expect(JSON.stringify(free.output)).toContain('hello-from-core');

    // A hosted Plugin: every call goes through Studio's gateway with a tool token and a proof.
    await fixture('acquire', 'contract-hosted', first);
    expect((await installFromRegistry('contract-hosted')).ok).toBe(true);
    expect((await syncStudio()).ok).toBe(true);
    const hostedId = pluginCapabilityId('contract-hosted', 'echo_thing');
    const hosted = await invoke(agentId, hostedId, { query: 'through-the-gateway' });
    expect(hosted.outcome, hosted.detail).toBe('SUCCEEDED');
    expect(JSON.stringify(hosted.output)).toContain('through-the-gateway');

    // Revoked on Studio: the next sync signs it unusable, and both the gate and the gateway refuse it.
    await fixture('revoke-entitlement', 'contract-hosted');
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

    // Linking a wallet from inside AI17Z, through the same Studio challenge.
    // The key lives in the Studio fixture, which has a wallet library; core has none and needs none.
    const localWallet = await fixture('wallet-new') as { address: string; privateKey: string };
    const challenge = await studioWalletChallenge(localWallet.address);
    if (!challenge.ok) throw new Error(challenge.why);
    const { signature } = await fixture('sign', localWallet.privateKey, Buffer.from(challenge.message).toString('base64'));
    expect((await studioLinkWallet(challenge.challengeId, signature)).ok).toBe(true);
    const wallets = await studioWallets();
    expect(wallets.ok && wallets.wallets.map((w) => w.address)).toContain(localWallet.address.toLowerCase());

    // A purchase started on Studio for this installation, completed here up to the wallet.
    const intent = await fixture('intent', 'contract-paid', first);
    const listed = await studioPurchases();
    expect(listed.ok && listed.purchases.map((p) => p.intent_id)).toContain(intent.intentId);
    // Against the real chain: the fixture's wallet holds nothing, so the
    // preflight refuses and the wallet is never asked.
    const refusedByChain = await prepareStudioPurchase(intent.intentId);
    expect(refusedByChain.ok).toBe(false);
    if (!refusedByChain.ok) expect(refusedByChain.why).toMatch(/Balance/);
    const reviewed = await reviewStudioPurchase(intent.intentId);
    expect(reviewed.ok && reviewed.preflight.checks.find((c) => c.name === 'Chain')?.ok).toBe(true);
    expect(reviewed.ok && reviewed.preflight.checks.find((c) => c.name === 'Token decimals')?.ok).toBe(true);
    // From here a stand-in chain that agrees, so the rest of the path runs.
    setPaymentRpcForTests(async (method, params) => {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_estimateGas') return '0xc350';
      if (method === 'eth_getBalance') return '0x1';
      const data = (params[0] as { data: string }).data;
      if (data === '0x313ce567') return `0x${'12'.padStart(64, '0')}`;
      if (data === '0x95d89b41') return `0x${'20'.padStart(64, '0')}${'5'.padStart(64, '0')}${Buffer.from('ai17z').toString('hex').padEnd(64, '0')}`;
      return `0x${(10n ** 21n).toString(16).padStart(64, '0')}`;
    });
    const prepared = await prepareStudioPurchase(intent.intentId);
    setPaymentRpcForTests(null);
    if (!prepared.ok) throw new Error(prepared.why);
    expect(prepared.purchase.transaction).toMatchObject({ to: AI17Z_PAYMENT.token, from: setup.payer, value: '0x0' });
    expect(decodeTransfer(prepared.purchase.transaction.data)).toEqual({ recipient: setup.payout, amountBaseUnits: '1000000000000000000' });
    expect((await prepareStudioPurchase(intent.intentId)).ok).toBe(false);
    const unseenHash = `0x${'5a'.repeat(32)}`;
    const reported = await recordStudioPurchaseSent(intent.intentId, unseenHash);
    expect(reported.ok).toBe(true);
    expect(await fixture('intent-status', intent.intentId)).toMatchObject({ txHash: unseenHash });
    expect(['SUBMITTED', 'FAILED']).toContain((await fixture('intent-status', intent.intentId)).status);
    expect(await ledger.getPurchase(intent.intentId)).toMatchObject({ state: 'SENT', txHash: unseenHash });

    // Disconnect, then relink as the replacement: Studio is told, the old key stops, the seat comes across.
    const gone = await disconnectStudio();
    expect(gone.studioTold).toBe(true);
    const second = await linkAs(first);
    expect(second).not.toBe(first);
    const listedInstalls = (await fixture('installations')).installations as Array<{ id: string; state: string; replaces: string | null; seats: number }>;
    expect(listedInstalls.find((i) => i.id === first)).toMatchObject({ state: 'REVOKED', seats: 0 });
    expect(listedInstalls.find((i) => i.id === second)).toMatchObject({ state: 'ACTIVE', replaces: first, seats: 1 });
    expect((await syncStudio()).ok).toBe(true);
    expect((await invoke(agentId, freeId, { q: 'after-relink' })).outcome).toBe('SUCCEEDED');

    // Revoked from the website: the installation learns it on its next conversation, and stops.
    await fixture('revoke-installation', second);
    expect((await syncStudio()).ok).toBe(false);
    status = await studioStatus();
    expect(status.state).toBe('REVOKED');
    expect((await getCapability(freeId)!.readiness!({ agentId } as never)).status).toBe('UNAVAILABLE');
    expect((await getCapability('time.now'))).not.toBeNull();
  }, 300_000);
  it('sells one-time, monthly and yearly plans in ETH and AI17Z, finishes a half-paid checkout, lapses and renews a subscription, and keeps a proprietary backend behind the gateway', async () => {
    agentId = (await createFixture()).agentId;
    const installation = await linkAs();
    let backend: ChildProcess | null = null;
    try {
      // What a wallet would be told by the chain before it is asked; the payment itself goes to the stand-in chain.
      setPaymentRpcForTests(async (method, params) => {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_estimateGas') return '0x5208';
        if (method === 'eth_getBalance') return `0x${(10n ** 20n).toString(16)}`;
        const data = (params[0] as { data: string }).data;
        if (data === '0x313ce567') return `0x${'12'.padStart(64, '0')}`;
        if (data === '0x95d89b41') return `0x${'20'.padStart(64, '0')}${'5'.padStart(64, '0')}${Buffer.from('ai17z').toString('hex').padEnd(64, '0')}`;
        return `0x${(10n ** 30n).toString(16).padStart(64, '0')}`;
      });
      let nonce = 0;
      /** Prepares one leg exactly as for the wallet, puts that transaction on the chain, and reports it. */
      const payLeg = async (intentId: string, legIndex: number) => {
        const prepared = await prepareStudioPurchase(intentId, legIndex);
        if (!prepared.ok) throw new Error(prepared.why);
        expect(isExactPurchaseTransaction(prepared.purchase)).toBe(true);
        const hash = `0x${(++nonce).toString(16).padStart(64, '0')}`;
        chain.mine(hash, prepared.purchase.transaction);
        const reported = await recordStudioPurchaseSent(intentId, hash, legIndex);
        if (!reported.ok) throw new Error(reported.why);
        return { prepared: prepared.purchase, hash, studioStatus: reported.studioStatus };
      };
      const buy = async (slug: string, asset: 'ETH' | 'AI17Z') => {
        const intent = await fixture('intent', slug, installation, asset) as { intentId: string; kind: string; legs: Array<{ legIndex: number; role: string; asset: string; recipient: string; amount: string }> };
        for (const leg of intent.legs) await payLeg(intent.intentId, leg.legIndex);
        expect((await fixture('reconcile', intent.intentId)).status).toBe('CONFIRMED');
        return intent;
      };

      // One-time, in ETH, two plain transfers: 92% to the publisher and 8% to the treasury.
      const onetime = await fixture('intent', 'contract-onetime', installation, 'ETH') as { intentId: string; legs: Array<{ legIndex: number; role: string; recipient: string; amount: string }> };
      expect(onetime.legs).toEqual([
        { legIndex: 0, role: 'PUBLISHER', asset: 'ETH', recipient: setup.payout, amount: '9200000000000000' },
        { legIndex: 1, role: 'TREASURY', asset: 'ETH', recipient: setup.ethTreasury, amount: '800000000000000' },
      ]);
      const first = await payLeg(onetime.intentId, 0);
      expect(first.prepared.transaction).toEqual({ from: setup.payer, to: setup.payout, data: '0x', value: '0x20af59ebef0000' });
      // Half paid: nothing is granted, and the paid half is never asked for again.
      expect((await fixture('reconcile', onetime.intentId)).status).toBe('PARTIALLY_PAID');
      expect((await installFromRegistry('contract-onetime')).ok).toBe(false);
      const again = await prepareStudioPurchase(onetime.intentId, 0);
      expect(again.ok).toBe(false);
      await payLeg(onetime.intentId, 1);
      expect((await fixture('reconcile', onetime.intentId)).status).toBe('CONFIRMED');
      expect(await fixture('entitlement', 'contract-onetime')).toMatchObject({ billingMode: 'ONE_TIME', expiresAt: null });
      expect((await installFromRegistry('contract-onetime')).ok).toBe(true);
      expect((await syncStudio()).ok).toBe(true);
      const onetimeCap = pluginCapabilityId('contract-onetime', 'echo_thing');
      expect((await invoke(agentId, onetimeCap, { query: 'bought-once' })).outcome).toBe('SUCCEEDED');
      expect((await ledger.listPurchases()).filter((r) => r.intentId === onetime.intentId).map((r) => [r.legIndex, r.asset, r.state])).toEqual(
        expect.arrayContaining([
          [0, 'ETH', 'CONFIRMED'],
          [1, 'ETH', 'CONFIRMED'],
        ]),
      );

      // Monthly, in AI17Z at the quoted price less the discount; the publisher's value matches ETH.
      await fixture('prices', (10_000_000n * 10n ** 18n).toString());
      const monthly = await buy('contract-monthly', 'AI17Z');
      expect(monthly.legs.map((l) => [l.role, l.asset, l.amount])).toEqual([
        ['PUBLISHER', 'AI17Z', (1_840_000_000_000_000n * 10_000_000n).toString()],
        ['TREASURY', 'AI17Z', (80_000_000_000_000n * 10_000_000n).toString()],
      ]);
      const paid = await fixture('entitlement', 'contract-monthly') as { expiresAt: string; billingMode: string };
      expect(paid.billingMode).toBe('MONTHLY');
      expect(Date.parse(paid.expiresAt) - Date.now()).toBeGreaterThan(27 * 24 * 60 * 60 * 1000);
      expect((await installFromRegistry('contract-monthly')).ok).toBe(true);
      expect((await syncStudio()).ok).toBe(true);
      const monthlyCap = pluginCapabilityId('contract-monthly', 'echo_thing');
      expect((await invoke(agentId, monthlyCap, { query: 'this-month' })).outcome).toBe('SUCCEEDED');
      let status = await studioStatus();
      const leaseOk = status.lease as { ok: true; validUntil: string; entitlements: Array<{ plugin_id: string; usable: boolean; reason: string | null; expires_at?: string | null }> };
      expect(leaseOk.entitlements.find((e) => e.plugin_id === 'contract-monthly')?.expires_at).toBe(paid.expiresAt);
      expect(Date.parse(leaseOk.validUntil)).toBeLessThanOrEqual(Date.parse(paid.expiresAt));

      // A month passes unpaid (the controlled clock): visible, installed, and refused everywhere.
      await fixture('age', 'contract-monthly');
      expect((await syncStudio()).ok).toBe(true);
      status = await studioStatus();
      const lapsed = (status.lease as typeof leaseOk).entitlements.find((e) => e.plugin_id === 'contract-monthly');
      expect(lapsed).toMatchObject({ usable: false, reason: 'SUBSCRIPTION_EXPIRED' });
      expect(status.installed['contract-monthly']).toBe('1.0.0');
      expect((await getCapability(monthlyCap)!.readiness!({ agentId } as never)).status).toBe('UNAVAILABLE');
      expect((await invoke(agentId, monthlyCap, { query: 'after-lapse' })).outcome).not.toBe('SUCCEEDED');

      // Renewed by the owner, in ETH this time: a new period from confirmation, and it works again.
      const renewal = await buy('contract-monthly', 'ETH');
      expect(renewal.kind).toBe('RENEWAL');
      const renewed = await fixture('entitlement', 'contract-monthly') as { expiresAt: string };
      expect(Date.parse(renewed.expiresAt) - Date.now()).toBeGreaterThan(27 * 24 * 60 * 60 * 1000);
      expect((await syncStudio()).ok).toBe(true);
      expect((await invoke(agentId, monthlyCap, { query: 'renewed' })).outcome).toBe('SUCCEEDED');

      // Yearly, in ETH: twelve anchored months.
      await buy('contract-yearly', 'ETH');
      const yearly = await fixture('entitlement', 'contract-yearly') as { expiresAt: string; billingMode: string };
      expect(yearly.billingMode).toBe('YEARLY');
      expect(Date.parse(yearly.expiresAt) - Date.now()).toBeGreaterThan(364 * 24 * 60 * 60 * 1000);

      // Proprietary: the implementation runs on the publisher's server, reached only through the gateway.
      backend = spawn(process.execPath, [join(DIR!, 'examples', 'hosted-plugin', 'server.mjs')], {
        env: { ...process.env, PLUGIN_SIGNING_SECRET: setup.proprietarySecret, PLUGIN_ID: 'contract-proprietary', PORT: '8795', HOST: '127.0.0.1' },
        stdio: 'ignore',
      });
      for (let i = 0; i < 50; i++) {
        const up = await fetch('http://127.0.0.1:8795/', { method: 'POST', body: '{}' }).then(() => true, () => false);
        if (up) break;
        await new Promise((done) => setTimeout(done, 200));
      }
      expect((await installFromRegistry('contract-proprietary')).ok).toBe(false);
      await buy('contract-proprietary', 'ETH');
      expect((await installFromRegistry('contract-proprietary')).ok).toBe(true);
      expect((await syncStudio()).ok).toBe(true);
      const secretCap = pluginCapabilityId('contract-proprietary', 'lookup_thing');
      const answered = await invoke(agentId, secretCap, { query: 'through-the-gateway' });
      expect(answered.outcome, answered.detail).toBe('SUCCEEDED');
      expect(JSON.stringify(answered.output)).toContain('Result for through-the-gateway');
      // Bought, installed and entitled is still not allowed: no agent is offered it until the owner chooses.
      const before = await capabilitySettings(agentId);
      expect(before.permissions.get(secretCap)).toBe('DISABLED');
      const asked = 'look up through-the-model and tell me its score';
      const unoffered = await runCapabilityLoop({
        agentId,
        jobId: null,
        accountId: null,
        messages: [{ role: 'user', content: asked }],
        task: asked,
        permissions: before.permissions,
        configs: before.configs,
        paused: false,
        maxSteps: 1,
        generate: async () => 'I cannot look that up.',
      });
      expect(unoffered.shortlist.offered.map((c) => c.id)).not.toContain(secretCap);
      // The owner enables it for this one agent.
      await setPluginEnabled({ agentId, pluginId: 'contract-proprietary', enabled: true });
      const after = await capabilitySettings(agentId);
      expect(after.permissions.get(secretCap)).toBe('ALLOWED');
      // Offered, chosen by the model from the menu it was shown, executed through the gateway, used in the answer.
      let menuHadIt = false;
      const loop = await runCapabilityLoop({
        agentId,
        jobId: null,
        accountId: null,
        messages: [{ role: 'user', content: asked }],
        task: asked,
        permissions: after.permissions,
        configs: after.configs,
        paused: false,
        maxSteps: 2,
        generate: async (messages) => {
          const text = messages.map((m) => String(m.content)).join('\n');
          menuHadIt ||= text.includes(secretCap);
          const found = /Result for through-the-model[^"]*"[^}]*?"score":\s*([0-9.]+)/.exec(text);
          if (text.includes('Result for through-the-model')) {
            return `It is "Result for through-the-model" with a score of ${found?.[1] ?? 'unknown'}.`;
          }
          return `<use-capability>{"id":"${secretCap}","input":{"query":"through-the-model"}}</use-capability>`;
        },
      });
      expect(menuHadIt).toBe(true);
      expect(loop.shortlist.offered.map((c) => c.id)).toContain(secretCap);
      const chosen = loop.steps.find((step) => step.capabilityId === secretCap);
      expect(chosen?.outcome, chosen?.detail).toBe('SUCCEEDED');
      expect(loop.answer).toContain('Result for through-the-model');
      expect(loop.answer).toMatch(/score of [0-9]/);
      // Input the manifest does not declare never reaches the gateway.
      const bad = await invoke(agentId, secretCap, { query: 42 });
      expect(bad.outcome).not.toBe('SUCCEEDED');
      // What the installation holds names Studio's gateway and nothing of the backend or its secret.
      const installed = (await installedPlugins.listInstalledPlugins()).find((p) => p.id === 'contract-proprietary')!;
      const held = JSON.stringify(installed);
      expect(held).not.toContain('8795');
      expect(held).not.toContain(setup.proprietarySecret);
      expect(held).toContain('/api/gateway/v1/contract-proprietary/lookup_thing');
      // The backend itself refuses anything Studio did not sign, anything stale, and any replay.
      const body = JSON.stringify({ request_id: 'direct-1', plugin: 'contract-proprietary', capability: 'lookup_thing', input: { query: 'x' } });
      const signed = (secret: string, at: number, raw = body) => ({
        'content-type': 'application/json',
        'x-ai17z-request-id': 'direct-1',
        'x-ai17z-timestamp': String(at),
        'x-ai17z-signature': `v1=${createHmac('sha256', secret).update(`${at}.${raw}`).digest('hex')}`,
      });
      const now = Math.floor(Date.now() / 1000);
      const direct = (headers: Record<string, string>, raw = body) => fetch('http://127.0.0.1:8795/', { method: 'POST', headers, body: raw }).then((r) => r.status);
      // Signed correctly, but for another Plugin or a capability it does not implement.
      for (const other of [
        JSON.stringify({ request_id: 'direct-1', plugin: 'contract-hosted', capability: 'lookup_thing', input: { query: 'x' } }),
        JSON.stringify({ request_id: 'direct-1', plugin: 'contract-proprietary', capability: 'drop_tables', input: { query: 'x' } }),
      ]) {
        expect(await direct(signed(setup.proprietarySecret, Math.floor(Date.now() / 1000), other), other)).toBe(401);
      }
      expect(await direct({ 'content-type': 'application/json' })).toBe(401);
      expect(await direct(signed('not-the-secret', now))).toBe(401);
      expect(await direct(signed(setup.proprietarySecret, now - 600))).toBe(401);
      expect(await direct(signed(setup.proprietarySecret, now))).toBe(200);
      expect(await direct(signed(setup.proprietarySecret, now))).toBe(409);
      // Revoked on Studio: the gateway refuses the next call, whatever the installation still holds.
      await fixture('revoke-entitlement', 'contract-proprietary');
      expect((await invoke(agentId, secretCap, { query: 'after-revoke' })).outcome).not.toBe('SUCCEEDED');
    } finally {
      setPaymentRpcForTests(null);
      backend?.kill();
    }
  }, 300_000);
});
