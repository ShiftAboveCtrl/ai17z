import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which messages are sent to the vesting reader, and which never are.
 *
 * The rule that matters most is the negative one: a question addressed to the
 * agent about itself ("when do you unlock?") is never read as a question about
 * a token, whatever else is in the conversation.
 */

const hook: { rpc: ((method: string, params: unknown[]) => Promise<{ result: unknown; slot: number | null }>) | null } = { rpc: null };

vi.mock('@xbam/upstream', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xbam/upstream')>();
  return {
    ...original,
    ask: vi.fn(async (_family: string, query: { method: string; params: unknown[] }) => {
      if (!hook.rpc) throw new Error('No cluster is attached in this case.');
      const answered = await hook.rpc(query.method, query.params);
      return {
        value: { result: answered.result, commitment: 'finalized', slot: answered.slot },
        provenance: { upstreamId: 'solana_mainnet.fake', fetchedAt: '2026-11-15T12:00:00.000Z', origin: 'fake', fellBackFrom: [] },
      };
    }),
  };
});

const { whatToResearch, research, resetVestingCacheForTest, renderResearch } = await import('@xbam/runtime');
const { addr, fakeCluster, scenarios } = await import('../support/vestingFixtures');

const MINT = addr('mint');

beforeEach(() => {
  hook.rpc = null;
  resetVestingCacheForTest();
});

const vestingOf = (incoming: string, parent?: string) =>
  whatToResearch({ incoming, parent: parent ?? null }).filter((l) => l.kind === 'vesting');

describe('a question about a schedule is read from the chain', () => {
  it('routes a question that names the mint', () => {
    expect(vestingOf(`when is the next unlock for ${MINT}?`)).toEqual([
      expect.objectContaining({ kind: 'vesting', query: MINT }),
    ]);
  });

  it('routes cliff and vesting words too', () => {
    expect(vestingOf(`how much is still in vesting for ${MINT}?`)).toHaveLength(1);
    expect(vestingOf(`when does the cliff end on ${MINT}?`)).toHaveLength(1);
  });

  it('takes the mint from the post being answered when the question names none', () => {
    expect(vestingOf('when is the next unlock?', `New launch ${MINT} is live`)).toEqual([
      expect.objectContaining({ kind: 'vesting', query: MINT }),
    ]);
  });

  it('routes a polite request that carries a mint, since the mint is what is being asked about', () => {
    expect(vestingOf(`can you tell me when the unlock for ${MINT} is?`)).toHaveLength(1);
  });

  it('asks about the first mint only, once', () => {
    const other = addr('other-mint');
    expect(vestingOf(`when is the unlock for ${MINT}? and ${other}?`)).toHaveLength(1);
  });
});

describe('a question about the agent is never routed here', () => {
  it('does not read "when do you unlock" as a token question, even beside a mint in the post', () => {
    expect(vestingOf('when do you unlock?', `Check ${MINT}`)).toEqual([]);
    expect(vestingOf('are you vesting anything?', `Check ${MINT}`)).toEqual([]);
    expect(vestingOf('what is your cliff?', `Check ${MINT}`)).toEqual([]);
  });

  it('does not route a request addressed to the agent that names no mint', () => {
    expect(vestingOf('can you tell me when the unlock is?', `Check ${MINT}`)).toEqual([]);
  });
});

describe('and nothing else is', () => {
  it('needs a mint somewhere in the conversation', () => {
    expect(vestingOf('when is the next unlock?')).toEqual([]);
  });

  it('is not triggered by a mint with no schedule question', () => {
    expect(vestingOf(`nice one ${MINT}`)).toEqual([]);
    expect(vestingOf(`what is ${MINT}?`)).toEqual([]);
  });

  it('is not triggered by a bare lock or vest', () => {
    expect(vestingOf(`is the liquidity locked for ${MINT}?`)).toEqual([]);
    expect(vestingOf(`I love this vest ${MINT}?`)).toEqual([]);
  });
});

describe('running the lookup', () => {
  it('gives a sourced finding in the fixed template, attributed to the chain read', async () => {
    const snapshot = scenarios().streamflowMixed;
    const cluster = fakeCluster(snapshot);
    hook.rpc = async (method, params) => {
      const answered = await cluster.rpc(method as never, params);
      return { result: answered.result, slot: answered.slot };
    };
    const result = await research([{ kind: 'vesting', query: snapshot.mint, reason: 'asked' }]);
    expect(result.failed).toEqual([]);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.kind).toBe('vesting');
    expect(finding.source).toBe('solana.read_vesting_streams');
    expect(finding.summary).toContain('Next scheduled release: 2026-11-18T12:00:00.000Z');
    expect(finding.summary).toContain('Scope: only Streamflow is read; other lockers are not');
    expect(renderResearch(result)).toContain('looked up just now');
  });

  it('reports a failed read as a gap, never as a finding with zeros', async () => {
    hook.rpc = async () => { throw new Error('The cluster did not answer.'); };
    const result = await research([{ kind: 'vesting', query: MINT, reason: 'asked' }]);
    expect(result.findings).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/could not be read/);
  });

  it('is skipped when the agent may not look up market data', async () => {
    const result = await research([{ kind: 'vesting', query: MINT, reason: 'asked' }], { sources: { web: true, market: false } });
    expect(result.findings).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/not set up to look up market data/);
  });
});
