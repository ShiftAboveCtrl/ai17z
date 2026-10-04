import { MarketSnapshot, TRADE_VENUES, assetKey, type AssetRef, type TradeVenue } from '@xbam/shared/contracts';

/**
 * What a venue looks like now, and who said so.
 *
 * Reading a venue means talking to a chain or a broker, which is adapter work
 * and is not in this repository, exactly as wallet signing is not. This is the
 * contract an adapter implements, the registry that holds them, and the rules
 * about what an answer has to carry before anything financial may rest on it.
 *
 * The rule that shapes everything here: **authoritative venue state wins.** A
 * cached price, an aggregator, a mirror and a model's recollection are all
 * worth less than what the chain says, so a snapshot records where it came
 * from and when, and `freshnessOf` is how a caller finds out whether it may
 * still be used rather than assuming it may.
 */

/** What a first-party market adapter supplies for one venue family. */
export interface MarketReader {
  id: string;
  version: string;
  venues: readonly TradeVenue[];
  /**
   * The current state of one asset on one venue.
   *
   * Returns null when the venue genuinely has nothing to say about this asset,
   * and throws a sentence when the read failed. Those are different: a venue
   * that does not list an asset is an answer, and a node that timed out is
   * not, and a trade must never be priced off the difference being ignored.
   */
  read(asset: AssetRef, venue: TradeVenue): Promise<MarketSnapshot | null>;
}

const readers = new Map<string, MarketReader>();

export function registerMarketReader(reader: MarketReader): void {
  for (const venue of reader.venues) readers.set(venue, reader);
}

export function resetMarketReadersForTest(): void {
  readers.clear();
}

export function readerFor(venue: TradeVenue): MarketReader | null {
  return readers.get(venue) ?? null;
}

export function marketReadiness(venue: TradeVenue): { ready: boolean; detail: string } {
  const reader = readers.get(venue);
  if (reader) return { ready: true, detail: `${reader.id} ${reader.version} reads ${TRADE_VENUES[venue].label}.` };
  return { ready: false, detail: `No market reader is installed for ${TRADE_VENUES[venue].label}, so it cannot be priced.` };
}

export type MarketOutcome =
  | { outcome: 'OK'; snapshot: MarketSnapshot }
  /** The venue has nothing to say about this asset. An answer, not a failure. */
  | { outcome: 'NOT_LISTED'; detail: string }
  /** Nobody can read this venue here. */
  | { outcome: 'NO_READER'; detail: string }
  /** The read failed. Never to be treated as a price. */
  | { outcome: 'UNAVAILABLE'; detail: string };

/**
 * Read a venue, and keep the four answers apart.
 *
 * The distinction that matters is between NOT_LISTED and UNAVAILABLE. One
 * means the asset is not there; the other means we could not find out. Both
 * stop a trade, and collapsing them is how "the node was down" gets recorded
 * as "the token does not exist" and then, later, as a reason to do something.
 *
 * A snapshot that comes back for the wrong asset or the wrong venue is a
 * failure rather than a curiosity: an adapter that answers a different
 * question than the one asked is the shape of a bug that prices one token off
 * another.
 */
export async function readMarket(asset: AssetRef, venue: TradeVenue): Promise<MarketOutcome> {
  const reader = readers.get(venue);
  if (!reader) return { outcome: 'NO_READER', detail: marketReadiness(venue).detail };

  let raw: MarketSnapshot | null;
  try {
    raw = await reader.read(asset, venue);
  } catch (error) {
    return { outcome: 'UNAVAILABLE', detail: (error as Error).message || 'The market read failed.' };
  }
  if (!raw) return { outcome: 'NOT_LISTED', detail: `${TRADE_VENUES[venue].label} does not list this asset.` };

  const parsed = MarketSnapshot.safeParse(raw);
  if (!parsed.success) {
    return { outcome: 'UNAVAILABLE', detail: `The reader answered with something that is not a market snapshot: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  const snapshot = parsed.data;
  if (snapshot.venue !== venue) {
    return { outcome: 'UNAVAILABLE', detail: `Asked ${venue} and was answered about ${snapshot.venue}.` };
  }
  if (assetKey(snapshot.asset) !== assetKey(asset)) {
    return { outcome: 'UNAVAILABLE', detail: 'The reader answered about a different asset than the one asked for.' };
  }
  if (snapshot.phase !== TRADE_VENUES[venue].phase) {
    // A curve venue answering with a pool phase, or the reverse, means the
    // reader and the venue list disagree about what this venue is.
    return { outcome: 'UNAVAILABLE', detail: `${venue} is a ${TRADE_VENUES[venue].phase} venue and the reader said ${snapshot.phase}.` };
  }
  return { outcome: 'OK', snapshot };
}

/**
 * How old a snapshot is, and whether that is still inside a bound.
 *
 * Separate from the risk engine so a screen can show an owner the age without
 * asking whether a trade would be allowed, and so the comparison is in one
 * place rather than wherever somebody needed it.
 */
export function freshnessOf(snapshot: MarketSnapshot, maxAgeMs: number, now: Date = new Date()): {
  ageMs: number;
  fresh: boolean;
  detail: string;
} {
  const ageMs = now.getTime() - Date.parse(snapshot.observedAt);
  if (ageMs < 0) {
    return { ageMs, fresh: false, detail: 'The snapshot claims to have been observed after now.' };
  }
  const fresh = ageMs <= maxAgeMs;
  return {
    ageMs,
    fresh,
    detail: fresh ? `Observed ${ageMs}ms ago, inside ${maxAgeMs}ms.` : `Observed ${ageMs}ms ago, past the ${maxAgeMs}ms bound.`,
  };
}
