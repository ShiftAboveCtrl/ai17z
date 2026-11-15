import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Solana branch of `token.inspect_risk` reads the mint creator (two RPC calls)
 * and the mint account (one). It runs under one 40 second timeout that was sized
 * before the second read existed, so the reads must overlap: waiting for one and
 * then the other would put a slow node over the timeout and turn the whole card
 * into "Token evidence unavailable" because of one extra section.
 */

const gate = vi.hoisted(() => {
  const state = {
    deployerStarted: false,
    extensionsStarted: false,
    releaseDeployer: () => {},
    releaseExtensions: () => {},
  };
  return state;
});

vi.mock('../../packages/runtime/src/deployerHistory', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/runtime/src/deployerHistory')>();
  return {
    ...actual,
    readDeployerHistory: () => new Promise(resolve => {
      gate.deployerStarted = true;
      gate.releaseDeployer = () => resolve({ address: null, createdAt: null, source: 'solana_mainnet.official', fetchedAt: null,
        otherLaunches: null, launchesSource: 's', launchesFetchedAt: null, launchesObservedAt: null, launchesMaxAgeMs: 300_000, earlier: [] });
    }),
  };
});
vi.mock('../../packages/runtime/src/tokenExtensions', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/runtime/src/tokenExtensions')>();
  return {
    ...actual,
    readMintExtensions: () => new Promise(resolve => {
      gate.extensionsStarted = true;
      gate.releaseExtensions = () => resolve({ status: 'unread', source: 'solana_mainnet.official', fetchedAt: null, maxAgeMs: 300_000 });
    }),
  };
});
vi.mock('@xbam/upstream', async importOriginal => {
  const actual = await importOriginal<typeof import('@xbam/upstream')>();
  // The index read fails, which the capability treats as a smaller answer, so only the chain reads are under test.
  return { ...actual, ask: () => Promise.reject(new Error('index down')) };
});

const { registerTokenRiskCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const MINT = 'So11111111111111111111111111111111111111112';

function context() {
  return {
    agentId: 'agent-1', jobId: null, accountId: null, config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => context().logger } as never,
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  gate.deployerStarted = false; gate.extensionsStarted = false;
  resetCapabilitiesForTest();
  registerTokenRiskCapabilities();
});
afterEach(() => resetCapabilitiesForTest());

describe('inspect_risk on Solana', () => {
  it('starts the mint read while the deployer reads are still running, and waits for the slower of the two', async () => {
    const capability = getCapability('token.inspect_risk')!;
    expect(capability.timeoutMs).toBe(40_000);
    const running = capability.run(capability.input.parse({ chain: 'solana', address: MINT }) as never, context()) as Promise<{ deployer: unknown; extensions: { status: string } }>;
    let done = false;
    void running.then(() => { done = true; });
    // Let the index read fail and the chain reads begin.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(gate.deployerStarted).toBe(true);
    expect(gate.extensionsStarted).toBe(true);
    expect(done).toBe(false);
    gate.releaseExtensions();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(done).toBe(false);
    gate.releaseDeployer();
    const answer = await running;
    expect(answer.extensions.status).toBe('unread');
    expect(answer.deployer).toBeTruthy();
  });
});
