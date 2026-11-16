import type { CardReading } from '@xbam/prompts';
import {
  SOLANA_FAMILY,
  ask,
  isAddress,
  type MarketPairs,
  type MarketQuery,
  type SolanaQuery,
  type SolanaResult,
} from '@xbam/upstream';
import { base58 } from './solanaInspect';

/**
 * Whether a pool's LP tokens sit at a burn address or in a timelock we can read.
 *
 * A missing read stays null. Zero is only for a list of holders that came back
 * and contained none of the addresses below. An executable account, or one
 * owned by a program, is reported as held by that contract. It is not treated
 * as locked unless the program is one whose unlock time this file can read.
 */

/** Matches the five-minute freshness already used for the other card readings. */
export const LP_CACHE_MS = 5 * 60_000;
/** A failed read is retried soon. A success keeps the five-minute freshness. */
export const LP_UNAVAILABLE_CACHE_MS = 30_000;
/** One JSON-RPC call. The capability's own deadline is the sum, not this. */
export const LP_RPC_TIMEOUT_MS = 8_000;

/**
 * `getTokenLargestAccounts` can return twenty. Ten is the card's ceiling, so a
 * token check stays inside the public RPC budget shared with the other reads.
 */
export const MAX_LP_HOLDERS = 10;

/** How many candidate pools are opened when the index did not name one. */
const MAX_POOLS_TRIED = 3;

/**
 * Raydium AMM v4 `lpMint`, after the fee counters and the vault and mint keys.
 * Layout: raydium-io/raydium-sdk-v1 `LIQUIDITY_STATE_LAYOUT_V4`.
 */
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_AMM_V4_LP_MINT = 464;

/**
 * Raydium CPMM `lp_mint`, fifth pubkey after the 8-byte account discriminator
 * (`amm_config`, `pool_creator`, `token_0_vault`, `token_1_vault`).
 */
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_CPMM_LP_MINT = 136;

/**
 * SPL token-swap `pool_mint`: version, init flag, nonce, then three pubkeys.
 * Orca's legacy pools use this program.
 */
const ORCA_TOKEN_SWAP = '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP';
const ORCA_TOKEN_SWAP_LP_MINT = 99;

/**
 * Meteora dynamic AMM. The first pubkey after the discriminator is `lp_mint`.
 * Concentrated pools have no fungible LP mint, so they match nothing here.
 */
const METEORA_DAMM_V1 = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
const METEORA_DAMM_V1_LP_MINT = 8;

const LP_MINT_AT: Readonly<Record<string, number>> = {
  [RAYDIUM_AMM_V4]: RAYDIUM_AMM_V4_LP_MINT,
  [RAYDIUM_CPMM]: RAYDIUM_CPMM_LP_MINT,
  [ORCA_TOKEN_SWAP]: ORCA_TOKEN_SWAP_LP_MINT,
  [METEORA_DAMM_V1]: METEORA_DAMM_V1_LP_MINT,
};

/**
 * Burn destinations for an SPL balance.
 *
 * The system program is a real account and a common owner of ordinary wallets,
 * so a balance there is not a burn. The incinerator is an address with no
 * private key, which is what a permanent burn sends LP to.
 */
export const SOLANA_BURN_ADDRESSES = [
  '1nc1nerator11111111111111111111111111111111',
] as const;

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Streamflow's stream program. A stream's schedule is in its *metadata*
 * account, 1104 bytes owned by this program (js-sdk
 * `packages/stream/solana/layout.ts` `streamLayout`): `canceled_at` is the u64
 * at 25, `end_time` the u64 at 33, the mint at 177 and `escrow_tokens` at 209.
 *
 * The LP does not sit in that metadata account. It sits in the escrow, a token
 * account that exists and whose SPL owner is its own address. That was read off
 * live mainnet streams on 2026-11-15: three of three escrows were Token program
 * accounts owning themselves, and each stream named the same mint and the same
 * escrow back. So the holder row for a locked LP is the escrow, and reading its
 * "owner account" only returns the token account again, which is not the
 * schedule.
 *
 * The escrow cannot be derived from the stream. The documented seeds
 * (`["strm", metadata]`) did not reproduce two of those three live escrows, so a
 * derivation is not a proof. The proof is the back-reference: the escrow's
 * oldest transaction is the one that created the stream and names the metadata
 * account, and the balance counts as locked only when that account is owned by
 * this program, names this LP mint and this escrow, was not cancelled, and its
 * `end_time` is still ahead. Anything weaker is reported as held by that
 * contract and is never counted as locked. `getProgramAccounts`, the scan that
 * could find the stream from `escrow_tokens`, is not an allowed read.
 */
export const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
export const STREAMFLOW_END_OFFSET = 33;
export const STREAMFLOW_CANCELED_OFFSET = 25;
export const STREAMFLOW_MINT_OFFSET = 177;
export const STREAMFLOW_ESCROW_OFFSET = 209;
/** Through the `escrow_tokens` key. Live stream accounts are 1104 bytes. */
const STREAMFLOW_MIN_BYTES = STREAMFLOW_ESCROW_OFFSET + 32;
const TOKEN_ACCOUNT_BYTES = 165;
/** Escrows proved per read, so a card stays inside the shared public RPC budget. */
export const MAX_ESCROW_PROOFS = 4;
const HISTORY_PAGE = 1000;
const HISTORY_PAGES = 3;
const MAX_CREATION_ACCOUNTS = 24;

const UNIX_MIN = 1_000_000_000n;
const UNIX_MAX = 10_000_000_000n;

export interface LpStatus {
  burnedPct: number | null;
  lockedPct: number | null;
  /** ISO time of the soonest unlock among balances that counted as locked. */
  unlockAt: string | null;
  source: string;
  /** Owner addresses that are programs or program-owned, and not a proved lock. */
  heldByContract: string[];
  unavailable: boolean;
}

export interface LpForCard {
  cardReadings: CardReading[];
  lp: LpStatus;
}

interface HolderRow {
  amount: bigint;
  owner: string | null;
  ownerProgram: string | null;
  executable: boolean | null;
  /** Stream end, unix seconds, when this holder is a Streamflow escrow whose stream named it back. */
  streamEnd: bigint | null;
  /** The owner address has no account. */
  missingAccount: boolean;
}

const cache = new Map<string, { at: number; ttl: number; value: LpForCard }>();

export function resetLpCacheForTest(): void {
  cache.clear();
  creationAccounts.clear();
}

function nowIso(): string {
  return new Date().toISOString();
}

function unavailable(source: string, fetchedAt: string | null = nowIso()): LpForCard {
  const lp: LpStatus = {
    burnedPct: null, lockedPct: null, unlockAt: null, source, heldByContract: [], unavailable: true,
  };
  return {
    lp,
    cardReadings: [{
      label: 'LP status', value: null, unit: '%', source, fetchedAt, observedAt: fetchedAt, maxAgeMs: LP_CACHE_MS,
    }],
  };
}

function percentOf(part: bigint, total: bigint): number | null {
  if (total <= 0n || part < 0n || part > total) return null;
  const hundredths = (part * 10_000n) / total;
  return Number(hundredths) / 100;
}

function u64le(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value |= BigInt(data[offset + i]!) << BigInt(8 * i);
  return value;
}

function pubkeyAt(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null;
  const text = base58(data.subarray(offset, offset + 32));
  return text.length > 0 ? text : null;
}

/** The LP mint on a pool account, or null when the program is not one decoded here. */
export function lpMintFromPool(ownerProgram: string, data: Uint8Array): string | null {
  const offset = LP_MINT_AT[ownerProgram];
  if (offset === undefined) return null;
  return pubkeyAt(data, offset);
}

export function streamEndFrom(data: Uint8Array): bigint | null {
  const end = u64le(data, STREAMFLOW_END_OFFSET);
  if (end === null || end < UNIX_MIN || end > UNIX_MAX) return null;
  return end;
}

/** A token account of this mint whose SPL owner is its own address. Streamflow's escrow has this shape. */
export function isSelfOwnedTokenAccount(address: string, mint: string, data: Uint8Array | null): boolean {
  if (!data || data.length < TOKEN_ACCOUNT_BYTES) return false;
  return pubkeyAt(data, 0) === mint && pubkeyAt(data, 32) === address;
}

/**
 * The end of a stream, when these bytes are a Streamflow stream that names this
 * mint and this escrow back and was never cancelled. Null is "not proved".
 * The caller has already checked that the stream program owns the account.
 */
export function streamEndIfNamedBack(data: Uint8Array, mint: string, escrow: string): bigint | null {
  if (data.length < STREAMFLOW_MIN_BYTES) return null;
  if (pubkeyAt(data, STREAMFLOW_MINT_OFFSET) !== mint || pubkeyAt(data, STREAMFLOW_ESCROW_OFFSET) !== escrow) return null;
  const canceled = u64le(data, STREAMFLOW_CANCELED_OFFSET);
  if (canceled === null || canceled !== 0n) return null;
  return streamEndFrom(data);
}

/** Every account a Streamflow instruction in this transaction names, outer or inner, except the escrow itself. */
export function streamflowAccountsIn(transaction: unknown, escrow: string): string[] {
  const root = asRecord(transaction);
  const message = asRecord(asRecord(root.transaction).message);
  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  const meta = asRecord(root.meta);
  const inner = (Array.isArray(meta.innerInstructions) ? meta.innerInstructions as unknown[] : [])
    .flatMap(group => (Array.isArray(asRecord(group).instructions) ? asRecord(group).instructions as unknown[] : []));
  const found: string[] = [];
  for (const raw of [...outer, ...inner]) {
    const ix = asRecord(raw);
    if (ix.programId !== STREAMFLOW_PROGRAM || !Array.isArray(ix.accounts)) continue;
    for (const account of ix.accounts) {
      if (typeof account === 'string' && account !== escrow && account !== STREAMFLOW_PROGRAM && isAddress(account) && !found.includes(account)) {
        found.push(account);
      }
    }
  }
  return found.slice(0, MAX_CREATION_ACCOUNTS);
}

/**
 * Shares of supply from holder rows that were actually read.
 * Returns null when any row is missing its owner, or a Streamflow account has no
 * readable end time, so an unread balance is never dropped into the remainder.
 */
export function classifyLpHolders(supply: bigint | null, holders: HolderRow[], nowMs = Date.now()): Pick<LpStatus, 'burnedPct' | 'lockedPct' | 'unlockAt' | 'heldByContract'> | null {
  if (supply === null || supply <= 0n) return null;
  // No rows left means the holder list was not read. That is not 0% burned and 0% locked.
  if (holders.length === 0) return null;
  if (holders.some(row => row.owner === null || row.amount < 0n)) return null;
  const burn = new Set<string>(SOLANA_BURN_ADDRESSES);
  let burned = 0n;
  let locked = 0n;
  let soonest: bigint | null = null;
  const held: string[] = [];
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  for (const row of holders) {
    const owner = row.owner!;
    if (burn.has(owner)) {
      burned += row.amount;
      continue;
    }
    // An owner with no account holds the tokens and is not a proved lock.
    if (row.missingAccount) {
      if (!held.includes(owner)) held.push(owner);
      continue;
    }
    // A Streamflow row whose end time was not in the bytes is an unread lock, not an open balance.
    if (row.ownerProgram === STREAMFLOW_PROGRAM && row.streamEnd === null) return null;
    if (row.ownerProgram === STREAMFLOW_PROGRAM && row.streamEnd !== null) {
      // A past end is a stream that has finished. It is not a current lock and not an unknown contract.
      if (row.streamEnd > nowSec) {
        locked += row.amount;
        if (soonest === null || row.streamEnd < soonest) soonest = row.streamEnd;
      }
      continue;
    }
    const programOwned = row.executable === true || (row.ownerProgram !== null && row.ownerProgram !== SYSTEM_PROGRAM);
    if (programOwned && !held.includes(owner)) held.push(owner);
  }
  if (burned + locked > supply) return null;
  return {
    burnedPct: percentOf(burned, supply),
    lockedPct: percentOf(locked, supply),
    unlockAt: soonest === null ? null : new Date(Number(soonest) * 1000).toISOString(),
    heldByContract: held,
  };
}

function valueOf(result: unknown): unknown {
  if (result && typeof result === 'object' && 'value' in result) return (result as { value: unknown }).value;
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function decodeData(data: unknown): Uint8Array | null {
  const raw = Array.isArray(data) ? data[0] : data;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return new Uint8Array(Buffer.from(raw, 'base64'));
  } catch {
    return null;
  }
}

async function solana(method: SolanaQuery['method'], params: unknown[]): Promise<unknown> {
  const answer = await ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, { method, params, commitment: 'finalized' }, {
    signal: AbortSignal.timeout(LP_RPC_TIMEOUT_MS),
  });
  return valueOf(answer.value.result);
}

async function accountAt(address: string): Promise<{ owner: string | null; executable: boolean | null; data: Uint8Array | null } | null> {
  const value = await solana('getAccountInfo', [address, { commitment: 'finalized', encoding: 'base64' }]);
  if (!value || typeof value !== 'object') return null;
  const row = asRecord(value);
  return {
    owner: typeof row.owner === 'string' ? row.owner : null,
    executable: typeof row.executable === 'boolean' ? row.executable : null,
    data: decodeData(row.data),
  };
}

async function lpMintOfPool(pool: string): Promise<string | null> {
  const account = await accountAt(pool);
  if (!account?.owner || !account.data) return null;
  return lpMintFromPool(account.owner, account.data);
}

function liquidityOf(pair: Record<string, unknown>): number {
  const usd = asRecord(pair.liquidity).usd;
  const n = typeof usd === 'number' ? usd : typeof usd === 'string' ? Number(usd) : NaN;
  return Number.isFinite(n) ? n : -1;
}

/** Deepest Solana pairs first, at most a few, so an unindexed mint costs little. */
async function candidatePools(mint: string): Promise<string[]> {
  const answer = await ask<MarketQuery, MarketPairs>('market_pairs', { kind: 'token', address: mint });
  const ranked = answer.value.pairs
    .map(asRecord)
    .filter(pair => pair.chainId === 'solana' && typeof pair.pairAddress === 'string')
    .filter(pair => {
      const base = asRecord(pair.baseToken).address;
      const quote = asRecord(pair.quoteToken).address;
      return base === mint || quote === mint;
    })
    .sort((a, b) => liquidityOf(b) - liquidityOf(a));
  return ranked.slice(0, MAX_POOLS_TRIED).map(pair => pair.pairAddress as string);
}

async function resolveLpMint(mint: string, poolAddress: string | null): Promise<{ lpMint: string; pool: string } | null> {
  if (poolAddress) {
    const lpMint = await lpMintOfPool(poolAddress);
    return lpMint ? { lpMint, pool: poolAddress } : null;
  }
  for (const pool of await candidatePools(mint)) {
    const lpMint = await lpMintOfPool(pool);
    if (lpMint) return { lpMint, pool };
  }
  return null;
}

function ownerOfTokenAccount(account: unknown): string | null {
  const info = asRecord(asRecord(asRecord(account).data).parsed).info;
  const owner = asRecord(info).owner;
  return typeof owner === 'string' ? owner : null;
}

/** Immutable once known: the accounts the creating instruction named, by escrow. */
const creationAccounts = new Map<string, string[]>();

/** The accounts named by the transaction that created this escrow, or null when its start was not reached. */
async function creationAccountsOf(escrow: string): Promise<string[] | null> {
  const known = creationAccounts.get(escrow);
  if (known) return known;
  let before: string | undefined;
  let oldest: string | null = null;
  let reachedStart = false;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const result = await solana('getSignaturesForAddress', [escrow, { limit: HISTORY_PAGE, commitment: 'finalized', ...(before ? { before } : {}) }]);
    const rows = Array.isArray(result) ? result.map(asRecord).filter(row => typeof row.signature === 'string') : [];
    // Nothing older than what was already seen: that page was the start.
    if (rows.length === 0) { reachedStart = true; break; }
    const succeeded = rows.filter(row => (row.err ?? null) === null);
    if (succeeded.length > 0) oldest = succeeded[succeeded.length - 1]!.signature as string;
    if (rows.length < HISTORY_PAGE) { reachedStart = true; break; }
    before = rows[rows.length - 1]!.signature as string;
  }
  // A history longer than the pages read has an older start that was not seen.
  if (!reachedStart || !oldest) return null;
  const transaction = await solana('getTransaction', [oldest, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  if (!transaction) return null;
  const named = streamflowAccountsIn(transaction, escrow);
  if (named.length === 0) return null;
  creationAccounts.set(escrow, named);
  return named;
}

/**
 * The end of the stream whose escrow this is, or null when no stream proves it.
 * Throws when a read failed, so an unread proof is unavailable and is not
 * mistaken for "no stream".
 */
async function streamEndOfEscrow(escrow: string, lpMint: string): Promise<bigint | null> {
  const named = await creationAccountsOf(escrow);
  if (!named) return null;
  const read = await solana('getMultipleAccounts', [named, { encoding: 'base64', commitment: 'finalized' }]);
  if (!Array.isArray(read)) throw new Error('getMultipleAccounts did not answer');
  for (const row of read) {
    const info = asRecord(row);
    if (info.owner !== STREAMFLOW_PROGRAM) continue;
    const data = decodeData(info.data);
    const end = data ? streamEndIfNamedBack(data, lpMint, escrow) : null;
    if (end !== null) return end;
  }
  return null;
}

async function holderRows(lpMint: string): Promise<{ supply: bigint | null; holders: HolderRow[] } | null> {
  const [supplyResult, largestResult] = await Promise.all([
    solana('getTokenSupply', [lpMint, { commitment: 'finalized' }]),
    solana('getTokenLargestAccounts', [lpMint, { commitment: 'finalized' }]),
  ]);
  const supplyText = asRecord(supplyResult).amount;
  if (typeof supplyText !== 'string' || !/^\d+$/.test(supplyText)) return null;
  const largest = largestResult;
  if (!Array.isArray(largest)) return null;
  const top = largest.slice(0, MAX_LP_HOLDERS).map(asRecord).filter(row => {
    const amount = row.amount;
    return typeof row.address === 'string' && (typeof amount === 'string' || typeof amount === 'number') && String(amount) !== '0';
  });
  if (top.length === 0) return null;
  const accounts = top.map(row => row.address as string);
  const owners = new Map<string, string | null>();
  if (accounts.length > 0) {
    const read = await solana('getMultipleAccounts', [accounts, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    if (!Array.isArray(read)) return null;
    accounts.forEach((account, i) => owners.set(account, ownerOfTokenAccount(read[i])));
  }
  const distinct = [...new Set([...owners.values()].filter((owner): owner is string => owner !== null))];
  const programs = new Map<string, { ownerProgram: string | null; executable: boolean | null; data: Uint8Array | null; missingAccount: boolean }>();
  if (distinct.length > 0) {
    const read = await solana('getMultipleAccounts', [distinct, { encoding: 'base64', commitment: 'finalized' }]);
    if (!Array.isArray(read)) return null;
    distinct.forEach((owner, i) => {
      const row = read[i];
      if (row === null) {
        // No account at the owner. Classifying it as the System program would hide the holding.
        programs.set(owner, { ownerProgram: null, executable: false, data: null, missingAccount: true });
        return;
      }
      const info = asRecord(row);
      programs.set(owner, {
        ownerProgram: typeof info.owner === 'string' ? info.owner : null,
        executable: typeof info.executable === 'boolean' ? info.executable : null,
        data: decodeData(info.data),
        missingAccount: false,
      });
    });
  }
  const holders: HolderRow[] = [];
  let proofs = 0;
  for (const row of top) {
    const account = row.address as string;
    const owner = owners.get(account) ?? null;
    const program = owner ? programs.get(owner) : undefined;
    let ownerProgram = program?.ownerProgram ?? null;
    let streamEnd: bigint | null = null;
    // A holder that owns itself is a candidate Streamflow escrow. Its "owner
    // account" is the token account again, so the schedule is found through the
    // stream that names it back, for a few of them per read.
    if (owner === account && program?.data && proofs < MAX_ESCROW_PROOFS && isSelfOwnedTokenAccount(account, lpMint, program.data)) {
      proofs += 1;
      const end = await streamEndOfEscrow(account, lpMint);
      if (end !== null) {
        ownerProgram = STREAMFLOW_PROGRAM;
        streamEnd = end;
      }
    }
    holders.push({
      amount: BigInt(String(row.amount)),
      owner,
      ownerProgram,
      executable: program?.executable ?? null,
      streamEnd,
      missingAccount: program?.missingAccount ?? false,
    });
  }
  return { supply: BigInt(supplyText), holders };
}

function readingsFor(status: LpStatus, fetchedAt: string): CardReading[] {
  const base = { source: status.source, fetchedAt, observedAt: fetchedAt, maxAgeMs: LP_CACHE_MS };
  if (status.unavailable || status.burnedPct === null || status.lockedPct === null) {
    return [{ label: 'LP status', value: null, unit: '%', ...base, source: status.source }];
  }
  const lockedSource = [
    status.source,
    status.unlockAt ? `unlock ${status.unlockAt}` : 'no proved timelock',
  ].join('; ');
  return [
    { label: 'LP burned', value: status.burnedPct, unit: '%', ...base },
    { label: 'LP locked', value: status.lockedPct, unit: '%', ...base, source: lockedSource },
  ];
}

/** One line per contract that holds LP and was not proved as a timelock. */
export function lpContractLines(lp: LpStatus | null | undefined): string[] {
  if (!lp || lp.unavailable) return [];
  return lp.heldByContract.map(address => `held by contract ${address}`);
}

/**
 * Whether two LP reads agree on the lines this card text still shows.
 * Percentages and the unlock time are readings, compared with those. A length
 * trim drops `lp` and its contract lines, so a fresh read must not look like
 * a different card when those lines are absent from the text.
 */
export function sameLp(left: LpStatus | null, right: LpStatus | null, cardText: string): boolean {
  const lines = cardText.split('\n');
  const shown = (status: LpStatus | null) => lpContractLines(status).filter(line => lines.includes(line));
  return JSON.stringify(shown(left)) === JSON.stringify(shown(right));
}

async function solanaLp(mint: string, poolAddress: string | null): Promise<LpForCard> {
  const resolved = await resolveLpMint(mint, poolAddress);
  if (!resolved) return unavailable('solana_lp');
  const read = await holderRows(resolved.lpMint);
  if (!read) return unavailable('solana_lp');
  const classified = classifyLpHolders(read.supply, read.holders);
  if (!classified || classified.burnedPct === null || classified.lockedPct === null) return unavailable('solana_lp');
  const lp: LpStatus = {
    ...classified,
    source: `solana_lp ${resolved.pool} top ${MAX_LP_HOLDERS}`,
    unavailable: false,
  };
  return { lp, cardReadings: readingsFor(lp, nowIso()) };
}

/**
 * LP burn and lock for one token evidence card.
 * EVM holder balances are not read: the allowed node methods have no token balance call,
 * and a missing balance is not reported as zero. Cached per mint so a card and its
 * send-time re-read do not each open the pool.
 */
export async function readLpForCard(input: { chain: string; address: string; poolAddress: string | null }): Promise<LpForCard> {
  const key = `${input.chain}:${input.address}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= hit.ttl) return hit.value;
  const value = input.chain === 'solana'
    ? await solanaLp(input.address, input.poolAddress).catch(() => unavailable('solana_lp'))
    : unavailable('evm_lp');
  cache.set(key, { at: Date.now(), ttl: value.lp.unavailable ? LP_UNAVAILABLE_CACHE_MS : LP_CACHE_MS, value });
  return value;
}
