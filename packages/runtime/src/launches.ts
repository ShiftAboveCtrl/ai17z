/**
 * Noticing that something is being launched, and refusing to say anything about
 * it that was not read somewhere.
 *
 * This is the part of the product where a confident sentence does real damage.
 * `docs/ENGINEERING.md` already forbids inventing a contract address, a price,
 * a liquidity figure or a pair, and the reason is not squeamishness: an agent
 * that states a contract address it half-remembers sends somebody's money to a
 * stranger. So this file has one rule and everything else follows from it.
 *
 * **Nothing here produces a fact. It only records where one was seen.**
 *
 * Every address carries the posts it appeared in and the accounts that posted
 * it. No price, no liquidity, no volume and no pair information is derived
 * here at all -- those come from the market lookup, which quotes its source,
 * and they are a different subsystem on purpose.
 *
 * The one judgement this file does make is a warning, and it is the honest kind:
 * when several different addresses are being posted for one ticker, at most one
 * of them can be right. That is arithmetic rather than an opinion, and it is
 * the shape of nearly every launch that goes badly.
 *
 * It offers no view on whether anything is worth buying. There is no code path
 * from here to a wallet, and there is not meant to be one.
 */

/** One post that appeared to be about a launch. */
export interface LaunchMention {
  statusId: string;
  handle: string;
  text: string;
  postedAt?: string;
}

export interface ClaimedAddress {
  value: string;
  chain: 'EVM' | 'SOLANA';
  /** The posts it was seen in. The evidence, and the only evidence. */
  seenIn: string[];
  /** The accounts that posted it. */
  claimedBy: string[];
}

export interface LaunchSignal {
  /** The cashtag as written, including the sign. */
  ticker: string;
  mentions: number;
  authors: number;
  firstSeenAt?: string;
  addresses: ClaimedAddress[];
  /** Warnings that follow from the evidence, never from a judgement of intent. */
  warnings: string[];
  /** What this cannot know, stated rather than left as an implication. */
  gaps: string[];
}

export interface LaunchReading {
  launches: LaunchSignal[];
  gaps: string[];
}

/** Fewer accounts than this and it is one person posting, not a launch. */
const MIN_AUTHORS = 2;

/**
 * An EVM address is unambiguous. A Solana one is base58 of a plausible length,
 * which also describes a great many things that are not addresses -- so it is
 * matched only as a standalone token of the right length, and even then the
 * word "address" is never used about it without the post it came from.
 */
const EVM = /\b0x[a-fA-F0-9]{40}\b/g;
const SOLANA = /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g;

/** Cashtags, as written. `$eth` and the word "eth" are different claims. */
const CASHTAG = /\$[A-Za-z][A-Za-z0-9_]{1,14}\b/g;

/** Addresses literally present in a piece of text. Nothing is normalised away. */
export function addressesIn(text: string): { value: string; chain: 'EVM' | 'SOLANA' }[] {
  const found: { value: string; chain: 'EVM' | 'SOLANA' }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(EVM)) {
    // Case is preserved. An EVM address carries a checksum in its capitals, and
    // lower-casing it throws away the one self-check the string has.
    if (seen.has(match[0].toLowerCase())) continue;
    seen.add(match[0].toLowerCase());
    found.push({ value: match[0], chain: 'EVM' });
  }
  for (const match of text.matchAll(SOLANA)) {
    if (/^0x/i.test(match[0])) continue;
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    found.push({ value: match[0], chain: 'SOLANA' });
  }
  return found;
}

/** Cashtags in a piece of text, lower-cased for grouping but kept with the sign. */
export function tickersIn(text: string): string[] {
  return [...new Set([...text.matchAll(CASHTAG)].map((match) => match[0].toLowerCase()))];
}

export function readLaunchSignals(mentions: LaunchMention[]): LaunchReading {
  const gaps: string[] = [];
  interface TickerEntry {
    mentions: number;
    authors: Set<string>;
    firstSeenAt?: string;
    addresses: Map<string, ClaimedAddress>;
  }
  const byTicker = new Map<string, TickerEntry>();

  let addressWithoutTicker = 0;

  for (const mention of mentions) {
    const handle = mention.handle.replace(/^@+/, '').toLowerCase();
    const tickers = tickersIn(mention.text);
    const addresses = addressesIn(mention.text);
    if (tickers.length === 0) {
      if (addresses.length > 0) addressWithoutTicker += 1;
      continue;
    }

    for (const ticker of tickers) {
      const entry: TickerEntry = byTicker.get(ticker) ?? {
        mentions: 0,
        authors: new Set<string>(),
        addresses: new Map<string, ClaimedAddress>(),
      };
      entry.mentions += 1;
      entry.authors.add(handle);
      if (mention.postedAt && (!entry.firstSeenAt || mention.postedAt < entry.firstSeenAt)) {
        entry.firstSeenAt = mention.postedAt;
      }
      for (const address of addresses) {
        const key = address.chain === 'EVM' ? address.value.toLowerCase() : address.value;
        const claimed = entry.addresses.get(key) ?? {
          value: address.value,
          chain: address.chain,
          seenIn: [],
          claimedBy: [],
        };
        if (!claimed.seenIn.includes(mention.statusId)) claimed.seenIn.push(mention.statusId);
        if (!claimed.claimedBy.includes(handle)) claimed.claimedBy.push(handle);
        entry.addresses.set(key, claimed);
      }
      byTicker.set(ticker, entry);
    }
  }

  if (addressWithoutTicker > 0) {
    gaps.push(
      `${addressWithoutTicker} post${addressWithoutTicker === 1 ? '' : 's'} carried an address with no ticker, so there is nothing to group ${addressWithoutTicker === 1 ? 'it' : 'them'} under.`,
    );
  }

  const launches: LaunchSignal[] = [];
  for (const [ticker, entry] of byTicker) {
    if (entry.authors.size < MIN_AUTHORS) continue;
    const addresses = [...entry.addresses.values()].sort((a, b) => b.claimedBy.length - a.claimedBy.length);
    const warnings: string[] = [];
    const signalGaps: string[] = [];

    if (addresses.length > 1) {
      // Arithmetic, not an accusation: a ticker has one contract, and this many
      // different ones are being posted for it.
      warnings.push(
        `${addresses.length} different addresses are being posted for ${ticker}. At most one of them is the right one, and this cannot tell you which.`,
      );
    }
    if (addresses.length === 0) {
      signalGaps.push('No address has been posted, so there is nothing here that identifies a specific token.');
    }
    for (const address of addresses) {
      if (address.claimedBy.length === 1) {
        signalGaps.push(`${address.value} has been posted by one account only.`);
      }
    }
    // Said in every case, because the absence of a warning is not a reassurance.
    signalGaps.push('Nothing here checks whether any of this is genuine. Verify an address at its source before acting on it.');

    launches.push({
      ticker,
      mentions: entry.mentions,
      authors: entry.authors.size,
      ...(entry.firstSeenAt ? { firstSeenAt: entry.firstSeenAt } : {}),
      addresses,
      warnings,
      gaps: signalGaps,
    });
  }

  launches.sort((a, b) => b.authors - a.authors || b.mentions - a.mentions || a.ticker.localeCompare(b.ticker));
  return { launches, gaps };
}
