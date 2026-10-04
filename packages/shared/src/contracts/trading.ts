import { z } from 'zod';
import { BaseUnits, WALLET_NETWORKS, WalletNetworkId, addressShapeOk, type WalletFamily, type WalletNetwork } from './wallet';

/**
 * What an agent may ask to trade, and the bounds it is asked inside.
 *
 * The division of labour here is the whole point. A model may produce a
 * `TradeIntent`: a request, in exact base units, naming an asset by chain and
 * contract. It may not produce transaction bytes, choose a destination, widen
 * a limit, or reach anything that signs. Everything between the intent and the
 * chain is deterministic and lives below the model: the mandate the owner
 * wrote, the risk checks, a quote that has to still be true, a simulation, and
 * an approval.
 *
 * This file is the vocabulary only. It holds no network access, no signing and
 * no venue arithmetic, for the same reason `wallet.ts` holds none: the parts
 * that can move value are supplied by first-party adapters the owner installs,
 * and they are not in this repository.
 *
 * Money is never a float. Every amount is a decimal string of the smallest
 * unit, reusing `BaseUnits` from the wallet vocabulary so there is one rule
 * about it rather than two.
 */

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

/**
 * Where a trade can happen, named by the thing that actually executes it.
 *
 * Pons V1, Pons V2 on its curve, and Pons V2 after graduation are three
 * venues, not three states of one. V1 holds a locked one-sided Uniswap V3
 * position; V2 mints into a constant-product curve that graduates into a
 * locked full-range Uniswap V4 pool. The arithmetic, the failure modes and the
 * transaction shape differ, so merging them is how an agent sells into a pool
 * that is not there. The same reasoning separates Pump's bonding curve from
 * PumpSwap.
 *
 * Which venue an asset is on is read from chain state, never inferred from a
 * ticker, a name or a user interface label.
 */
export const TRADE_VENUES = {
  PONS_V1: { label: 'Pons V1', family: 'EVM', networks: ['robinhood'], phase: 'POOL' },
  PONS_V2_CURVE: { label: 'Pons V2 (curve)', family: 'EVM', networks: ['robinhood'], phase: 'CURVE' },
  PONS_V2_GRADUATED: { label: 'Pons V2 (graduated)', family: 'EVM', networks: ['robinhood'], phase: 'POOL' },
  PUMP_CURVE: { label: 'Pump.fun (bonding curve)', family: 'SOLANA', networks: ['solana'], phase: 'CURVE' },
  PUMP_SWAP: { label: 'PumpSwap', family: 'SOLANA', networks: ['solana'], phase: 'POOL' },
  ROBINHOOD: { label: 'Robinhood', family: 'BROKER', networks: [], phase: 'BROKER' },
} as const satisfies Record<
  string,
  { label: string; family: WalletFamily | 'BROKER'; networks: readonly WalletNetwork[]; phase: 'CURVE' | 'POOL' | 'BROKER' }
>;
export type TradeVenue = keyof typeof TRADE_VENUES;
export const TRADE_VENUE_IDS = Object.keys(TRADE_VENUES) as [TradeVenue, ...TradeVenue[]];
export const TradeVenueId = z.enum(TRADE_VENUE_IDS);

/** Whether a venue can execute on a network at all. Shape check, not a permission. */
export function venueSupportsNetwork(venue: TradeVenue, network: WalletNetwork): boolean {
  return (TRADE_VENUES[venue].networks as readonly string[]).includes(network);
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Exactly which asset, with no room for a near miss.
 *
 * A ticker is not an identity: anybody can mint a token called anything. An
 * asset is its chain plus its contract or mint, and a broker instrument is its
 * venue plus the symbol that venue lists. `decimals` travels so amounts can be
 * shown to a person, and an adapter is still expected to check it against the
 * chain rather than trust what it was handed.
 */
const AssetRefShape = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ONCHAIN'),
      network: WalletNetworkId,
      /** Contract on EVM, mint on Solana. */
      address: z.string().trim().min(32).max(64),
      decimals: z.number().int().min(0).max(36),
      /** For display only. Never used to decide what something is. */
      symbol: z.string().trim().min(1).max(32).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('NATIVE'),
      network: WalletNetworkId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('BROKER_INSTRUMENT'),
      venue: z.literal('ROBINHOOD'),
      symbol: z.string().trim().min(1).max(32),
    })
    .strict(),
]);

/**
 * The address shape is checked on the union rather than inside the member,
 * because a discriminated union needs plain objects to read the discriminator
 * from and a refinement would wrap one in an effect.
 */
export const AssetRef = AssetRefShape.superRefine((a, ctx) => {
  if (a.kind !== 'ONCHAIN') return;
  const family = WALLET_NETWORKS[a.network].family;
  if (!addressShapeOk(family, a.address)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not shaped like a ${family} address or mint.`, path: ['address'] });
  }
});
export type AssetRef = z.infer<typeof AssetRefShape>;

/** A stable key for one asset, so two references to the same thing compare equal. */
export function assetKey(asset: AssetRef): string {
  if (asset.kind === 'NATIVE') return `native:${asset.network}`;
  if (asset.kind === 'BROKER_INSTRUMENT') return `broker:${asset.venue}:${asset.symbol.toUpperCase()}`;
  // Case folded because EVM addresses are case insensitive and a mixed-case
  // copy of the same contract must not read as a different asset.
  return `onchain:${asset.network}:${asset.address.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------

/**
 * What a venue looked like at one identified moment.
 *
 * The block or slot is what makes this checkable later. A quote without one is
 * an anecdote: it cannot be revalidated, so it can only be trusted, and a
 * trade that rests on trust is a trade nobody can reconstruct afterwards.
 *
 * `liquidityBase` is absent rather than zero when the reader could not see it.
 * Absent is not zero anywhere in AI17Z, and it matters most here: a pool whose
 * depth is unknown must fail a minimum-liquidity check, not pass it as empty.
 */
export const MarketSnapshot = z
  .object({
    venue: TradeVenueId,
    network: WalletNetworkId.nullable(),
    asset: AssetRef,
    quoteAsset: AssetRef,
    /** EVM block number or Solana slot, as a string because both outgrow 2^53. */
    atBlock: z.string().regex(/^[0-9]{1,20}$/).nullable(),
    observedAt: z.string().datetime(),
    /** Quote asset base units per one whole unit of `asset`. */
    priceBaseUnits: BaseUnits,
    liquidityBase: BaseUnits.nullable(),
    /** Hundredths of a basis point, so 1_000_000 is 100 per cent. */
    feeMicroBps: z.number().int().min(0).max(1_000_000).nullable(),
    phase: z.enum(['CURVE', 'POOL', 'BROKER']),
    source: z.string().trim().min(1).max(120),
  })
  .strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

/**
 * How an owner says what an agent may do with money, and nothing wider.
 *
 * Every bound is a ceiling the agent operates under, not a target. The model
 * cannot author or edit one: a mandate arrives from the owner, and the risk
 * engine reads it. `paused` is checked again at execution time rather than
 * only when a trade is proposed, because the interesting moment to stop
 * something is after it was approved and before it is sent.
 */
export const TRADE_MODES = ['PAPER', 'LIVE'] as const;
export const TradeMode = z.enum(TRADE_MODES);
export type TradeMode = (typeof TRADE_MODES)[number];

export const APPROVAL_MODES = [
  /** Every executable trade waits for the owner. The default, and the only one that ships on. */
  'OWNER_APPROVES_EACH',
  /** Inside the mandate, no per-trade approval. Live autonomy; off unless the owner turns it on. */
  'AUTONOMOUS_WITHIN_MANDATE',
] as const;
export const ApprovalMode = z.enum(APPROVAL_MODES);
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const TradeMandate = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    /** PAPER never signs anything, whatever else this mandate allows. */
    mode: TradeMode.default('PAPER'),
    approval: ApprovalMode.default('OWNER_APPROVES_EACH'),
    venues: z.array(TradeVenueId).min(1),
    networks: z.array(WalletNetworkId),
    /** Empty means no asset has been allowed yet, which denies everything. */
    allowedAssets: z.array(AssetRef),
    maxPerTrade: BaseUnits,
    maxPerDay: BaseUnits,
    maxOpenExposure: BaseUnits,
    maxOpenPositions: z.number().int().min(0).max(1000),
    /** Basis points, so 50 is 0.5 per cent. */
    maxSlippageBps: z.number().int().min(0).max(10_000),
    maxPriceImpactBps: z.number().int().min(0).max(10_000),
    minLiquidityBase: BaseUnits,
    maxFeeBase: BaseUnits,
    /** How old a quote may be when execution is attempted. */
    quoteMaxAgeMs: z.number().int().min(250).max(300_000),
    expiresAt: z.string().datetime().nullable(),
    paused: z.boolean().default(false),
  })
  .strict();
export type TradeMandate = z.infer<typeof TradeMandate>;

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * The states a trade passes through, each committed before the next begins.
 *
 * `SIGNED` and `SUBMITTED` exist separately on purpose. Between them is the
 * only window where AI17Z has created something irreversible and does not yet
 * know what happened to it, and the recovery rule for that window is to ask
 * the chain or the broker about the identity it already has. A second
 * transaction is never created because the first answer did not arrive, so
 * there is a state for "we do not know" and it is not a synonym for failure.
 */
export const TRADE_INTENT_STATUSES = [
  'DRAFTED',
  'RISK_REJECTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SIMULATED',
  'SIGNED',
  'SUBMITTED',
  /** Submitted, outcome unknown. Reconciled by identity, never resent. */
  'UNKNOWN',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  /** Ran the whole path with real market data and deliberately did not sign. */
  'PAPER_FILLED',
] as const;
export const TradeIntentStatus = z.enum(TRADE_INTENT_STATUSES);
export type TradeIntentStatus = (typeof TRADE_INTENT_STATUSES)[number];

/** Statuses from which a new signature must never be produced. */
export const TRADE_NO_RESIGN_STATUSES: readonly TradeIntentStatus[] = ['SIGNED', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED'];

export const TradeSide = z.enum(['BUY', 'SELL']);
export type TradeSide = z.infer<typeof TradeSide>;

export const TradeIntent = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    mandateId: z.string().uuid(),
    mode: TradeMode,
    venue: TradeVenueId,
    network: WalletNetworkId.nullable(),
    side: TradeSide,
    assetIn: AssetRef,
    assetOut: AssetRef,
    /** The most that may leave. An adapter may spend less and never more. */
    maxIn: BaseUnits,
    /** The least that may arrive, after slippage. */
    minOut: BaseUnits,
    maxSlippageBps: z.number().int().min(0).max(10_000),
    maxPriceImpactBps: z.number().int().min(0).max(10_000),
    maxFeeBase: BaseUnits,
    /** The snapshot this was decided from, kept so it can be revalidated. */
    quote: MarketSnapshot,
    expiresAt: z.string().datetime(),
    status: TradeIntentStatus,
    /** One intent per decision. A retry carries the same key and makes no second trade. */
    idempotencyKey: z.string().trim().min(8).max(200),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((i, ctx) => {
    if (assetKey(i.assetIn) === assetKey(i.assetOut)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An intent cannot trade an asset for itself.', path: ['assetOut'] });
    }
    if (i.network && !venueSupportsNetwork(i.venue, i.network)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${TRADE_VENUES[i.venue].label} does not execute on ${WALLET_NETWORKS[i.network].label}.`,
        path: ['network'],
      });
    }
  });
export type TradeIntent = z.infer<typeof TradeIntent>;

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

/**
 * The scopes at which trading can be stopped.
 *
 * Enforced below the model, and re-read at execution time rather than cached
 * with the decision: a pause is worth having precisely when something has
 * already been approved.
 */
export const TRADE_PAUSE_SCOPES = ['GLOBAL', 'RUNTIME', 'AGENT', 'VENUE', 'WALLET'] as const;
export const TradePauseScope = z.enum(TRADE_PAUSE_SCOPES);
export type TradePauseScope = (typeof TRADE_PAUSE_SCOPES)[number];
