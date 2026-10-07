/**
 * The signature on a shared-utility request, and what the surface refuses.
 *
 * This endpoint is reachable by anything that can make an HTTP request, so the
 * signature is the whole boundary. These cases are mostly about what must not
 * get through, including the ones that would be easy to get subtly wrong: a
 * replay with a different body, a replay with the same body an hour later, and
 * a comparison that throws instead of refusing.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PaperTradeInput,
  UTILITY_CAPABILITIES,
  UTILITY_CAPABILITY_IDS,
  UTILITY_CLOCK_SKEW_MS,
  UTILITY_REFUSALS,
  UtilityRequest,
  inputSchemaFor,
  isUtilityCapability,
  utilityAgentName,
  utilityPaperMandate,
  widenedUtilitySandbox,
  verifyUtilitySignature,
} from '@xbam/runtime';
import { AssetRef } from '@xbam/shared/contracts';

const SECRET = 'a-shared-secret-for-tests-only';
const sign = (timestamp: string, body: string): string => `v1=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
const seconds = (at: Date): string => Math.floor(at.getTime() / 1000).toString();

describe('a request is accepted only when it was signed by the gateway', () => {
  const now = new Date('2026-10-07T12:00:00.000Z');
  const body = JSON.stringify({ request_id: 'abcd1234', capability: 'market.snapshot', caller: 'caller-0001', input: {} });

  it('accepts a correctly signed request', () => {
    const ts = seconds(now);
    expect(verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature: sign(ts, body), body, now })).toEqual({ ok: true });
  });

  it('accepts the signature with or without the v1 prefix, because a gateway may send either', () => {
    const ts = seconds(now);
    const bare = sign(ts, body).slice(3);
    expect(verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature: bare, body, now }).ok).toBe(true);
  });

  it('refuses a body that changed after it was signed', () => {
    const ts = seconds(now);
    const signature = sign(ts, body);
    const tampered = body.replace('market.snapshot', 'trading.paper_trade');
    const verdict = verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature, body: tampered, now });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toBe('BAD_SIGNATURE');
  });

  it('refuses a replay once the clock window has closed, in both directions', () => {
    for (const drift of [UTILITY_CLOCK_SKEW_MS + 1000, -(UTILITY_CLOCK_SKEW_MS + 1000)]) {
      const at = new Date(now.getTime() + drift);
      const ts = seconds(at);
      const verdict = verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature: sign(ts, body), body, now });
      expect(verdict.ok, `drift ${drift} was accepted`).toBe(false);
      if (!verdict.ok) expect(verdict.why).toBe('STALE');
    }
  });

  it('accepts ordinary clock drift, because two machines are never in step', () => {
    const at = new Date(now.getTime() - (UTILITY_CLOCK_SKEW_MS - 5000));
    const ts = seconds(at);
    expect(verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature: sign(ts, body), body, now }).ok).toBe(true);
  });

  it('refuses a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so the length is checked
    // first. A thrown comparison would be a 500 rather than a refusal.
    const ts = seconds(now);
    for (const signature of ['v1=', 'v1=abc', 'v1=' + 'f'.repeat(63), 'v1=' + 'f'.repeat(65)]) {
      const verdict = verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature, body, now });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.why).toBe('BAD_SIGNATURE');
    }
  });

  it('refuses a signature made with a different secret', () => {
    const ts = seconds(now);
    const other = `v1=${createHmac('sha256', 'a-different-secret').update(`${ts}.${body}`).digest('hex')}`;
    const verdict = verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature: other, body, now });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toBe('BAD_SIGNATURE');
  });

  it('says a missing secret is this runtime\'s problem, not the caller\'s', () => {
    const ts = seconds(now);
    for (const secret of [undefined, '']) {
      const verdict = verifyUtilitySignature({ secret, timestamp: ts, signature: sign(ts, body), body, now });
      expect(verdict.ok).toBe(false);
      // Distinguished from BAD_SIGNATURE so an operator is not sent to check a
      // key that was never the problem.
      if (!verdict.ok) expect(verdict.why).toBe('NO_SECRET');
    }
  });

  it('refuses a missing header and a timestamp that is not a number', () => {
    const ts = seconds(now);
    expect(verifyUtilitySignature({ secret: SECRET, timestamp: undefined, signature: sign(ts, body), body, now }).ok).toBe(false);
    expect(verifyUtilitySignature({ secret: SECRET, timestamp: ts, signature: undefined, body, now }).ok).toBe(false);
    const verdict = verifyUtilitySignature({ secret: SECRET, timestamp: 'yesterday', signature: sign(ts, body), body, now });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toBe('MISSING_HEADER');
  });
});

describe('the envelope refuses what it does not recognise', () => {
  it('takes a well-formed request', () => {
    const parsed = UtilityRequest.safeParse({ request_id: 'abcd1234', capability: 'market.snapshot', caller: 'caller-0001', input: {} });
    expect(parsed.success).toBe(true);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    // The case this exists for: a caller sending a mode must fail loudly
    // rather than have it silently dropped and the request run as paper while
    // they believe otherwise.
    const parsed = UtilityRequest.safeParse({
      request_id: 'abcd1234',
      capability: 'trading.paper_trade',
      caller: 'caller-0001',
      input: {},
      mode: 'LIVE',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a caller short enough to be guessable', () => {
    expect(UtilityRequest.safeParse({ request_id: 'abcd1234', capability: 'market.snapshot', caller: 'a', input: {} }).success).toBe(false);
  });
});

describe('a paper trade is described in base units, never a float', () => {
  // The real venue and asset shapes, read off the contract rather than guessed:
  // the venues already distinguish Pons V1, V2 curve and V2 graduated from
  // Pump's curve and PumpSwap, and an onchain asset carries its decimals
  // because a price means nothing without them.
  const token = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: '0x' + '2'.repeat(40), decimals: 18 };
  const good = {
    venue: 'PONS_V2_CURVE' as const,
    side: 'BUY' as const,
    assetIn: { kind: 'NATIVE' as const, network: 'ethereum' as const },
    assetOut: token,
    subject: token,
    maxIn: '1000000000000000000',
    maxSlippageBps: 100,
    maxPriceImpactBps: 300,
    maxFeeBase: '5000000000000000',
  };

  it('takes a whole number of base units as a string', () => {
    const parsed = PaperTradeInput.safeParse(good);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    expect(parsed.success).toBe(true);
  });

  it('refuses an amount that is a number, a decimal or negative', () => {
    // A float loses precision exactly where it matters: at eighteen decimals a
    // double cannot represent one base unit of difference.
    for (const maxIn of [1e18, '1.5', '-1', '0x10', '', '1e18']) {
      expect(PaperTradeInput.safeParse({ ...good, maxIn }).success, `${String(maxIn)} was accepted`).toBe(false);
    }
  });

  it('refuses a slippage or impact ceiling outside the possible range', () => {
    for (const bps of [-1, 10_001, 1.5]) {
      expect(PaperTradeInput.safeParse({ ...good, maxSlippageBps: bps }).success).toBe(false);
      expect(PaperTradeInput.safeParse({ ...good, maxPriceImpactBps: bps }).success).toBe(false);
    }
  });

  it('refuses a mode, a wallet or a key, because none of them belongs here', () => {
    for (const smuggled of [{ mode: 'LIVE' }, { walletId: 'w-1' }, { privateKey: '0xdead' }, { live: true }]) {
      expect(PaperTradeInput.safeParse({ ...good, ...smuggled }).success, `${JSON.stringify(smuggled)} was accepted`).toBe(false);
    }
  });
});

describe('the offered surface', () => {
  it('offers only capabilities that have a schema', () => {
    for (const id of UTILITY_CAPABILITY_IDS) {
      expect(inputSchemaFor(id), `${id} has no input schema`).toBeDefined();
    }
  });

  it('describes every capability and classes its risk', () => {
    for (const id of UTILITY_CAPABILITY_IDS) {
      const entry = UTILITY_CAPABILITIES[id];
      expect(entry.title.length).toBeGreaterThan(2);
      expect(entry.what.length).toBeGreaterThan(30);
      // Everything on this surface moves nothing, which is what makes it
      // shared. A capability with any other risk class does not belong here.
      expect(entry.riskClass, `${id} is not risk-free and must not be on the shared surface`).toBe('NONE');
    }
  });

  it('offers nothing whose name suggests it could move value', () => {
    for (const id of UTILITY_CAPABILITY_IDS) {
      expect(id, `${id} sounds like it executes`).not.toMatch(/sign|send|transfer|approve|withdraw|execute|live/i);
    }
  });

  it('knows its own names and refuses anything else', () => {
    for (const id of UTILITY_CAPABILITY_IDS) expect(isUtilityCapability(id)).toBe(true);
    for (const stray of ['trading.live_trade', 'wallet.sign', '', '__proto__', 'asset.resolve']) {
      expect(isUtilityCapability(stray), `${stray} was accepted`).toBe(false);
    }
  });

  it('states what it refuses, including that paper is forced rather than chosen', () => {
    const refusals = UTILITY_REFUSALS.join(' ');
    expect(refusals).toMatch(/signs, sends, transfers or approves/i);
    expect(refusals).toMatch(/forced in core/i);
    expect(refusals).toMatch(/pseudonym/i);
  });
});

describe('a caller gets its own journal and a paper-only mandate', () => {
  it('maps a pseudonym to a stable agent name without revealing it', () => {
    expect(utilityAgentName('caller-0001')).toBe(utilityAgentName('caller-0001'));
    expect(utilityAgentName('caller-0001')).not.toBe(utilityAgentName('caller-0002'));
    expect(utilityAgentName('caller-0001')).toMatch(/^utility:/);
  });

  it('bounds a pseudonym long enough to be a problem', () => {
    expect(utilityAgentName('x'.repeat(500)).length).toBeLessThan(60);
  });

  it('issues a mandate that is PAPER and needs approval, whatever else changes', () => {
    const mandate = utilityPaperMandate();
    expect(mandate.mode).toBe('PAPER');
    // Even if a mode were somehow widened later, this mandate still would not
    // authorise an unattended live trade.
    expect(mandate.approval).toBe('OWNER_APPROVES_EACH');
    expect(mandate.paused).toBe(false);
  });

  it('demands the same quote freshness a live trade would', () => {
    // A paper fill against a stale quote is a simulation of nothing, so this is
    // not relaxed just because no value moves.
    expect(utilityPaperMandate().quoteMaxAgeMs).toBeLessThanOrEqual(30_000);
  });

  it('takes no arguments, so no request shape can influence it', () => {
    expect(utilityPaperMandate.length).toBe(0);
  });

  it('issues a mandate the contract will actually accept', () => {
    // It did not. `minLiquidityBase` was '0', `BaseUnits` refuses zero, and
    // every paper trade through this surface failed on saving the mandate with
    // "Min Liquidity Base: An amount has to be more than zero". Nothing caught
    // it because nothing could price a market, so no trade reached the save.
    const mandate = utilityPaperMandate();
    expect(BigInt(mandate.minLiquidityBase)).toBeGreaterThan(0n);
    for (const amount of [mandate.maxPerTrade, mandate.maxPerDay, mandate.maxOpenExposure, mandate.maxFeeBase]) {
      expect(BigInt(amount)).toBeGreaterThan(0n);
    }
  });

  it('allows a network, because an empty list refuses every trade', () => {
    // The risk gate denies NETWORK_NOT_ALLOWED for a network outside the list,
    // so an empty list is not a permissive default: it is a closed door that
    // looks like one.
    expect(utilityPaperMandate().networks.length).toBeGreaterThan(0);
  });
});

describe('the paper sandbox records what a caller explored', () => {
  const weth = AssetRef.parse({
    kind: 'ONCHAIN',
    network: 'ethereum',
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    decimals: 18,
  });
  const usdc = AssetRef.parse({
    kind: 'ONCHAIN',
    network: 'ethereum',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
  });

  it('adds an asset nobody had asked about yet', () => {
    const widened = widenedUtilitySandbox(utilityPaperMandate(), [usdc, weth]);
    expect(widened).not.toBeNull();
    expect(widened!.allowedAssets).toHaveLength(2);
  });

  it('does nothing the second time, so a mandate is not rewritten per trade', () => {
    const first = widenedUtilitySandbox(utilityPaperMandate(), [usdc, weth])!;
    expect(widenedUtilitySandbox(first, [weth, usdc])).toBeNull();
    // Two references to one asset are one row, not two.
    expect(widenedUtilitySandbox(utilityPaperMandate(), [weth, weth])!.allowedAssets).toHaveLength(1);
  });

  it('changes nothing except the asset list', () => {
    const before = utilityPaperMandate();
    const after = widenedUtilitySandbox(before, [weth])!;
    const { allowedAssets: _was, ...restBefore } = before;
    const { allowedAssets: _now, ...restAfter } = after;
    // Everything a live trade would rest on is carried across untouched, and
    // this compares the whole object rather than a list of fields somebody
    // remembered, so a field added later is covered without being named.
    expect(restAfter).toEqual(restBefore);
  });

  it('refuses to touch a mandate that is not paper', () => {
    // An owner's own mandate is never widened by somebody calling an API.
    expect(widenedUtilitySandbox({ mode: 'LIVE', allowedAssets: [] }, [weth])).toBeNull();
  });
});
