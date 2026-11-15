import { renderVestingLines, type VestingReading } from '@xbam/prompts';
import {
  SOLANA_FAMILY,
  ask,
  exactInteger,
  isAddress,
  type SolanaQuery,
  type SolanaResult,
} from '@xbam/upstream';
import {
  TOKEN_UNLOCKS_CACHE_MS,
  TOKEN_UNLOCKS_MAX_STREAMS,
  TOKEN_UNLOCKS_PROTOCOL,
  type TokenUnlocksFound,
} from '@xbam/shared/contracts';
import { base58 } from './solanaInspect';

/**
 * What a token's Streamflow vesting streams say, read from the chain.
 *
 * ### Where the layout comes from
 *
 * Streamflow's stream metadata account (`streamLayout` in the js-sdk,
 * `packages/stream/solana/layout.ts`) is 1104 bytes owned by the stream
 * program. The offsets below were checked on 2026-11-15 against live mainnet
 * accounts rather than taken on trust: for three live streams, the 32 bytes at
 * 177 were the mint, the 32 bytes at 209 were an existing token account of that
 * mint, and that token account's owner was itself. That last fact is what makes
 * the search below possible, and a fixture cannot prove it.
 *
 * ### How a stream is found without scanning
 *
 * `getProgramAccounts` is not an allowed read, because it is the request that
 * gets a node to stop answering. So the search starts from the mint's holders:
 *
 * 1. The twenty largest token accounts of the mint.
 * 2. A stream's escrow is a token account whose SPL owner is its own address.
 *    Only those are candidates.
 * 3. A candidate's oldest transaction is the one that created the stream. Its
 *    Streamflow instruction names the metadata account. The metadata account
 *    is accepted only when the stream program owns it and it names this mint
 *    and this escrow back. Anything weaker is not a stream.
 *
 * The seed derivation of the escrow was tried as the proof instead and does not
 * hold: two of three live escrows are not derived from their metadata account
 * with the documented seeds, so the back-reference is the proof.
 *
 * ### What this refuses to say
 *
 * Only the largest twenty token accounts are looked at, so a stream held
 * outside them is not seen, and a result says so as its scope. Only Streamflow
 * is decoded. A candidate that no stream names back is counted as an
 * unrecognized lock contract and never as locked. A balance is "held in an
 * unfinished stream" only when the stream's own end time was read and is ahead.
 * A date is a date. Nothing here says what a release will do to a price.
 */

export const STREAMFLOW_VESTING_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
export const VESTING_SOURCE = 'solana.read_vesting_streams';

/** Byte offsets in a Streamflow stream metadata account. */
export const STREAM_LAYOUT = {
  createdAt: 9,
  withdrawn: 17,
  canceledAt: 25,
  endTime: 33,
  mint: 177,
  escrowTokens: 209,
  startTime: 409,
  netAmountDeposited: 417,
  period: 425,
  amountPerPeriod: 433,
  cliff: 441,
  cliffAmount: 449,
} as const;
/** Through the `cliff_amount` u64. Live accounts are 1104 bytes; a shorter one is not a stream. */
const STREAM_MIN_BYTES = STREAM_LAYOUT.cliffAmount + 8;

const UNIX_MIN = 1_000_000_000n;
const UNIX_MAX = 10_000_000_000n;
const TOKEN_ACCOUNT_BYTES = 165;
const WEEK_SECONDS = 7n * 24n * 3600n;
/** A stream that releases more often than hourly has no one next date worth stating. */
const CONTINUOUS_BELOW_SECONDS = 3600n;

const HISTORY_PAGE = 1000;
const HISTORY_PAGES = 3;
const MAX_CREATION_ACCOUNTS = 24;
export const VESTING_RPC_TIMEOUT_MS = 8_000;
/** A whole read stops starting new streams after this long, and says how many it left. */
export const VESTING_DEADLINE_MS = 60_000;
export const VESTING_UNAVAILABLE_CACHE_MS = 30_000;
const CONSECUTIVE_FAILURES_BEFORE_STOP = 2;

// ── Decoding ─────────────────────────────────────────────────────────────────

export interface DecodedStream {
  createdAt: bigint;
  withdrawn: bigint;
  /** Zero when the stream was never cancelled. */
  canceledAt: bigint;
  endTime: bigint;
  startTime: bigint;
  netAmountDeposited: bigint;
  period: bigint;
  amountPerPeriod: bigint;
  cliff: bigint;
  cliffAmount: bigint;
  mint: string;
  escrowTokens: string;
}

function u64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
}

function key(data: Uint8Array, offset: number): string {
  return base58(data.subarray(offset, offset + 32));
}

/**
 * A stream metadata account's schedule, or null when the bytes are not one.
 * The caller has already checked that the stream program owns the account.
 * The sender and the recipient are not decoded: nothing here needs to say who.
 */
export function decodeStreamflowStream(data: Uint8Array): DecodedStream | null {
  if (data.length < STREAM_MIN_BYTES) return null;
  const endTime = u64(data, STREAM_LAYOUT.endTime);
  const startTime = u64(data, STREAM_LAYOUT.startTime);
  if (endTime < UNIX_MIN || endTime > UNIX_MAX || startTime < UNIX_MIN || startTime > UNIX_MAX) return null;
  return {
    createdAt: u64(data, STREAM_LAYOUT.createdAt),
    withdrawn: u64(data, STREAM_LAYOUT.withdrawn),
    canceledAt: u64(data, STREAM_LAYOUT.canceledAt),
    endTime,
    startTime,
    netAmountDeposited: u64(data, STREAM_LAYOUT.netAmountDeposited),
    period: u64(data, STREAM_LAYOUT.period),
    amountPerPeriod: u64(data, STREAM_LAYOUT.amountPerPeriod),
    cliff: u64(data, STREAM_LAYOUT.cliff),
    cliffAmount: u64(data, STREAM_LAYOUT.cliffAmount),
    mint: key(data, STREAM_LAYOUT.mint),
    escrowTokens: key(data, STREAM_LAYOUT.escrowTokens),
  };
}

// ── Schedule ─────────────────────────────────────────────────────────────────

/** When the cliff lands: its own time if it has one, else the start. */
function cliffTime(stream: DecodedStream): bigint {
  const at = stream.cliff > 0n ? stream.cliff : stream.startTime;
  return at < stream.startTime ? stream.startTime : at;
}

/** Whether the period and amounts describe a schedule this file can follow. */
export function scheduleReadable(stream: DecodedStream): boolean {
  return stream.period > 0n && stream.netAmountDeposited > 0n && stream.cliffAmount <= stream.netAmountDeposited
    && stream.startTime <= stream.endTime;
}

/**
 * How much of the stream has vested by a time, in base units, or null when the
 * schedule cannot be followed. Before the cliff nothing has; at the cliff the
 * cliff amount has; after it one amount per whole period, up to the deposit;
 * at the end the whole deposit.
 */
export function vestedAt(stream: DecodedStream, atSeconds: bigint): bigint | null {
  if (!scheduleReadable(stream)) return null;
  if (atSeconds >= stream.endTime) return stream.netAmountDeposited;
  const cliffAt = cliffTime(stream);
  if (atSeconds < cliffAt) return 0n;
  const stepped = stream.cliffAmount + ((atSeconds - cliffAt) / stream.period) * stream.amountPerPeriod;
  return stepped > stream.netAmountDeposited ? stream.netAmountDeposited : stepped;
}

/** The next moment after `from` at which more vests, and how much more. Null when nothing is left to vest. */
export function nextRelease(stream: DecodedStream, from: bigint): { at: bigint; amount: bigint } | null {
  const before = vestedAt(stream, from);
  if (before === null || from >= stream.endTime) return null;
  const cliffAt = cliffTime(stream);
  let at: bigint;
  if (from < cliffAt) at = stream.cliffAmount > 0n ? cliffAt : cliffAt + stream.period;
  else at = cliffAt + ((from - cliffAt) / stream.period + 1n) * stream.period;
  if (at > stream.endTime) at = stream.endTime;
  let amount = (vestedAt(stream, at) ?? before) - before;
  if (amount <= 0n && at < stream.endTime) {
    at = stream.endTime;
    amount = (vestedAt(stream, at) ?? before) - before;
  }
  return amount > 0n ? { at, amount } : null;
}

/** A stream already past its cliff that releases more often than hourly. */
export function releasesContinuously(stream: DecodedStream, from: bigint): boolean {
  return scheduleReadable(stream) && from >= cliffTime(stream) && stream.period < CONTINUOUS_BELOW_SECONDS
    && stream.amountPerPeriod > 0n;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface ResolvedStream {
  /** The stream's metadata account. Carried for provenance, never put in a Studio payload. */
  account: string;
  escrow: string;
  /** What the escrow still holds, from the mint's own holder list. */
  held: bigint;
  stream: DecodedStream;
}

export interface VestingRead {
  status: 'FOUND' | 'NONE_SEEN';
  mint: string;
  decimals: number | null;
  supply: bigint | null;
  accountsRead: number;
  streams: ResolvedStream[];
  /** Self-owned token accounts that no stream names back. */
  unrecognized: number;
  /** Candidates left unread by a failure, the ceiling or the deadline. */
  notRead: number;
  slot: number | null;
  source: string;
  fetchedAt: string;
}

export interface RpcAnswer { result: unknown; slot: number | null; source: string; fetchedAt: string }
export type SolanaRpc = (method: SolanaQuery['method'], params: unknown[]) => Promise<RpcAnswer>;

export function solanaRpc(commitment: SolanaQuery['commitment'] = 'finalized'): SolanaRpc {
  return async (method, params) => {
    const answer = await ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, { method, params, commitment }, {
      signal: AbortSignal.timeout(VESTING_RPC_TIMEOUT_MS),
    });
    return { result: answer.value.result, slot: answer.value.slot, source: answer.provenance.upstreamId, fetchedAt: answer.provenance.fetchedAt };
  };
}

function valueOf(result: unknown): unknown {
  if (result && typeof result === 'object' && 'value' in result) return (result as { value: unknown }).value;
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function decodeData(data: unknown): Uint8Array | null {
  const raw = Array.isArray(data) ? data[0] : data;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return new Uint8Array(Buffer.from(raw, 'base64'));
}

interface AccountRow { owner: string | null; data: Uint8Array | null }

async function accounts(rpc: SolanaRpc, addresses: string[], commitment: string): Promise<AccountRow[]> {
  const answer = await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment }]);
  const list = valueOf(answer.result);
  if (!Array.isArray(list)) throw new Error('The cluster answered with something that is not a list of accounts.');
  return addresses.map((_, i) => {
    const row = list[i];
    if (!row || typeof row !== 'object') return { owner: null, data: null };
    const info = record(row);
    return { owner: typeof info.owner === 'string' ? info.owner : null, data: decodeData(info.data) };
  });
}

/** A token account whose SPL owner is its own address, of this mint. Streamflow's escrow has this shape. */
export function isSelfOwnedTokenAccount(address: string, mint: string, data: Uint8Array | null): boolean {
  if (!data || data.length < TOKEN_ACCOUNT_BYTES) return false;
  return key(data, 0) === mint && key(data, 32) === address;
}

/** Every account a Streamflow instruction in this transaction names, outer or inner, except the escrow itself. */
export function streamflowAccountsIn(transaction: unknown, escrow: string): string[] {
  const root = record(transaction);
  const message = record(record(root.transaction).message);
  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  const inner = (Array.isArray(record(root.meta).innerInstructions) ? record(root.meta).innerInstructions as unknown[] : [])
    .flatMap((group) => (Array.isArray(record(group).instructions) ? record(group).instructions as unknown[] : []));
  const found: string[] = [];
  for (const raw of [...outer, ...inner]) {
    const ix = record(raw);
    if (ix.programId !== STREAMFLOW_VESTING_PROGRAM || !Array.isArray(ix.accounts)) continue;
    for (const account of ix.accounts) {
      if (typeof account === 'string' && account !== escrow && account !== STREAMFLOW_VESTING_PROGRAM && isAddress(account) && !found.includes(account)) {
        found.push(account);
      }
    }
  }
  return found.slice(0, MAX_CREATION_ACCOUNTS);
}

/** Immutable once known: the accounts the creating instruction named, by escrow. */
const creationAccounts = new Map<string, string[]>();

async function creationAccountsOf(rpc: SolanaRpc, escrow: string, commitment: string): Promise<string[] | null> {
  const known = creationAccounts.get(escrow);
  if (known) return known;
  let before: string | undefined;
  let oldest: string | null = null;
  let reachedStart = false;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const answer = await rpc('getSignaturesForAddress', [escrow, { limit: HISTORY_PAGE, commitment, ...(before ? { before } : {}) }]);
    const rows = Array.isArray(answer.result) ? answer.result.map(record).filter((row) => typeof row.signature === 'string') : [];
    // Nothing older than what was already seen: that page was the start.
    if (rows.length === 0) { reachedStart = true; break; }
    const succeeded = rows.filter((row) => (row.err ?? null) === null);
    if (succeeded.length > 0) oldest = succeeded[succeeded.length - 1]!.signature as string;
    if (rows.length < HISTORY_PAGE) { reachedStart = true; break; }
    before = rows[rows.length - 1]!.signature as string;
  }
  // A history longer than the pages read has an older start that was not seen.
  if (!reachedStart || !oldest) return null;
  const answer = await rpc('getTransaction', [oldest, { commitment, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  if (!answer.result) return null;
  const named = streamflowAccountsIn(answer.result, escrow);
  if (named.length === 0) return null;
  creationAccounts.set(escrow, named);
  return named;
}

export function resetVestingCacheForTest(): void {
  cache.clear();
  creationAccounts.clear();
}

const cache = new Map<string, { at: number; ttl: number; value: VestingRead | null; error: string | null }>();

interface ReadOptions {
  commitment?: SolanaQuery['commitment'];
  rpc?: SolanaRpc;
  now?: () => number;
  deadlineMs?: number;
}

/**
 * Reads one mint's Streamflow streams. Throws when the holder list could not be
 * read, so the caller reports the read as failed and not as "no streams".
 * A candidate that failed to read is counted as not read, and two failures in
 * a row stop the read: the remainder is reported, never retried.
 */
export async function readTokenVesting(mint: string, options: ReadOptions = {}): Promise<VestingRead> {
  const commitment = options.commitment ?? 'finalized';
  const clock = options.now ?? Date.now;
  const cacheKey = `${mint}:${commitment}`;
  const hit = cache.get(cacheKey);
  if (hit && clock() - hit.at <= hit.ttl) {
    if (hit.value) return hit.value;
    throw new Error(hit.error ?? 'The vesting read failed a moment ago and is not being repeated yet.');
  }
  try {
    const value = await readUncached(mint, commitment, options.rpc ?? solanaRpc(commitment), clock, options.deadlineMs ?? VESTING_DEADLINE_MS);
    cache.set(cacheKey, { at: clock(), ttl: TOKEN_UNLOCKS_CACHE_MS, value, error: null });
    return value;
  } catch (error) {
    cache.set(cacheKey, { at: clock(), ttl: VESTING_UNAVAILABLE_CACHE_MS, value: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function readUncached(mint: string, commitment: string, rpc: SolanaRpc, clock: () => number, deadlineMs: number): Promise<VestingRead> {
  if (!isAddress(mint)) throw new Error('That is not a Solana mint address.');
  const started = clock();
  const [supplyAnswer, largestAnswer] = await Promise.all([
    rpc('getTokenSupply', [mint, { commitment }]),
    rpc('getTokenLargestAccounts', [mint, { commitment }]),
  ]);
  const supplyValue = record(valueOf(supplyAnswer.result));
  const supplyText = exactInteger(supplyValue.amount);
  const decimals = typeof supplyValue.decimals === 'number' ? supplyValue.decimals : null;
  const largest = valueOf(largestAnswer.result);
  if (!Array.isArray(largest)) throw new Error('The cluster answered with something that is not a list of token accounts.');
  const rows = largest.map(record)
    .map((row) => ({ address: typeof row.address === 'string' ? row.address : null, amount: exactInteger(row.amount) }))
    .filter((row): row is { address: string; amount: string } => row.address !== null && row.amount !== null && row.amount !== '0')
    .slice(0, TOKEN_UNLOCKS_MAX_STREAMS);

  const base = {
    mint, decimals, supply: supplyText === null ? null : BigInt(supplyText), accountsRead: rows.length,
    slot: largestAnswer.slot, source: VESTING_SOURCE, fetchedAt: largestAnswer.fetchedAt,
  };
  if (rows.length === 0) return { ...base, status: 'NONE_SEEN', streams: [], unrecognized: 0, notRead: 0 };

  const tokenAccounts = await accounts(rpc, rows.map((row) => row.address), commitment);
  const candidates = rows.filter((row, i) => isSelfOwnedTokenAccount(row.address, mint, tokenAccounts[i]!.data));

  const streams: ResolvedStream[] = [];
  let unrecognized = 0;
  let notRead = 0;
  let failures = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    if (clock() - started > deadlineMs || failures >= CONSECUTIVE_FAILURES_BEFORE_STOP) {
      notRead += candidates.length - i;
      break;
    }
    try {
      const named = await creationAccountsOf(rpc, candidate.address, commitment);
      if (!named) { unrecognized += 1; failures = 0; continue; }
      const rowsRead = await accounts(rpc, named, commitment);
      let matched: ResolvedStream | null = null;
      for (let at = 0; at < named.length && !matched; at += 1) {
        const row = rowsRead[at]!;
        if (row.owner !== STREAMFLOW_VESTING_PROGRAM || !row.data) continue;
        const decoded = decodeStreamflowStream(row.data);
        // The stream has to name this mint and this escrow back, or it is not this stream.
        if (decoded && decoded.mint === mint && decoded.escrowTokens === candidate.address) {
          matched = { account: named[at]!, escrow: candidate.address, held: BigInt(candidate.amount), stream: decoded };
        }
      }
      if (matched) streams.push(matched);
      else unrecognized += 1;
      failures = 0;
    } catch {
      // Deliberate: one failed candidate is reported as not read, and the loop's
      // failure counter is what stops a read that keeps failing.
      notRead += 1;
      failures += 1;
    }
  }
  return { ...base, status: streams.length > 0 ? 'FOUND' : 'NONE_SEEN', streams, unrecognized, notRead };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export type StreamState = 'LOCKED' | 'ENDED' | 'CANCELED';

export interface StreamSummary {
  state: StreamState;
  account: string;
  startAt: string | null;
  endAt: string;
  cliffAt: string | null;
  held: bigint;
  sharePct: number | null;
  scheduleReadable: boolean;
  continuous: boolean;
  next: { at: bigint; amount: bigint } | null;
  /** What vests in the next seven days, capped at what the stream holds. Null when the schedule cannot be followed. */
  nextWeek: bigint | null;
}

export interface VestingSummary extends VestingReading {
  streams: StreamSummary[];
  supply: bigint | null;
  mint: string;
  fetchedAt: string;
  noScheduledRelease: boolean;
}

const isoOf = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

/** Hundredths of a per cent, rounded down, or null when the supply is not known. */
function percentOf(part: bigint, whole: bigint | null): number | null {
  if (whole === null || whole <= 0n || part < 0n || part > whole) return null;
  return Number((part * 10_000n) / whole) / 100;
}

export function summarizeVesting(read: VestingRead, nowMs: number = Date.now()): VestingSummary {
  const now = BigInt(Math.floor(nowMs / 1000));
  const streams: StreamSummary[] = read.streams.map(({ account, held, stream }) => {
    const state: StreamState = stream.canceledAt > 0n ? 'CANCELED' : stream.endTime <= now ? 'ENDED' : 'LOCKED';
    const readable = scheduleReadable(stream);
    const continuous = state === 'LOCKED' && releasesContinuously(stream, now);
    const vestedNow = vestedAt(stream, now);
    const vestedLater = vestedAt(stream, now + WEEK_SECONDS);
    let nextWeek: bigint | null = null;
    if (state === 'LOCKED' && vestedNow !== null && vestedLater !== null) {
      const vests = vestedLater - vestedNow;
      nextWeek = vests > held ? held : vests;
    }
    return {
      state, account, held, scheduleReadable: readable, continuous, nextWeek,
      startAt: isoOf(stream.startTime), endAt: isoOf(stream.endTime),
      cliffAt: stream.cliff > 0n ? isoOf(stream.cliff) : null,
      sharePct: percentOf(held, read.supply),
      next: state === 'LOCKED' && !continuous ? nextRelease(stream, now) : null,
    };
  }).sort((a, b) => a.endAt.localeCompare(b.endAt));

  const unfinished = streams.filter((s) => s.state === 'LOCKED');
  const total = unfinished.reduce((sum, s) => sum + s.held, 0n);
  const soonest = unfinished.reduce<bigint | null>((at, s) => (s.next && (at === null || s.next.at < at) ? s.next.at : at), null);
  const nextAmount = soonest === null ? null
    : unfinished.reduce((sum, s) => (s.next && s.next.at === soonest ? sum + s.next.amount : sum), 0n);
  const weekKnown = unfinished.length > 0 && unfinished.every((s) => s.nextWeek !== null);
  const last = read.streams
    .filter((r) => unfinished.some((s) => s.account === r.account))
    .reduce<bigint | null>((at, r) => (at === null || r.stream.endTime > at ? r.stream.endTime : at), null);

  return {
    mint: read.mint,
    status: read.status,
    decimals: read.decimals,
    supply: read.supply,
    totalLockedAmount: unfinished.length > 0 ? total.toString() : null,
    supplyPctLocked: unfinished.length > 0 ? percentOf(total, read.supply) : null,
    unfinishedStreams: unfinished.length,
    nextUnlockAt: soonest === null ? null : isoOf(soonest),
    nextUnlockAmount: nextAmount === null ? null : nextAmount.toString(),
    unlockingNext7DaysAmount: weekKnown ? unfinished.reduce((sum, s) => sum + (s.nextWeek ?? 0n), 0n).toString() : null,
    releasingNow: unfinished.some((s) => s.continuous),
    lastUnlockAt: last === null ? null : isoOf(last),
    endedStreams: streams.length - unfinished.length,
    unrecognized: read.unrecognized,
    notRead: read.notRead,
    accountsRead: read.accountsRead,
    slot: read.slot,
    source: read.source,
    fetchedAt: read.fetchedAt,
    noScheduledRelease: unfinished.length === 0,
    streams,
  };
}

/** The reply-ready lines, in the fixed template. */
export function vestingStatement(summary: VestingSummary): string {
  return renderVestingLines(summary).join('\n');
}

/**
 * The shape documented for Studio in `docs/architecture/TOKEN_UNLOCKS.md`:
 * dates and amounts, and no stream, sender or recipient address.
 */
export function studioTokenUnlocksPayload(summary: VestingSummary): TokenUnlocksFound {
  return {
    protocol: TOKEN_UNLOCKS_PROTOCOL,
    chain: 'solana',
    address: summary.mint,
    status: summary.status,
    decimals: summary.decimals,
    supply: summary.supply === null ? null : summary.supply.toString(),
    totalLockedAmount: summary.totalLockedAmount,
    supplyPctLocked: summary.supplyPctLocked,
    nextUnlockAt: summary.nextUnlockAt,
    nextUnlockAmount: summary.nextUnlockAmount,
    unlockingNext7DaysAmount: summary.unlockingNext7DaysAmount,
    releasingNow: summary.releasingNow,
    lastUnlockAt: summary.lastUnlockAt,
    noScheduledRelease: summary.noScheduledRelease,
    endedStreams: summary.endedStreams,
    unrecognizedLockAccounts: summary.unrecognized,
    notRead: summary.notRead,
    accountsRead: summary.accountsRead,
    streams: summary.streams.map((s) => ({
      state: s.state,
      startAt: s.startAt,
      endAt: s.endAt,
      cliffAt: s.cliffAt,
      heldAmount: s.held.toString(),
      sharePct: s.sharePct,
      scheduleReadable: s.scheduleReadable,
      nextReleaseAt: s.next ? isoOf(s.next.at) : null,
      nextReleaseAmount: s.next ? s.next.amount.toString() : null,
    })),
    otherLockersRead: false,
    source: 'streamflow',
    slot: summary.slot,
    readAt: summary.fetchedAt,
    statement: vestingStatement(summary),
  };
}
