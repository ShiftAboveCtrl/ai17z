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
import { z } from 'zod';
import { AssetRef, TRADE_VENUE_IDS, TRADE_SIDES } from '@xbam/shared/contracts';

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
} as const;

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
  })
  .strict();

export const PaperPortfolioInput = z.object({}).strict();

/** Which schema belongs to which capability, in one place. */
export function inputSchemaFor(capability: UtilityCapability): z.ZodTypeAny {
  switch (capability) {
    case 'trading.paper_trade':
      return PaperTradeInput;
    case 'trading.paper_portfolio':
      return PaperPortfolioInput;
    case 'market.snapshot':
      return MarketSnapshotInput;
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
    networks: [],
    allowedAssets: [],
    maxPerTrade: '1000000000000000000000',
    maxPerDay: '1000000000000000000000',
    maxOpenExposure: '1000000000000000000000',
    maxOpenPositions: 100,
    maxSlippageBps: 10_000,
    maxPriceImpactBps: 10_000,
    minLiquidityBase: '0',
    maxFeeBase: '1000000000000000000000',
    // Thirty seconds, the same freshness a live trade would demand, because a
    // paper fill against a stale quote is a simulation of nothing.
    quoteMaxAgeMs: 30_000,
    expiresAt: null,
    paused: false,
  };
}
