/**
 * What a token's vesting streams say, as lines a reply may carry.
 *
 * Every figure is an exact integer string in the token's base units, or null.
 * Null is "not read", and it is printed as "unavailable", never as zero. The
 * template is fixed and has no adjectives, so a rewrite has nothing to improve
 * and the lines say only what an account holds and when its own schedule ends.
 *
 * It is a separate template from the evidence card on purpose: the card's
 * signature is being changed by several open branches, and these lines are
 * produced by a read the card does not run. Both can call this once they meet.
 */
export interface VestingReading {
  /** FOUND: at least one stream account was decoded. NONE_SEEN: none among the accounts that were read. */
  status: 'FOUND' | 'NONE_SEEN';
  decimals: number | null;
  /** Sum of what unfinished streams still hold, in base units. */
  totalLockedAmount: string | null;
  /** Per cent of supply, rounded down to two places. */
  supplyPctLocked: number | null;
  /** Streams whose end time is still ahead. */
  unfinishedStreams: number;
  nextUnlockAt: string | null;
  nextUnlockAmount: string | null;
  unlockingNext7DaysAmount: string | null;
  /** A stream releases by the second or the minute, so no single next date exists. */
  releasingNow: boolean;
  lastUnlockAt: string | null;
  endedStreams: number;
  /** Self-owned token accounts whose stream could not be read. */
  unrecognized: number;
  /** Candidate accounts left unread by the ceiling or the deadline. */
  notRead: number;
  /** How many of the largest token accounts were looked at. */
  accountsRead: number;
  slot: number | null;
  source: string;
}

/** Base units as a decimal string, cut rather than rounded, trailing zeros dropped. */
export function unitsText(amount: string | null, decimals: number | null): string {
  if (amount === null || !/^\d+$/.test(amount)) return 'unavailable';
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return `${amount} base units`;
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals, padded.length - decimals + 4).replace(/0+$/, '');
  // A balance too small for four places is still a balance, so it is never shown as a bare zero.
  if (whole === '0' && !fraction && BigInt(amount) > 0n) return '<0.0001';
  return fraction ? `${whole}.${fraction}` : whole;
}

function pctText(pct: number | null): string {
  return typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? `${pct}%` : 'unavailable';
}

function slotText(slot: number | null): string {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 ? String(slot) : 'unavailable';
}

export const NO_SCHEDULED_RELEASE = 'no scheduled release date on record';
export const OTHER_LOCKERS_NOT_READ = 'only Streamflow is read; other lockers are not';

export function renderVestingLines(reading: VestingReading): string[] {
  const scope = `scope: ${reading.accountsRead} largest token accounts; source: ${reading.source}; slot: ${slotText(reading.slot)}`;
  const lines: string[] = [];
  if (reading.unfinishedStreams > 0) {
    const noun = reading.unfinishedStreams === 1 ? 'stream' : 'streams';
    lines.push(`Vesting: ${reading.unfinishedStreams} unfinished ${noun} [held: ${unitsText(reading.totalLockedAmount, reading.decimals)}; share of supply: ${pctText(reading.supplyPctLocked)}; ${scope}]`);
    if (reading.nextUnlockAt) {
      lines.push(`Next scheduled release: ${reading.nextUnlockAt} [amount: ${unitsText(reading.nextUnlockAmount, reading.decimals)}; next 7 days: ${unitsText(reading.unlockingNext7DaysAmount, reading.decimals)}]`);
    } else if (reading.releasingNow) {
      lines.push(`Releasing continuously [next 7 days: ${unitsText(reading.unlockingNext7DaysAmount, reading.decimals)}]`);
    } else {
      lines.push(`Next scheduled release: unavailable [a schedule this reader cannot decode]`);
    }
    if (reading.lastUnlockAt) lines.push(`Last stream ends: ${reading.lastUnlockAt}`);
  } else {
    lines.push(`Vesting: ${NO_SCHEDULED_RELEASE} [${scope}]`);
    // None seen is a statement about the accounts that were read, never about the token as a whole.
    if (reading.status === 'NONE_SEEN') lines.push(`No Streamflow stream seen among the ${reading.accountsRead} largest token accounts`);
  }
  if (reading.endedStreams > 0) lines.push(`Ended streams: ${reading.endedStreams}`);
  if (reading.unrecognized > 0) lines.push(`Unrecognized lock contract: ${reading.unrecognized} ${reading.unrecognized === 1 ? 'account' : 'accounts'} not decoded, not counted`);
  if (reading.notRead > 0) lines.push(`Not read: ${reading.notRead} ${reading.notRead === 1 ? 'account' : 'accounts'} past the read ceiling or deadline, so figures are a lower bound`);
  lines.push(`Scope: ${OTHER_LOCKERS_NOT_READ}`);
  return lines;
}
