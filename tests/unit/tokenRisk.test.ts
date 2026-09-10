import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What security services observe, and the two ways this could lie.
 *
 * **By judging.** "Safe" and "scam" are the words this must never produce. The
 * services report attributes; the useful, defensible thing is the attribute
 * with its source attached. A verdict is a claim AI17Z cannot support and would
 * be believed anyway.
 *
 * **By reading silence as reassurance.** The fields come back as `"0"`, `"1"`,
 * and an empty string for anything the service did not check. Treating that
 * empty as nought turns "we did not look" into "it is fine" -- the worst
 * possible direction for this particular error, and the one an agent would then
 * repeat to somebody about to spend money.
 */

let responses: Record<string, { status: number; body: string }> = {};

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(input: unknown) {
    const url = String(input);
    const match = Object.keys(responses).find((key) => url.includes(key));
    const answer = match ? responses[match]! : { status: 404, body: '{}' };
    return new Response(answer.body, {
      status: answer.status,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { registerTokenRiskUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { registerTokenRiskCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const TOKEN = '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE';

function context() {
  return {
    agentId: 'agent-1',
    jobId: null,
    accountId: null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => context().logger } as never,
    signal: new AbortController().signal,
  };
}

interface RiskAnswer {
  observations: { what: string; detail: string; source: string; kind: string }[];
  notChecked: string[];
  limitations: string[];
  sourcesAnswering: number;
}

async function inspect(): Promise<RiskAnswer> {
  const capability = getCapability('token.inspect_risk')!;
  return capability.run(
    capability.input.parse({ chain: 'ethereum', address: TOKEN }) as never,
    context(),
  ) as Promise<RiskAnswer>;
}

/** A GoPlus body with whatever fields a case needs. */
function security(fields: Record<string, unknown>) {
  return { status: 200, body: JSON.stringify({ result: { [TOKEN.toLowerCase()]: fields } }) };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerTokenRiskUpstreams();
  registerTokenRiskCapabilities();
  responses = {};
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('a field nobody checked', () => {
  it('is listed as not checked, and never reported as clean', async () => {
    // The empty string is the trap. `sell_tax: ""` means the service did not
    // look, and an agent told "sell tax 0%" would repeat that to somebody about
    // to buy.
    responses = {
      'gopluslabs.io': security({ buy_tax: '0', sell_tax: '', is_honeypot: '', holder_count: 42 }),
      'honeypot.is': { status: 200, body: JSON.stringify({ simulationSuccess: false }) },
    };
    const answer = await inspect();

    expect(answer.notChecked.join(' ')).toMatch(/Sell tax/);
    expect(answer.notChecked.join(' ')).toMatch(/Cannot be sold/);
    // And crucially, nothing claims a sell tax at all.
    expect(answer.observations.find((o) => o.what === 'Sell tax')).toBeUndefined();
    // The buy tax it *did* check is reported.
    expect(answer.observations.find((o) => o.what === 'Buy tax')?.detail).toBe('0%');
  });

  it('says a simulation that did not run taught it nothing', async () => {
    // Not "not a honeypot". A simulation that failed is silence.
    responses = {
      'gopluslabs.io': security({ buy_tax: '0' }),
      'honeypot.is': { status: 200, body: JSON.stringify({ simulationSuccess: false }) },
    };
    const answer = await inspect();
    expect(answer.notChecked.join(' ')).toMatch(/Whether it can be sold/);
    expect(answer.observations.find((o) => o.what === 'Could be sold again')).toBeUndefined();
  });
});

describe('what it will not say', () => {
  it('never produces a verdict, however bad the readings are', async () => {
    responses = {
      'gopluslabs.io': security({
        buy_tax: '0.99',
        sell_tax: '0.99',
        is_honeypot: '1',
        is_mintable: '1',
        hidden_owner: '1',
        can_take_back_ownership: '1',
        is_open_source: '0',
        creator_percent: '0.95',
      }),
      'honeypot.is': {
        status: 200,
        body: JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: true } }),
      },
    };
    const answer = await inspect();

    const everything = JSON.stringify(answer).toLowerCase();
    // The two words that must never appear as a judgement.
    expect(everything).not.toMatch(/\bis a scam\b/);
    expect(everything).not.toMatch(/\bsafe to buy\b/);
    expect(everything).not.toMatch(/\bverdict\b/);
    expect(everything).not.toMatch(/\brug\b/);

    // What it does say: the readings, flagged as the sources flagged them.
    const flags = answer.observations.filter((o) => o.kind === 'FLAG');
    expect(flags.length).toBeGreaterThan(4);
    expect(answer.observations.every((o) => o.source.length > 0)).toBe(true);
  });

  it('carries its limitations every time, not only when something looks wrong', async () => {
    responses = {
      'gopluslabs.io': security({ buy_tax: '0', sell_tax: '0', is_honeypot: '0' }),
      'honeypot.is': {
        status: 200,
        body: JSON.stringify({ simulationSuccess: true, honeypotResult: { isHoneypot: false } }),
      },
    };
    const answer = await inspect();
    expect(answer.limitations.length).toBeGreaterThanOrEqual(3);
    expect(answer.limitations.join(' ')).toMatch(/not a judgement/i);
    // The one that matters most on a clean-looking token.
    expect(answer.limitations.join(' ')).toMatch(/can still lose money/i);
  });
});

describe('what each source actually said', () => {
  it('attributes every observation', async () => {
    responses = {
      'gopluslabs.io': security({ buy_tax: '0.05', holder_count: 1000 }),
      'honeypot.is': {
        status: 200,
        body: JSON.stringify({ simulationSuccess: true, simulationResult: { buyTax: 5, sellTax: 5 } }),
      },
    };
    const answer = await inspect();
    expect(answer.sourcesAnswering).toBe(2);
    // Both sources reported a buy tax and both readings survive, separately.
    const buys = answer.observations.filter((o) => o.what.startsWith('Buy tax'));
    expect(buys).toHaveLength(2);
    expect(new Set(buys.map((o) => o.source)).size).toBe(2);
  });

  it('says nothing was corroborated when only one source answered', async () => {
    responses = { 'gopluslabs.io': security({ buy_tax: '0' }) };
    const answer = await inspect();
    expect(answer.sourcesAnswering).toBe(1);
    expect(answer.limitations.join(' ')).toMatch(/nothing here has been corroborated/i);
  });

  it('treats a contract nobody has analysed as a finding of its own', async () => {
    // "Nobody has looked at this" is worth knowing about a token somebody is
    // being offered, and it is not the same as a clean report.
    responses = { 'gopluslabs.io': { status: 200, body: JSON.stringify({ result: {} }) } };
    const answer = await inspect();
    expect(answer.observations.find((o) => o.what === 'Never analysed')?.kind).toBe('FLAG');
  });
});
