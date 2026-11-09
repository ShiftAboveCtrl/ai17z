import { z } from 'zod';

/**
 * The paper league bridge, as this installation reads and writes it.
 *
 * The endpoints are specified in `docs/architecture/STUDIO_LEAGUE_BRIDGE.md`.
 * This file is the allowlist for everything that crosses that boundary, in
 * both directions. Every object is `.strict()`: a field nobody agreed to is a
 * refusal of the whole document, not a field quietly ignored, because a client
 * that drops what it did not expect also drops the evidence that the other side
 * changed.
 *
 * Everything is simulated. `simulated` is a literal `true` wherever a figure
 * appears, so a document that says otherwise does not parse.
 *
 * The season rules are Studio's `SeasonRulesSchema` narrowed to what this
 * installation can honour. A season it cannot confine a paper mandate to is
 * refused here, before anything is written, not half-applied.
 */

export const LEAGUE_PROTOCOL = 1 as const;

export const LEAGUE_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const SlugSchema = z.string().regex(LEAGUE_SLUG, 'Use lowercase letters, digits and hyphens.');

/**
 * The only quote assets a season may use: two USD stablecoins on Solana,
 * identified by mint, symbol and decimals together.
 *
 * Why not any mint: the rules carry a liquidity floor in dollars, and a mandate
 * carries it in the quote's base units. For a dollar stablecoin the conversion
 * is exact; for anything else it is a price, which a frozen rule cannot carry.
 * A lookalike mint called USDC fails here because the address is part of the
 * identity, not the symbol.
 */
export const LEAGUE_QUOTES = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
} as const;

const Instant = z.iso.datetime();
const Sentence = z.string().max(300);
const Digits = z.string().regex(/^[0-9]{1,78}$/, 'A whole number of base units, written in digits.');
const SolanaMint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'An exact Solana mint.');

export const MAX_SEASON_DAYS = 14;
export const MIN_SEASON_HOURS = 1;
/** How long after a season ends Studio may still take a report of its fills. */
export const MAX_REPORT_GRACE_HOURS = 168;

// ---------------------------------------------------------------------------
// The season
// ---------------------------------------------------------------------------

export const LeagueRules = z
  .object({
    version: z.literal(1),
    /** Simulated money against public prices. A season that says otherwise is refused. */
    paperOnly: z.literal(true),
    quote: z
      .object({
        symbol: z.string().min(1).max(12),
        network: z.literal('solana'),
        address: SolanaMint,
        decimals: z.number().int().min(0).max(18),
      })
      .strict(),
    /** Every entrant starts with exactly this, in the quote's whole units, and it is never topped up. */
    capital: z.number().positive().max(1_000_000),
    /**
     * Solana tokens only. A season over named markets lists nothing this
     * installation could confine a mandate to, so it is refused rather than
     * guessed at.
     */
    universe: z
      .object({
        kind: z.literal('SOLANA_MEMECOINS'),
        lists: z.array(z.enum(['recent', 'trending', 'traded', 'organic'])).min(1).max(4),
      })
      .strict(),
    strategies: z
      .array(z.object({ id: SlugSchema, title: z.string().min(2).max(60), summary: z.string().min(2).max(300) }).strict())
      .min(1)
      .max(6),
    risks: z.array(z.enum(['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'])).min(1).max(3),
    costs: z.object({ feeBps: z.number().int().min(0).max(1000), model: z.string().min(2).max(400) }).strict(),
    bounds: z
      .object({
        maxOpenPositions: z.number().int().min(1).max(10),
        maxTradePct: z.number().min(1).max(100),
        minLiquidityUsd: z.number().int().min(0).max(100_000_000),
      })
      .strict(),
    sampling: z
      .object({
        readEverySeconds: z.number().int().min(900).max(86_400),
        maxMarkAgeSeconds: z.number().int().min(900).max(172_800),
      })
      .strict(),
    minEntrants: z.number().int().min(1).max(200),
    tieBreaks: z.array(z.enum(['RETURN_BPS', 'MAX_DRAWDOWN_BPS', 'COSTS', 'LOCKED_AT'])).min(1).max(4),
    standingLoss: z.literal('STOP_NEW_ACTIVITY_KEEP_RESULTS'),
    withdrawal: z.literal('KEEP_RESULTS_UNRANKED'),
    missingValuation: z.literal('UNRANKED_UNTIL_VALUED'),
  })
  .strict()
  .superRefine((r, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const known = (LEAGUE_QUOTES as Record<string, { symbol: string; decimals: number }>)[r.quote.address];
    if (!known) fail(['quote', 'address'], 'The quote is not an asset this installation can hold a paper mandate to.');
    else if (known.symbol !== r.quote.symbol || known.decimals !== r.quote.decimals) {
      fail(['quote'], 'The quote\'s symbol and decimals do not match its mint.');
    }
    if (new Set(r.strategies.map((s) => s.id)).size !== r.strategies.length) fail(['strategies'], 'Strategy ids must be unique.');
    if (new Set(r.tieBreaks).size !== r.tieBreaks.length) fail(['tieBreaks'], 'Each tie-break may be listed once.');
    if (new Set(r.risks).size !== r.risks.length) fail(['risks'], 'Each risk level may be listed once.');
    if (r.sampling.maxMarkAgeSeconds < r.sampling.readEverySeconds) fail(['sampling', 'maxMarkAgeSeconds'], 'A price must be allowed to be at least as old as the reading interval.');
  });
export type LeagueRules = z.infer<typeof LeagueRules>;

export const LEAGUE_SEASON_STATUSES = ['OPEN', 'LOCKED', 'RUNNING', 'FINALIZED', 'CANCELLED'] as const;

export const LeagueSeasonDocument = z
  .object({
    protocol: z.literal(LEAGUE_PROTOCOL),
    simulated: z.literal(true),
    source: z.literal('ai17z-studio'),
    generated_at: Instant,
    season: z
      .object({
        slug: SlugSchema,
        title: z.string().min(3).max(80),
        status: z.enum(LEAGUE_SEASON_STATUSES),
        entry_closes_at: Instant,
        starts_at: Instant,
        ends_at: Instant,
        /** The last instant Studio takes a report of a fill. After it, a fill is not counted. */
        fills_accepted_until: Instant,
        max_entrants: z.number().int().min(1).max(200),
        /** SHA-256 of the canonical JSON of `rules`. Recomputed here, never trusted. */
        rules_hash: z.string().regex(/^[0-9a-f]{64}$/),
        rules: LeagueRules,
      })
      .strict(),
    /** Whether this season takes an entrant that runs on its owner's own installation. */
    local_agents: z.object({ allowed: z.boolean(), note: Sentence.nullable() }).strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const s = doc.season;
    const t = (v: string) => Date.parse(v);
    if (t(s.entry_closes_at) > t(s.starts_at)) fail(['season', 'starts_at'], 'The season starts before entry closes.');
    const hours = (t(s.ends_at) - t(s.starts_at)) / 3_600_000;
    if (hours < MIN_SEASON_HOURS) fail(['season', 'ends_at'], 'A season runs at least an hour.');
    if (hours > MAX_SEASON_DAYS * 24) fail(['season', 'ends_at'], `A season runs at most ${MAX_SEASON_DAYS} days.`);
    if (t(s.fills_accepted_until) < t(s.ends_at)) fail(['season', 'fills_accepted_until'], 'Fills would stop being taken before the season ends.');
    if ((t(s.fills_accepted_until) - t(s.ends_at)) / 3_600_000 > MAX_REPORT_GRACE_HOURS) fail(['season', 'fills_accepted_until'], 'The report window after the season is too long.');
    if (s.rules.minEntrants > s.max_entrants) fail(['season', 'rules', 'minEntrants'], 'The minimum number of entrants exceeds the cap.');
  });
export type LeagueSeasonDocument = z.infer<typeof LeagueSeasonDocument>;

// ---------------------------------------------------------------------------
// Entering
// ---------------------------------------------------------------------------

/**
 * An alias is shown to everybody, so it is checked here the way Studio checks
 * it and Studio remains the authority: letters, digits and single spaces, dots,
 * underscores or hyphens inside, 3 to 24 characters, nothing link-shaped and
 * nothing that looks like an address.
 */
export const LeagueAlias = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*[A-Za-z0-9]$/, 'Letters, digits, spaces, dots, hyphens and underscores.')
  .refine((v) => !/[._-]{2,}/.test(v), 'Do not repeat punctuation.')
  .refine((v) => !/(https?|www|\.com|\.io|\.xyz|\.org|\.net|\.sol)/i.test(v), 'An alias cannot be a link.')
  .refine((v) => !/^0x[0-9a-f]{6,}$/i.test(v) && !/^[1-9A-HJ-NP-Za-km-z]{18,}$/.test(v), 'An alias cannot look like a wallet address.');

export const LeagueEntryRequest = z
  .object({
    protocol: z.literal(LEAGUE_PROTOCOL),
    /** Idempotency key: the same key is the same entry, however many times it is sent. */
    entry_key: z.uuid(),
    /** The hash of the rules this entrant read and agreed to. Studio refuses a different one. */
    rules_hash: z.string().regex(/^[0-9a-f]{64}$/),
    alias: LeagueAlias,
    entrant: z.literal('LOCAL_AGENT'),
  })
  .strict();
export type LeagueEntryRequest = z.infer<typeof LeagueEntryRequest>;

const EntryId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const LeagueEntryAnswer = z
  .object({
    protocol: z.literal(LEAGUE_PROTOCOL),
    entry_id: EntryId,
    season_slug: SlugSchema,
    status: z.literal('ACTIVE'),
    entered_at: Instant,
  })
  .strict();
export type LeagueEntryAnswer = z.infer<typeof LeagueEntryAnswer>;

// ---------------------------------------------------------------------------
// Reporting fills
// ---------------------------------------------------------------------------

export const LEAGUE_FILLS_PER_REPORT = 50;

export const LeagueFill = z
  .object({
    /** Idempotency key. `f` and thirty-one hex digits; names nothing local. */
    fill_key: z.string().regex(/^f[0-9a-f]{31}$/),
    filled_at: Instant,
    side: z.enum(['BUY', 'SELL']),
    asset: z.object({ network: z.literal('solana'), address: SolanaMint, decimals: z.number().int().min(0).max(18) }).strict(),
    /** The season's quote mint, so Studio can refuse a fill priced in anything else. */
    quote_address: SolanaMint,
    /** What was spent, what arrived and the fee, in base units of the assets involved. */
    in_base: Digits,
    out_base: Digits,
    fee_base: Digits,
    /** Quote base units per one whole unit of the asset, at the moment of the fill. */
    price_base_units: Digits,
    priced_at: Instant,
    price_source: z.string().min(1).max(120),
    slippage_bps: z.number().int().min(0).max(10_000),
    price_impact_bps: z.number().int().min(0).max(10_000),
    simulated: z.literal(true),
  })
  .strict();
export type LeagueFill = z.infer<typeof LeagueFill>;

export const LeagueFillReport = z
  .object({
    protocol: z.literal(LEAGUE_PROTOCOL),
    entry_id: EntryId,
    fills: z.array(LeagueFill).min(1).max(LEAGUE_FILLS_PER_REPORT),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.fills.map((f) => f.fill_key)).size !== r.fills.length) ctx.addIssue({ code: 'custom', path: ['fills'], message: 'A fill is reported once per report.' });
  });
export type LeagueFillReport = z.infer<typeof LeagueFillReport>;

export const LEAGUE_FILL_REJECTIONS = [
  'ENTRY_NOT_ACTIVE',
  'SEASON_NOT_RUNNING',
  'OUTSIDE_SEASON',
  'AFTER_REPORT_DEADLINE',
  /** The same key arrived with different content. A fill is not edited. */
  'CONTENT_CHANGED',
  'INVALID',
] as const;

export const LeagueFillAnswer = z
  .object({
    protocol: z.literal(LEAGUE_PROTOCOL),
    simulated: z.literal(true),
    /** Taken now. */
    accepted: z.array(z.string().regex(/^f[0-9a-f]{31}$/)).max(LEAGUE_FILLS_PER_REPORT),
    /** Already held with identical content: a replay, counted once. */
    duplicates: z.array(z.string().regex(/^f[0-9a-f]{31}$/)).max(LEAGUE_FILLS_PER_REPORT),
    rejected: z
      .array(z.object({ fill_key: z.string().regex(/^f[0-9a-f]{31}$/), reason: z.enum(LEAGUE_FILL_REJECTIONS) }).strict())
      .max(LEAGUE_FILLS_PER_REPORT),
  })
  .strict();
export type LeagueFillAnswer = z.infer<typeof LeagueFillAnswer>;

// ---------------------------------------------------------------------------
// Standing
// ---------------------------------------------------------------------------

const SignedBps = z.number().int().min(-10_000).max(1_000_000);

export const LeagueStandingDocument = z
  .object({
    protocol: z.literal(LEAGUE_PROTOCOL),
    simulated: z.literal(true),
    source: z.literal('ai17z-studio'),
    generated_at: Instant,
    season_slug: SlugSchema,
    entry_id: EntryId,
    season_status: z.enum(LEAGUE_SEASON_STATUSES),
    entry_status: z.enum(['ACTIVE', 'WITHDRAWN', 'STOPPED']),
    /** What the figures rest on. Fills the entrant reported are not fills Studio watched. */
    basis: z.literal('REPORTED_BY_ENTRANT'),
    standing: z
      .object({
        state: z.enum(['NOT_STARTED', 'PENDING', 'RANKED', 'UNRANKED']),
        rank: z.number().int().min(1).max(200).nullable(),
        of: z.number().int().min(1).max(200).nullable(),
        /** Net of costs, on starting capital, signed. A loss is negative. */
        return_bps: SignedBps.nullable(),
        max_drawdown_bps: z.number().int().min(0).max(10_000).nullable(),
        fills_counted: z.number().int().min(0).max(1_000_000),
        last_mark_at: Instant.nullable(),
        reason: Sentence.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['standing'], message });
    const s = doc.standing;
    if (s.state === 'RANKED') {
      if (s.rank === null || s.of === null || s.return_bps === null) fail('A ranked entry states its rank, the field and its return.');
      else if (s.rank > s.of) fail('A rank beyond the size of the field.');
    } else {
      if (s.rank !== null) fail('Only a ranked entry has a rank.');
    }
    if (s.state === 'NOT_STARTED' && (s.return_bps !== null || s.fills_counted !== 0)) fail('A season that has not started has no figures.');
  });
export type LeagueStandingDocument = z.infer<typeof LeagueStandingDocument>;
