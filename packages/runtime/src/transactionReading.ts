import { SOLANA_FAMILY, ask, exactInteger, isSignature, type SolanaQuery, type SolanaResult } from '@xbam/upstream';
import { fitTransactionReading, type TransactionReport, type TxBalanceChange, type TxInstruction, type TxProgram } from '@xbam/prompts';

/**
 * A public transaction, read and not interpreted.
 *
 * It states what the node returned: status, slot, commitment, block time, fee,
 * the programs called, and each account whose balance differs between before and
 * after. It never says what the transaction was for, never names who an address
 * belongs to, and never turns a balance change into a gain or a loss. Nothing is
 * signed or built, and no wallet is involved: the one cluster method used is the
 * read-only `getTransaction` that `solana.read_transaction` already allows.
 *
 * Absent is never zero. A balance a transaction did not record is omitted or
 * printed as not recorded; an instruction the node did not parse is listed as
 * not decoded rather than summarised.
 */

/** Programs named by their well known address. Everything else is shown by address, because a wrong name is worse than none. */
const KNOWN_PROGRAMS: Record<string, string> = {
  '11111111111111111111111111111111': 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
};

/** A reading is current for the same five minutes the other evidence replies allow. */
export const TX_MAX_AGE_MS = 5 * 60_000;
export const TX_READS = 2;

interface Rec { [key: string]: unknown }
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function program(address: string): TxProgram { return { address, name: KNOWN_PROGRAMS[address] ?? null }; }

function keysOf(message: Rec | null): string[] {
  const keys = message?.accountKeys;
  if (!Array.isArray(keys)) return [];
  return keys.map(k => typeof k === 'string' ? k : text(rec(k)?.pubkey) ?? '');
}

/** The instruction type only when the node parsed it, and only when it is a plain word. */
function kindOf(instruction: Rec): string | null {
  const type = text(rec(instruction.parsed)?.type);
  return type && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(type) ? type : null;
}

function lamportChanges(keys: string[], pre: unknown, post: unknown): TxBalanceChange[] | null {
  if (!Array.isArray(pre) || !Array.isArray(post) || keys.length === 0) return null;
  const out: TxBalanceChange[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const before = exactInteger(pre[i]);
    const after = exactInteger(post[i]);
    const account = keys[i];
    // A side the node sent in a form that is not an exact integer is absent, so the account is left out.
    if (!account || before === null || after === null || before === after) continue;
    out.push({ account, mint: null, owner: null, before, after, decimals: 9 });
  }
  return out;
}

function tokenChanges(keys: string[], pre: unknown, post: unknown): TxBalanceChange[] | null {
  if (!Array.isArray(pre) || !Array.isArray(post)) return null;
  const side = (rows: unknown[]) => new Map(rows.flatMap(row => {
    const r = rec(row);
    const index = typeof r?.accountIndex === 'number' ? r.accountIndex : null;
    const ui = rec(r?.uiTokenAmount);
    const amount = exactInteger(ui?.amount);
    if (index === null || amount === null) return [];
    return [[index, { amount, decimals: typeof ui?.decimals === 'number' ? ui.decimals : null, mint: text(r?.mint), owner: text(r?.owner) }] as const];
  }));
  const before = side(pre);
  const after = side(post);
  const out: TxBalanceChange[] = [];
  for (const index of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)) {
    const b = before.get(index);
    const a = after.get(index);
    const account = keys[index];
    if (!account || (b && a && b.amount === a.amount)) continue;
    const either = a ?? b!;
    out.push({ account, mint: either.mint, owner: either.owner, before: b?.amount ?? null, after: a?.amount ?? null, decimals: either.decimals });
  }
  return out;
}

/**
 * The report for one `getTransaction` result read with `jsonParsed`, or null when the
 * node returned nothing for the signature. Pure, so recorded results are the fixtures.
 */
export function buildTransactionReport(input: {
  signature: string; result: unknown; commitment: 'finalized' | 'confirmed'; source: string; fetchedAt: string; maxCharacters: number;
}): { report: TransactionReport; text: string } | null {
  const value = rec(input.result);
  if (!value) return null;
  const meta = rec(value.meta);
  const message = rec(rec(value.transaction)?.message);
  const keys = keysOf(message);
  const top = Array.isArray(message?.instructions) ? message.instructions.map(rec).filter((i): i is Rec => i !== null) : [];
  const instructions: TxInstruction[] = top.flatMap(i => {
    const address = text(i.programId);
    return address ? [{ program: program(address), kind: kindOf(i) }] : [];
  });
  const programs = new Map<string, TxProgram>();
  for (const i of instructions) programs.set(i.program.address, i.program);
  // Programs reached through another program count as called, listed after the ones called directly.
  for (const group of Array.isArray(meta?.innerInstructions) ? meta.innerInstructions : []) {
    for (const inner of Array.isArray(rec(group)?.instructions) ? rec(group)!.instructions as unknown[] : []) {
      const address = text(rec(inner)?.programId);
      if (address && !programs.has(address)) programs.set(address, program(address));
    }
  }
  const err = meta ? (meta.err ?? null) : undefined;
  const blockTime = typeof value.blockTime === 'number' ? new Date(value.blockTime * 1000).toISOString() : null;
  const base = {
    signature: input.signature,
    chain: 'solana' as const,
    succeeded: err === undefined ? null : err === null,
    // The cluster's own structure as text: guessing what an InstructionError meant is how a wrong explanation gets written.
    failureReason: err === undefined || err === null ? null : `The cluster reported: ${JSON.stringify(err)}`,
    commitment: input.commitment,
    slot: typeof value.slot === 'number' ? value.slot : null,
    blockTime,
    feeLamports: exactInteger(meta?.fee),
    programs: [...programs.values()],
    instructions,
    solChanges: meta ? lamportChanges(keys, meta.preBalances, meta.postBalances) : null,
    tokenChanges: meta ? tokenChanges(keys, meta.preTokenBalances, meta.postTokenBalances) : null,
    source: input.source,
    fetchedAt: input.fetchedAt,
  };
  return fitTransactionReading(base, input.maxCharacters);
}

/** The addresses a reading prints in full: the programs the node reported. Everything else is shortened. */
export function transactionAddresses(report: TransactionReport): string[] {
  return report.programs.map(p => p.address);
}

export function transactionCurrent(report: TransactionReport, now = Date.now()): boolean {
  const at = Date.parse(report.fetchedAt);
  return Number.isFinite(at) && now - at <= TX_MAX_AGE_MS && at <= now + 30_000;
}

export interface TransactionRead { report: TransactionReport | null; text: string | null; reads: number; failure: string | null }

/**
 * Finalized first. Only when that finds nothing is `confirmed` tried, because a
 * transaction that just landed is real before it is final and the reply must say
 * which it is. The second read is spent only when the research budget allows it.
 */
export async function readTransactionReport(input: { signature: string; maxCharacters: number; maxReads: number }): Promise<TransactionRead> {
  if (!isSignature(input.signature)) return { report: null, text: null, reads: 0, failure: 'That is not a transaction signature, so nothing was read.' };
  let reads = 0;
  for (const commitment of ['finalized', 'confirmed'] as const) {
    if (reads >= input.maxReads) break;
    reads += 1;
    try {
      const answer = await ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, {
        method: 'getTransaction',
        params: [input.signature, { commitment, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        commitment,
      });
      const built = buildTransactionReport({ signature: input.signature, result: answer.value.result, commitment,
        source: answer.provenance.upstreamId, fetchedAt: answer.provenance.fetchedAt, maxCharacters: input.maxCharacters });
      if (built) return { report: built.report, text: built.text, reads, failure: null };
    } catch {
      return { report: null, text: null, reads, failure: 'The Solana source did not answer. This is not a verdict, no reading was made.' };
    }
  }
  return { report: null, text: null, reads, failure: reads < 2
    ? 'No finalized transaction was found for this signature. It may not exist or may not have landed yet. This is not a verdict.'
    : 'No transaction was found for this signature, finalized or confirmed. It may not exist or may not have landed yet. This is not a verdict.' };
}
