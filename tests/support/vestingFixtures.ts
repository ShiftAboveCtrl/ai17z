import { createHash } from 'node:crypto';
import { base58Bytes } from '@xbam/upstream';
import type { SolanaRpc } from '@xbam/runtime';

/**
 * A small fake cluster for the vesting reader, and the scenarios Studio is
 * built against. Every address is invented: it is a hash of a label, so no
 * fixture carries a real holder, sender or recipient.
 *
 * The stream layout offsets are the ones the reader declares, checked against
 * live accounts when the reader was written. A fixture proves the reader agrees
 * with itself and with these bytes. It cannot prove Streamflow still writes
 * them, which only a live read does.
 */

export const STREAMFLOW = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encode58(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)]! + out;
    value /= 58n;
  }
  return '1'.repeat(leading) + out;
}

/** A valid 32 byte address made from a label, the same every run. */
export function addr(label: string): string {
  const bytes = createHash('sha256').update(`vesting-fixture:${label}`).digest();
  const text = encode58(bytes);
  if (base58Bytes(text)?.length !== 32) throw new Error(`fixture address for ${label} is not 32 bytes`);
  return text;
}

const keyBytes = (address: string): Uint8Array => {
  const bytes = base58Bytes(address);
  if (!bytes || bytes.length !== 32) throw new Error(`${address} is not an address`);
  return bytes;
};

export interface StreamSpec {
  mint: string;
  escrow: string;
  start: bigint;
  end: bigint;
  /** 0 means no cliff of its own, as on chain. */
  cliff: bigint;
  cliffAmount: bigint;
  period: bigint;
  amountPerPeriod: bigint;
  net: bigint;
  withdrawn?: bigint;
  canceledAt?: bigint;
}

function put64(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

/** A 1104 byte stream account, like the live ones. Sender and recipient are invented. */
export function streamAccountBytes(spec: StreamSpec): Uint8Array {
  const out = new Uint8Array(1104);
  const view = new DataView(out.buffer);
  put64(view, 9, spec.start - 3600n);
  put64(view, 17, spec.withdrawn ?? 0n);
  put64(view, 25, spec.canceledAt ?? 0n);
  put64(view, 33, spec.end);
  out.set(keyBytes(addr('sender')), 49);
  out.set(keyBytes(addr('recipient')), 113);
  out.set(keyBytes(spec.mint), 177);
  out.set(keyBytes(spec.escrow), 209);
  put64(view, 409, spec.start);
  put64(view, 417, spec.net);
  put64(view, 425, spec.period);
  put64(view, 433, spec.amountPerPeriod);
  put64(view, 441, spec.cliff);
  put64(view, 449, spec.cliffAmount);
  return out;
}

/** An SPL token account: mint, owner, amount, in a 165 byte body. */
export function tokenAccountBytes(mint: string, owner: string, amount: bigint): Uint8Array {
  const out = new Uint8Array(165);
  out.set(keyBytes(mint), 0);
  out.set(keyBytes(owner), 32);
  new DataView(out.buffer).setBigUint64(64, amount, true);
  out[108] = 1;
  return out;
}

export interface ClusterAccount { owner: string; dataBase64: string }
export interface ClusterSnapshot {
  description: string;
  nowMs: number;
  mint: string;
  supply: string;
  decimals: number;
  largest: { address: string; amount: string }[];
  accounts: Record<string, ClusterAccount>;
  /** Newest first, as the cluster answers. */
  signatures: Record<string, { signature: string; err: unknown }[]>;
  transactions: Record<string, unknown>;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export interface FakeCluster { rpc: SolanaRpc; calls: { method: string; params: unknown[] }[] }

export function fakeCluster(snapshot: ClusterSnapshot, options: { failOn?: (method: string, params: unknown[]) => boolean } = {}): FakeCluster {
  const calls: { method: string; params: unknown[] }[] = [];
  const answer = (result: unknown) => ({ result, slot: 123_456, source: 'solana_mainnet.fake', fetchedAt: new Date(snapshot.nowMs).toISOString() });
  const rpc: SolanaRpc = async (method, params) => {
    calls.push({ method, params });
    if (options.failOn?.(method, params)) throw new Error('The cluster refused that request.');
    switch (method) {
      case 'getTokenSupply':
        return answer({ context: { slot: 123_456 }, value: { amount: snapshot.supply, decimals: snapshot.decimals } });
      case 'getTokenLargestAccounts':
        return answer({ context: { slot: 123_456 }, value: snapshot.largest });
      case 'getMultipleAccounts': {
        const wanted = params[0] as string[];
        return answer({
          context: { slot: 123_456 },
          value: wanted.map((address) => {
            const found = snapshot.accounts[address];
            return found ? { owner: found.owner, executable: false, lamports: 1, data: [found.dataBase64, 'base64'] } : null;
          }),
        });
      }
      case 'getSignaturesForAddress': {
        const [address, options_] = params as [string, { limit?: number; before?: string }];
        const all = snapshot.signatures[address] ?? [];
        const from = options_.before ? all.findIndex((row) => row.signature === options_.before) + 1 : 0;
        return answer(all.slice(from, from + (options_.limit ?? 1000)));
      }
      case 'getTransaction':
        return answer(snapshot.transactions[params[0] as string] ?? null);
      default:
        throw new Error(`The fake cluster does not answer ${method}.`);
    }
  };
  return { rpc, calls };
}

/** The creation transaction as `jsonParsed` returns it: one Streamflow instruction naming the stream accounts. */
function creationTransaction(metadata: string, escrow: string, mint: string): unknown {
  return {
    transaction: {
      message: {
        instructions: [
          { programId: 'ComputeBudget111111111111111111111111111111', accounts: [] },
          {
            programId: STREAMFLOW,
            accounts: [addr('sender'), addr('sender-tokens'), addr('recipient'), addr('recipient-tokens'), metadata, escrow, addr('treasury'), mint, STREAMFLOW],
          },
        ],
      },
    },
    meta: { innerInstructions: [] },
  };
}

export const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOW = BigInt(NOW_MS / 1000);
const DAY = 86_400n;
const TOKEN = 1_000_000n;

interface Built { snapshot: ClusterSnapshot; add: (spec: StreamSpec, held: bigint, label: string, options?: { creation?: 'stream' | 'none' | 'other-escrow' }) => void }

function empty(description: string, mint: string, supply: bigint): Built {
  const snapshot: ClusterSnapshot = {
    description, nowMs: NOW_MS, mint, supply: supply.toString(), decimals: 6, largest: [], accounts: {}, signatures: {}, transactions: {},
  };
  return {
    snapshot,
    add(spec, held, label, options = {}) {
      const metadata = addr(`${label}-metadata`);
      snapshot.largest.push({ address: spec.escrow, amount: held.toString() });
      // A Streamflow escrow is a token account whose owner is itself.
      snapshot.accounts[spec.escrow] = { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', dataBase64: b64(tokenAccountBytes(mint, spec.escrow, held)) };
      const creation = options.creation ?? 'stream';
      const signature = `${label}-creation-signature`;
      snapshot.signatures[spec.escrow] = [{ signature: `${label}-later-withdrawal`, err: null }, { signature, err: null }];
      if (creation === 'stream' || creation === 'other-escrow') {
        const body = creation === 'stream' ? spec : { ...spec, escrow: addr(`${label}-some-other-escrow`) };
        snapshot.accounts[metadata] = { owner: STREAMFLOW, dataBase64: b64(streamAccountBytes(body)) };
        snapshot.transactions[signature] = creationTransaction(metadata, spec.escrow, mint);
      } else {
        snapshot.transactions[signature] = { transaction: { message: { instructions: [{ programId: addr('some-other-program'), accounts: [spec.escrow] }] } }, meta: { innerInstructions: [] } };
      }
    },
  };
}

function wallet(snapshot: ClusterSnapshot, mint: string, label: string, amount: bigint, ownerLabel = `${label}-owner`): void {
  const address = addr(`${label}-token-account`);
  snapshot.largest.push({ address, amount: amount.toString() });
  snapshot.accounts[address] = { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', dataBase64: b64(tokenAccountBytes(mint, addr(ownerLabel), amount)) };
}

/** Hand-checkable figures: 1,000,000,000 tokens of supply, 6 decimals, and a clock fixed at 2026-11-15 12:00 UTC. */
export function scenarios(): { streamflowMixed: ClusterSnapshot; noneSeen: ClusterSnapshot; unrecognizedLock: ClusterSnapshot } {
  const mint = addr('mint');
  const supply = 1_000_000_000n * TOKEN;

  // A linear schedule with a cliff, a lock until one date, and a stream that ended.
  const mixed = empty('Two unfinished streams and one that ended, among wallet and pool accounts.', mint, supply);
  wallet(mixed.snapshot, mint, 'big-wallet', 100_000_000n * TOKEN);
  wallet(mixed.snapshot, mint, 'pool', 80_000_000n * TOKEN, 'pool-authority');
  mixed.add({
    mint, escrow: addr('linear-escrow'), start: NOW + 10n * DAY, cliff: NOW + 10n * DAY, cliffAmount: 20_000_000n * TOKEN,
    period: 30n * DAY, amountPerPeriod: 18_000_000n * TOKEN, net: 200_000_000n * TOKEN, end: NOW + 10n * DAY + 300n * DAY,
  }, 200_000_000n * TOKEN, 'linear');
  mixed.add({
    mint, escrow: addr('lock-escrow'), start: NOW + 3n * DAY, cliff: NOW + 3n * DAY, cliffAmount: 50_000_000n * TOKEN - 1n,
    period: 1n, amountPerPeriod: 50_000_000n * TOKEN, net: 50_000_000n * TOKEN, end: NOW + 3n * DAY + 1n,
  }, 50_000_000n * TOKEN, 'lock');
  mixed.add({
    mint, escrow: addr('ended-escrow'), start: NOW - 400n * DAY, cliff: 0n, cliffAmount: 0n,
    period: 30n * DAY, amountPerPeriod: 10_000_000n * TOKEN, net: 10_000_000n * TOKEN, end: NOW - 5n * DAY,
  }, 10_000_000n * TOKEN, 'ended');

  const none = empty('Only wallet and pool accounts among the largest. No stream seen.', mint, supply);
  wallet(none.snapshot, mint, 'a-wallet', 120_000_000n * TOKEN);
  wallet(none.snapshot, mint, 'b-wallet', 60_000_000n * TOKEN);
  wallet(none.snapshot, mint, 'pool', 40_000_000n * TOKEN, 'pool-authority');

  const unrecognized = empty('A self-owned token account whose creation names no Streamflow stream.', mint, supply);
  wallet(unrecognized.snapshot, mint, 'a-wallet', 120_000_000n * TOKEN);
  unrecognized.add({
    mint, escrow: addr('other-lock-escrow'), start: NOW + DAY, cliff: NOW + DAY, cliffAmount: 1n, period: 1n, amountPerPeriod: 1n, net: 1n, end: NOW + DAY + 1n,
  }, 30_000_000n * TOKEN, 'other-lock', { creation: 'none' });

  return { streamflowMixed: mixed.snapshot, noneSeen: none.snapshot, unrecognizedLock: unrecognized.snapshot };
}

export { empty as emptyScenario, wallet as addWallet, NOW, DAY, TOKEN };
