import { createHash } from 'node:crypto';
import type { PaperFillIntent } from '@xbam/database';
import {
  LeagueFill,
  LeagueSeasonDocument,
  MarketSnapshot,
  assetKey,
  type AssetRef,
  type LeagueRules,
  type LeagueStandingDocument,
  type TradeMandate,
} from '@xbam/shared/contracts';

/**
 * The pure half of the paper league bridge: what a season document is allowed
 * to mean here. No database, no network, no clock except the one passed in.
 *
 * `docs/architecture/STUDIO_LEAGUE_BRIDGE.md` is the account; the points that
 * matter for this file:
 *
 * - A season is parsed strictly and its hash recomputed before it can become
 *   anything. A payload that fails either is refused whole.
 * - The only mandate this file can produce is a PAPER one. The mode is a
 *   literal in the return type, and nothing in this module imports a signer, a
 *   wallet or the live trade path (`tests/unit/leagueBridge.test.ts` reads the
 *   source to keep it that way).
 * - Figures are labelled simulated and paper wherever they are said.
 */

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** JSON with keys sorted at every level, so one document has one hash wherever it was built. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const leagueRulesHash = (rules: LeagueRules): string => createHash('sha256').update(canonicalJson(rules)).digest('hex');

// ---------------------------------------------------------------------------
// Reading a season
// ---------------------------------------------------------------------------

export type SeasonRead = { ok: true; season: LeagueSeasonDocument } | { ok: false; why: string };

/**
 * A season exactly as Studio published it, or a sentence for why not.
 *
 * Refused before anything is written: an unknown field, an unknown quote asset,
 * a universe this installation cannot confine, an oversized limit, dates that do
 * not order, a hash that is not the hash of the rules beside it, or a season for
 * a different slug than the one asked for.
 */
export function parseSeason(raw: unknown, askedSlug: string): SeasonRead {
  const parsed = LeagueSeasonDocument.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || 'document';
    return { ok: false, why: `Studio's season is not one this installation will apply (${where}: ${first?.message ?? 'unreadable'}), so none of it was used.` };
  }
  const season = parsed.data;
  if (season.season.slug !== askedSlug) return { ok: false, why: 'Studio answered for a different season than the one asked for, so none of it was used.' };
  if (leagueRulesHash(season.season.rules) !== season.season.rules_hash) {
    return { ok: false, why: "The season's rules do not match the hash Studio published for them, so none of it was used." };
  }
  return { ok: true, season };
}

/** Whether a read season may be newly entered now. Distinct from whether it is valid. */
export function judgeEntry(season: LeagueSeasonDocument, now: Date): { ok: true } | { ok: false; why: string } {
  const s = season.season;
  if (!season.local_agents.allowed) return { ok: false, why: season.local_agents.note ?? 'This season does not take an agent that runs on its owner\'s own installation.' };
  if (s.status !== 'OPEN') return { ok: false, why: `Entry to this season is not open (it is ${s.status.toLowerCase()}).` };
  if (now.getTime() >= Date.parse(s.entry_closes_at)) return { ok: false, why: 'Entry to this season has closed. An entry is not taken after the lock, and cannot be backfilled.' };
  return { ok: true };
}

/** How old a season or standing document may be and still be believed. Studio stamps every answer. */
export const LEAGUE_MAX_AGE_MS = 15 * 60_000;
const FUTURE_SLACK_MS = 5 * 60_000;

/** Whether a document's own date makes it current, so a copy that sat in a cache is recognised by its date. */
export function isCurrent(generatedAt: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(generatedAt);
  return age <= LEAGUE_MAX_AGE_MS && age >= -FUTURE_SLACK_MS;
}

// ---------------------------------------------------------------------------
// The season mandate
// ---------------------------------------------------------------------------

/** Slippage and impact ceilings the season does not name. Deliberately tight: a simulation errs towards the worse fill. */
export const LEAGUE_MAX_SLIPPAGE_BPS = 300;
export const LEAGUE_MAX_IMPACT_BPS = 300;
/** A fee ceiling per trade, in basis points of the trade: the season's own fee rate, never less than this. */
const FEE_CEILING_FLOOR_BPS = 100;

/** `capital` as an exact integer of base units, or null when it cannot be written exactly. */
export function baseUnitsOf(whole: number, decimals: number): bigint | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  const text = whole.toFixed(decimals);
  // A number with more fractional digits than the asset has would be silently
  // rounded by toFixed. A rule that cannot be written exactly is refused.
  if (Number(text) !== whole) return null;
  const [int = '0', frac = ''] = text.split('.');
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export type SeasonMandate = Omit<TradeMandate, 'id' | 'agentId'> & { mode: 'PAPER'; approval: 'OWNER_APPROVES_EACH'; protectiveExits: null };

/**
 * The paper mandate a season means for one agent.
 *
 * Its limits are the season's own, in the quote's base units. It expires when
 * the season ends. It is owner-approves-each and carries no protective exits,
 * which is what the existing paper machinery requires of a mandate it will
 * trust, and what makes it unable to be anything but a paper one.
 */
export function mandateFromSeason(rules: LeagueRules, endsAt: string): { ok: true; mandate: SeasonMandate } | { ok: false; why: string } {
  const decimals = rules.quote.decimals;
  const capital = baseUnitsOf(rules.capital, decimals);
  if (capital === null || capital <= 0n) return { ok: false, why: 'The season\'s capital cannot be written exactly in the quote asset, so no mandate was made.' };
  const tradeBps = BigInt(Math.floor(rules.bounds.maxTradePct * 100));
  const perTrade = (capital * tradeBps) / 10_000n;
  if (perTrade <= 0n) return { ok: false, why: 'The season\'s per-trade limit rounds to nothing in the quote asset, so no mandate was made.' };
  const feeBps = BigInt(Math.max(rules.costs.feeBps, FEE_CEILING_FLOOR_BPS));
  const feeCeiling = (perTrade * feeBps) / 10_000n;
  const floorUsd = BigInt(rules.bounds.minLiquidityUsd) * 10n ** BigInt(decimals);
  return {
    ok: true,
    mandate: {
      mode: 'PAPER',
      approval: 'OWNER_APPROVES_EACH',
      venues: ['AMM_POOL_SOLANA'],
      networks: ['solana'],
      allowedAssets: [],
      // Any Solana token, bounded by the same limits. The season's own universe
      // lists are Studio's to enforce when it values fills; the quote and the
      // network are the part this installation can confine.
      assetScope: 'ANY_SOLANA_TOKEN',
      maxPerTrade: perTrade.toString(),
      maxPerDay: capital.toString(),
      maxOpenExposure: capital.toString(),
      maxOpenPositions: rules.bounds.maxOpenPositions,
      maxSlippageBps: LEAGUE_MAX_SLIPPAGE_BPS,
      maxPriceImpactBps: LEAGUE_MAX_IMPACT_BPS,
      minLiquidityBase: (floorUsd > 0n ? floorUsd : 1n).toString(),
      maxFeeBase: (feeCeiling > 0n ? feeCeiling : 1n).toString(),
      quoteMaxAgeMs: 60_000,
      expiresAt: endsAt,
      paused: false,
      protectiveExits: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/** The key a fill is reported under: derived from the entry key and the intent, so it names nothing local. */
export function fillKeyOf(entryKey: string, intentId: string): string {
  return `f${createHash('sha256').update(`${entryKey}:${intentId}`).digest('hex').slice(0, 31)}`;
}

export const contentHashOf = (payload: unknown): string => createHash('sha256').update(canonicalJson(payload)).digest('hex');

export type FillVerdict = { ok: true; fill: LeagueFill } | { ok: false; why: string };

const DIGITS = /^[0-9]{1,78}$/;

/**
 * One paper fill, as a report of it, or the reason it is not one.
 *
 * Only the allowlisted figures leave. The fill must be priced in the season's
 * quote against a Solana token, and fall inside the season. Everything else is
 * kept locally as LOCAL_ONLY with the sentence returned here, never sent.
 */
export function fillFromIntent(
  entryKey: string,
  fill: PaperFillIntent,
  season: { quoteAddress: string; startsAt: string; endsAt: string },
): FillVerdict {
  // One fill with a malformed record must cost only that fill. Anything the
  // checks below did not anticipate in a stored row (a null asset, a date that
  // is not a date) degrades it to "not counted" instead of aborting the batch.
  try {
    return fillFromIntentChecked(entryKey, fill, season);
  } catch {
    return { ok: false, why: 'The record of this fill is unreadable, so it is not counted.' };
  }
}

function fillFromIntentChecked(
  entryKey: string,
  fill: PaperFillIntent,
  season: { quoteAddress: string; startsAt: string; endsAt: string },
): FillVerdict {
  const at = Date.parse(fill.filledAt);
  if (at < Date.parse(season.startsAt)) return { ok: false, why: 'Made before the season started, so it is not counted.' };
  if (at > Date.parse(season.endsAt)) return { ok: false, why: 'Made after the season ended, so it is not counted.' };
  const quoteIsIn = fill.side === 'BUY';
  const quote: AssetRef = quoteIsIn ? fill.assetIn : fill.assetOut;
  const token: AssetRef = quoteIsIn ? fill.assetOut : fill.assetIn;
  if (quote.kind !== 'ONCHAIN' || quote.network !== 'solana' || quote.address !== season.quoteAddress) {
    return { ok: false, why: "Not priced in the season's quote asset, so it is not counted." };
  }
  if (token.kind !== 'ONCHAIN' || token.network !== 'solana') return { ok: false, why: 'Not a Solana token, so it is not counted.' };
  const post = fill.postcondition;
  if (!fill.executedOn || !post || typeof post !== 'object' || Array.isArray(post)) return { ok: false, why: 'The record of this fill is incomplete, so it is not counted.' };
  const snapshot = MarketSnapshot.safeParse(fill.executedOn);
  if (!snapshot.success) return { ok: false, why: 'The price recorded for this fill is malformed, so it is not counted.' };
  const executed = snapshot.data;
  if (assetKey(executed.asset) !== assetKey(token)) return { ok: false, why: 'The price recorded is for another asset, so the fill is not counted.' };
  const { inBase, outBase, feeBase, slippageBps, priceImpactBps } = post as Record<string, unknown>;
  if (![inBase, outBase, feeBase].every((v) => typeof v === 'string' && DIGITS.test(v))) return { ok: false, why: 'The amounts of this fill are incomplete, so it is not counted.' };
  const candidate = {
    fill_key: fillKeyOf(entryKey, fill.intentId),
    filled_at: new Date(at).toISOString(),
    side: fill.side,
    asset: { network: 'solana' as const, address: token.address, decimals: token.decimals },
    quote_address: quote.address,
    in_base: inBase as string,
    out_base: outBase as string,
    fee_base: feeBase as string,
    price_base_units: executed.priceBaseUnits,
    priced_at: new Date(Date.parse(executed.observedAt)).toISOString(),
    price_source: executed.source.slice(0, 120),
    slippage_bps: Number.isInteger(slippageBps) ? Math.min(10_000, Math.max(0, slippageBps as number)) : 0,
    price_impact_bps: Number.isInteger(priceImpactBps) ? Math.min(10_000, Math.max(0, priceImpactBps as number)) : 0,
    simulated: true as const,
  };
  const parsed = LeagueFill.safeParse(candidate);
  return parsed.success ? { ok: true, fill: parsed.data } : { ok: false, why: 'This fill does not fit the report Studio takes, so it is not counted.' };
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC';

export function describeReturn(bps: number): string {
  if (bps === 0) return 'no net change';
  const pct = (Math.abs(bps) / 100).toFixed(2);
  return bps > 0 ? `a simulated net gain of ${pct}%` : `a simulated net loss of ${pct}%`;
}

const CAVEAT = 'These are simulated paper results, not real trades, and they say nothing about future results.';

/** What the agent says about a standing Studio gave. Names Studio, says simulated and paper, and never guesses. */
export function describeStanding(doc: LeagueStandingDocument, seasonTitle: string): string {
  const s = doc.standing;
  const lead = `In the AI17Z Studio paper league season "${seasonTitle}" (simulated, paper only), `;
  const basis = 'Studio worked this out from the paper fills this agent reported.';
  switch (s.state) {
    case 'NOT_STARTED':
      return `${lead}this agent is entered and the season has not started, so nothing is counted yet. ${CAVEAT}`;
    case 'RANKED':
      return (
        `${lead}this agent is ranked ${s.rank} of ${s.of}, with ${describeReturn(s.return_bps ?? 0)} after costs (${s.return_bps} bps), as of ${when(doc.generated_at)}. ` +
        `${s.fills_counted} paper fill${s.fills_counted === 1 ? '' : 's'} counted. ${basis} ${CAVEAT}`
      );
    case 'PENDING':
      return `${lead}this agent has no rank yet: ${s.reason ?? 'Studio has no usable valuation for it'}. I will not guess at one. ${basis} ${CAVEAT}`;
    case 'UNRANKED':
      return `${lead}this agent is not ranked${s.reason ? `: ${s.reason}` : ''}. ${basis} ${CAVEAT}`;
  }
}

/** What the agent says when it cannot check. It still says what is true locally, and never a rank. */
export function describeUnavailable(why: string, entry: { seasonSlug: string; endsAt: string } | null): string {
  const local = entry ? ` Its simulated paper mandate for "${entry.seasonSlug}" is still in place here until ${when(entry.endsAt)}.` : '';
  return `I cannot check the league standing on Studio right now. ${why}${local} I will not guess at a rank.`;
}
