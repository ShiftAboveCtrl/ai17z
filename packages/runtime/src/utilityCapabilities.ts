/**
 * The shared utility capability surface: what a website caller may ask this
 * runtime to do on its behalf.
 *
 * This is Class 1 compute. Everything here is public, stateless with respect to
 * anybody's secrets, and moves no value: research, asset identity, market
 * state, and paper trading. It holds no provider credential, no wallet and no
 * browser session, which is exactly why it does not need a confidential
 * runtime and is not waiting on one.
 *
 * ### Why the caller is a pseudonym
 *
 * Studio signs each request and sends an opaque `caller` string rather than a
 * person. This runtime therefore cannot learn who is asking, which is the
 * property that lets one shared runtime serve many accounts: it keeps a
 * separate agent, mandate and journal per pseudonym, so two callers' paper
 * trades can no more touch each other than two agents on one owner's machine
 * can.
 *
 * ### What is deliberately absent
 *
 * No capability here signs, sends, transfers or approves anything, and none
 * takes a wallet, a private key or a live mode. `runPaperTrade` forces
 * `mode: 'PAPER'` in core and there is no argument that changes it. A live
 * trade is a different surface with a different authorisation, and putting one
 * here would mean a signed HTTP request could move money.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BacktestCosts, BacktestRule } from './backtest';
import { TradePreflightInput } from './tradePreflight';
import { z } from 'zod';
import { AssetRef, TRADE_VENUE_IDS, TRADE_SIDES, WALLET_NETWORK_IDS, assetKey, type AssetRef as AssetRefValue } from '@xbam/shared/contracts';

/**
 * How far out of step a request's clock may be.
 *
 * Two minutes rather than two seconds: Studio and this runtime are different
 * machines and a strict window turns ordinary clock drift into an outage. Two
 * minutes is short enough that a captured request is not a lasting credential,
 * given the signature already binds the body.
 */
export const UTILITY_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** The capabilities this runtime answers, and what each one is. */
export const UTILITY_CAPABILITIES = {
  'trading.paper_trade': {
    title: 'Paper trade',
    what: 'Runs one paper trade through the canonical pipeline: mandate, market state, risk, quote, simulation and journal. Moves no value and signs nothing.',
    costClass: 'MARKET_READ',
    riskClass: 'NONE',
  },
  'trading.paper_portfolio': {
    title: 'Paper portfolio',
    what: "Reads a caller's paper positions and performance from the journal this runtime already keeps.",
    costClass: 'DATABASE',
    riskClass: 'NONE',
  },
  'market.snapshot': {
    title: 'Market snapshot',
    what: 'Reads current venue state for an exact asset: price, liquidity, fees and when it was observed.',
    costClass: 'MARKET_READ',
    riskClass: 'NONE',
  },
  'trading.backtest': {
    title: 'Backtest',
    what: "Replays up to five written-down rules over one pool's recorded candles, read once so every rule sees exactly the same history. Each decision fills at the next candle's open, so none sees the future. Simulated; signs nothing.",
    costClass: 'MARKET_READ',
    riskClass: 'NONE',
  },
  'trading.preflight': {
    title: 'Trade preflight',
    what: 'Reads the market for an exact trade and runs it through the same risk gate a real trade passes, against the mandate the caller gives. Answers ALLOW, APPROVAL_REQUIRED or DENY with every reason. Journals nothing and signs nothing.',
    costClass: 'MARKET_READ',
    riskClass: 'NONE',
  },
  'capability.invoke': {
    title: 'Public capability',
    what: "Runs one of AI17Z's public, read-only capabilities, from an explicit list: asset identity, market history, chain and contract reads, transaction decoding, token risk, DeFi, governance, reference and research lookups. Through the same invocation path an agent uses, with its schemas, timeouts and shared upstream budgets.",
    costClass: 'UPSTREAM_READ',
    riskClass: 'NONE',
  },
} as const;

/**
 * The capabilities a shared runtime may run for anybody, by exact id.
 *
 * An allowlist rather than "every READ capability", because a capability
 * added to core for an agent's own use must not become something strangers
 * can call the day it merges. Every entry reads public data and touches
 * nothing of the caller's or the operator's: no agent state, no wallet, no
 * session, no owner introspection. The registry's own declaration is checked
 * as well at call time (`bridgeRefusal`), so an entry whose capability later
 * becomes a write or owner-only is refused rather than trusted.
 *
 * Deliberately absent: `agent.*` (the agent's own workings, OWNER), `wallet.*`
 * (an agent's own wallet), `x.*` (a signed-in session nobody here has),
 * `github.*` (an owner's watched repositories), and `web.history_capture`,
 * which declares READ but asks an archive to make a capture, an action on
 * somebody else's service.
 */
export const UTILITY_BRIDGE: readonly string[] = [
  // Asset identity and markets.
  'market.resolve_exact',
  'market.ohlcv',
  'market.new_pools',
  'market.trending',
  'market.price_check',
  // EVM chains and contracts: the substance of a transaction inspector.
  'chain.health',
  'chain.read_balance',
  'chain.read_block',
  'chain.read_code',
  'chain.read_logs',
  'chain.read_receipt',
  'chain.read_transaction',
  'contract.abi',
  'contract.decode_event',
  'contract.decode_function',
  'contract.inspect',
  'contract.source_metadata',
  'contract.verification',
  'transaction.inspect',
  'transaction.inspect_solana',
  'transaction.reconcile',
  'token.inspect_risk',
  'address.risk_evidence',
  // Solana and Bitcoin.
  'solana.health',
  'solana.read_account',
  'solana.read_balance',
  'solana.read_program',
  'solana.read_signatures',
  'solana.read_token',
  'solana.read_transaction',
  'bitcoin.health',
  'bitcoin.read_address',
  'bitcoin.read_fees',
  'bitcoin.read_transaction',
  'bitcoin.read_unspent',
  // DeFi and governance.
  'defi.chain_tvl',
  'defi.chain_tvl_history',
  'defi.protocol_tvl',
  'defi.stablecoin_supply_by_chain',
  'defi.stablecoins',
  'governance.health',
  'governance.list_proposals',
  'governance.read_proposal',
  'governance.read_space',
  'governance.read_votes',
  // Reference, research and public records.
  'reference.look_up',
  'research.paper_lookup',
  'research.paper_search',
  'entity.facts',
  'entity.relationships',
  'entity.resolve',
  'company.filings',
  'company.resolve',
  'storage.describe_identifier',
  'storage.read_document',
  'feed.read',
  'web.history',
];

/** Why a capability may not be run for a shared-runtime caller, or null when it may. */
export function bridgeRefusal(
  id: string,
  declared: { effect: string; audience?: string; modelCallable: boolean } | undefined,
): string | null {
  if (!UTILITY_BRIDGE.includes(id)) return `${id} is not offered on this runtime.`;
  if (declared === undefined) return `${id} is not installed on this runtime.`;
  // Checked against the registry's own declaration, not only the list: an
  // entry that has become a write or owner-only is refused, not trusted.
  if (declared.effect !== 'READ') return `${id} changes something, and nothing that does is offered here.`;
  if (declared.audience === 'OWNER') return `${id} is for an agent's owner, not for a shared runtime's callers.`;
  if (!declared.modelCallable) return `${id} is driven by the runtime itself and cannot be called directly.`;
  return null;
}

export type UtilityCapability = keyof typeof UTILITY_CAPABILITIES;
export const UTILITY_CAPABILITY_IDS = Object.keys(UTILITY_CAPABILITIES) as [UtilityCapability, ...UtilityCapability[]];

export function isUtilityCapability(value: unknown): value is UtilityCapability {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UTILITY_CAPABILITIES, value);
}

/**
 * The envelope every request arrives in.
 *
 * `.strict()` throughout: an unknown field is a refusal rather than something
 * ignored, because a caller sending `mode: "LIVE"` must fail loudly rather than
 * have it quietly dropped.
 */
export const UtilityRequest = z
  .object({
    request_id: z.string().min(8).max(64),
    capability: z.string().min(1).max(64),
    /** Opaque, stable per caller. This runtime never learns who it is. */
    caller: z.string().min(8).max(128),
    input: z.record(z.unknown()),
  })
  .strict();
export type UtilityRequest = z.infer<typeof UtilityRequest>;

/** A paper trade, as a caller may describe one. */
export const PaperTradeInput = z
  .object({
    venue: z.enum(TRADE_VENUE_IDS),
    side: z.enum(TRADE_SIDES),
    assetIn: AssetRef,
    assetOut: AssetRef,
    /** The asset whose venue state is read. For a buy, what is being bought. */
    subject: AssetRef,
    /** Base units, as a decimal string. Never a number: a float loses precision at scale. */
    maxIn: z.string().regex(/^[0-9]{1,40}$/, 'An amount is a whole number of base units.'),
    maxSlippageBps: z.number().int().min(0).max(10_000),
    maxPriceImpactBps: z.number().int().min(0).max(10_000),
    maxFeeBase: z.string().regex(/^[0-9]{1,40}$/, 'A fee ceiling is a whole number of base units.'),
    /** The caller's own key for this trade, so a retry is the same trade. */
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .strict();
export type PaperTradeInput = z.infer<typeof PaperTradeInput>;

export const MarketSnapshotInput = z
  .object({
    subject: AssetRef,
    venue: z.enum(TRADE_VENUE_IDS),
    /**
     * What the price is wanted in.
     *
     * Optional because a venue with one quote asset has nothing to choose.
     * Worth offering because a venue with many has everything to choose: a
     * pool venue asked about WETH answered a true price in Bitcoin, and a
     * caller comparing that against dollars would have been out by four
     * orders of magnitude without anything looking wrong.
     */
    quote: AssetRef.optional(),
  })
  .strict();

export const PaperPortfolioInput = z.object({}).strict();

/**
 * A backtest: one pool, one history window, up to five rules over it.
 *
 * More than one rule is the arena, and the rules share the one read of
 * history on purpose: comparing rules on two different reads of a market is
 * comparing the reads.
 */
export const BacktestInput = z
  .object({
    chain: z.string().min(2).max(20),
    poolAddress: z.string().min(26).max(64),
    timeframe: z.enum(['minute', 'hour', 'day']),
    candles: z.number().int().min(10).max(100),
    rules: z.array(BacktestRule).min(1).max(5),
    costs: BacktestCosts,
  })
  .strict();
export type BacktestInput = z.infer<typeof BacktestInput>;

/** One allowlisted capability and its own input, which the capability's schema then judges. */
export const CapabilityInvokeInput = z
  .object({
    id: z.string().min(3).max(64),
    input: z.record(z.unknown()),
  })
  .strict();

/** Which schema belongs to which capability, in one place. */
export function inputSchemaFor(capability: UtilityCapability): z.ZodTypeAny {
  switch (capability) {
    case 'trading.paper_trade':
      return PaperTradeInput;
    case 'trading.paper_portfolio':
      return PaperPortfolioInput;
    case 'market.snapshot':
      return MarketSnapshotInput;
    case 'capability.invoke':
      return CapabilityInvokeInput;
    case 'trading.backtest':
      return BacktestInput;
    case 'trading.preflight':
      return TradePreflightInput;
  }
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; why: 'NO_SECRET' | 'MISSING_HEADER' | 'STALE' | 'BAD_SIGNATURE'; detail: string };

/**
 * Whether a request really came from the gateway that shares this secret.
 *
 * The signature covers the timestamp and the exact body, so a replay with a
 * different body fails and a replay with the same body fails once the clock
 * window closes. Compared in constant time, and the length is checked first
 * because `timingSafeEqual` throws on a mismatch rather than returning false.
 *
 * Reports *why* separately. A missing secret is an operator's configuration
 * problem, a stale timestamp is a clock problem and a bad signature is a wrong
 * key or a forgery; answering all three with "unauthorised" sends somebody to
 * read the wrong documentation.
 */
export function verifyUtilitySignature(input: {
  secret: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  now?: Date;
}): SignatureVerdict {
  if (input.secret === undefined || input.secret === '') {
    return { ok: false, why: 'NO_SECRET', detail: 'This runtime has no utility signing secret configured, so it can authenticate nothing.' };
  }
  if (input.timestamp === undefined || input.signature === undefined) {
    return { ok: false, why: 'MISSING_HEADER', detail: 'A utility request carries a timestamp and a signature.' };
  }

  const sent = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(sent)) {
    return { ok: false, why: 'MISSING_HEADER', detail: 'That timestamp is not a number of seconds.' };
  }
  const now = (input.now ?? new Date()).getTime();
  if (Math.abs(now - sent * 1000) > UTILITY_CLOCK_SKEW_MS) {
    return { ok: false, why: 'STALE', detail: 'That request is too old or too far in the future to accept.' };
  }

  const expected = createHmac('sha256', input.secret).update(`${input.timestamp}.${input.body}`).digest('hex');
  const presented = input.signature.startsWith('v1=') ? input.signature.slice(3) : input.signature;
  // Length first: timingSafeEqual throws on unequal lengths, and a thrown
  // comparison is an error path rather than a refusal.
  if (presented.length !== expected.length) return { ok: false, why: 'BAD_SIGNATURE', detail: 'That signature does not match this body.' };
  if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return { ok: false, why: 'BAD_SIGNATURE', detail: 'That signature does not match this body.' };
  }
  return { ok: true };
}

/**
 * The agent name a caller's pseudonym maps to.
 *
 * Deterministic, so the same caller reaches the same agent, journal and paper
 * positions on every request without this runtime storing who they are. The
 * pseudonym is already opaque; this only makes it legible as a name on an
 * operator's screen.
 */
export function utilityAgentName(caller: string): string {
  return `utility:${caller.slice(0, 32)}`;
}

/** Everything this surface refuses, stated so it can be tested rather than assumed. */
export const UTILITY_REFUSALS: readonly string[] = [
  'No capability here signs, sends, transfers or approves anything, and none accepts a wallet or a private key.',
  'Paper mode is forced in core by runPaperTrade, not chosen by a caller, so no request can ask for a live trade.',
  'An unknown field in a request body is a refusal rather than something ignored, so a caller cannot smuggle a mode past the schema.',
  'This runtime holds no provider credential, X session or browser profile, so a compromised caller gains none.',
  'A caller is a pseudonym, so this runtime cannot learn whose trade it is running.',
];

/**
 * The mandate a shared-utility caller's agent gets, and the only one it ever
 * gets from here.
 *
 * `PAPER` with owner approval required, so even if something later widened the
 * mode this mandate still would not authorise an unattended live trade. The
 * ceilings are deliberately generous, because a paper trade spends nothing and
 * a tight ceiling here would only make the simulation unrepresentative: the
 * real limits that matter are the ones an owner sets on their own agent for
 * live trading, and this is not that.
 *
 * Not exported as something a caller can influence. It takes no arguments on
 * purpose, so there is no request shape that reaches it.
 */
export function utilityPaperMandate(): {
  mode: 'PAPER';
  approval: 'OWNER_APPROVES_EACH';
  venues: readonly string[];
  networks: readonly string[];
  allowedAssets: readonly unknown[];
  maxPerTrade: string;
  maxPerDay: string;
  maxOpenExposure: string;
  maxOpenPositions: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  minLiquidityBase: string;
  maxFeeBase: string;
  quoteMaxAgeMs: number;
  expiresAt: string | null;
  paused: boolean;
} {
  return {
    mode: 'PAPER',
    approval: 'OWNER_APPROVES_EACH',
    // Every venue this build knows, because refusing a venue on paper teaches
    // nobody anything and the venue list is what a caller is exploring.
    venues: [...TRADE_VENUE_IDS],
    /*
     * Every network this build knows, and every asset the caller has asked
     * about so far.
     *
     * Both lists were empty, and the risk gate denies `NETWORK_NOT_ALLOWED`
     * on a network outside the list and `NO_ASSETS_ALLOWED` on an empty one.
     * So no paper trade could ever have reached a fill through this surface:
     * a mandate shaped like a mandate that refused everything. It passed its
     * own tests because nothing could price a market, so no trade got as far
     * as the gate.
     *
     * The asset list is the one bound a standing sandbox cannot express: it
     * has to be written before anybody has said what they want to look at. It
     * therefore grows, through `widenedUtilitySandbox`, and what it is is a
     * record of what a caller explored rather than a restriction on them.
     * That is honest on paper and only on paper: nothing here can move value,
     * the mode is PAPER, and `widenedUtilitySandbox` cannot change that or
     * anything else that would matter to a live trade.
     */
    networks: [...WALLET_NETWORK_IDS],
    allowedAssets: [],
    maxPerTrade: '1000000000000000000000',
    maxPerDay: '1000000000000000000000',
    maxOpenExposure: '1000000000000000000000',
    maxOpenPositions: 100,
    maxSlippageBps: 10_000,
    maxPriceImpactBps: 10_000,
    /*
     * One base unit, because zero is not a legal amount.
     *
     * `BaseUnits` refuses zero, so the mandate this function returned could
     * not be saved at all and every paper trade through this surface failed
     * with "Min Liquidity Base: An amount has to be more than zero". One unit
     * means "any depth the reader could actually see", which is the right
     * floor here: that depth was *read* is already enforced, because the risk
     * gate refuses a snapshot whose `liquidityBase` is null, and how much
     * depth is enough is the caller's own judgement rather than a sandbox's.
     */
    minLiquidityBase: '1',
    maxFeeBase: '1000000000000000000000',
    // Thirty seconds, the same freshness a live trade would demand, because a
    // paper fill against a stale quote is a simulation of nothing.
    quoteMaxAgeMs: 30_000,
    expiresAt: null,
    paused: false,
  };
}

/**
 * The same sandbox mandate, now also listing the assets of one request.
 *
 * Written as a pure function over the mandate it is handed so that what it may
 * and may not change is testable rather than a promise in a comment. It
 * returns null when nothing needs to change, which is the ordinary case after
 * a caller's first trade in a pair.
 *
 * It only ever adds to `allowedAssets`. Every other field is carried across
 * untouched, including the three that would matter if this were ever reached
 * by anything but paper: `mode`, `approval` and `paused`. Nothing here can
 * widen a limit, extend an expiry, unpause a mandate or make a trade live.
 */
export function widenedUtilitySandbox<T extends { mode: string; allowedAssets: readonly unknown[] }>(
  mandate: T,
  assets: readonly AssetRefValue[],
): T | null {
  // Not a paper mandate, so not this function's to touch. An owner's own
  // mandate is never widened by somebody calling an API.
  if (mandate.mode !== 'PAPER') return null;

  const have = new Set((mandate.allowedAssets as AssetRefValue[]).map((asset) => assetKey(asset)));
  const missing = assets.filter((asset) => !have.has(assetKey(asset)));
  if (missing.length === 0) return null;

  // Deduplicated on the way in: a trade of an asset against itself is already
  // refused upstream, but two references to one asset must not become two rows.
  const added: AssetRefValue[] = [];
  for (const asset of missing) {
    if (added.some((seen) => assetKey(seen) === assetKey(asset))) continue;
    added.push(asset);
  }
  return { ...mandate, allowedAssets: [...(mandate.allowedAssets as AssetRefValue[]), ...added] };
}
