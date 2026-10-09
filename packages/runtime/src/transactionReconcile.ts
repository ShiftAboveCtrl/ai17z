import { z } from 'zod';
import { defineCapability } from '@xbam/tools';
import { EVM_CHAINS, ask, evmFamily, hexToExactInteger, type EvmChain, type EvmQuery, type EvmResult } from '@xbam/upstream';

/**
 * What happened to a transaction somebody is unsure about.
 *
 * The moment this exists for: an agent sent something, the wallet or the
 * network went quiet, and now it has a hash and no idea whether the thing it
 * asked for happened. Resending is how a payment goes out twice; giving up is
 * how one never goes out. This reads the chain and answers with a verdict and,
 * separately, whether sending again is safe.
 *
 * ### Not seen is not proof it never happened
 *
 * A node with no record of a hash may simply not have heard of it yet, or may
 * have dropped it from its pool while another node mines it. So a missing
 * transaction is NOT_FOUND, never "failed", and the only resend that is ever
 * safe after it is one with the same nonce, because two transactions with one
 * nonce can never both execute. When the caller says who sent it and with
 * which nonce, the sender's count of mined transactions tells NOT_FOUND from
 * REPLACED: a nonce already used means something else took that slot.
 *
 * ### Everything here is a read
 *
 * It sends nothing, signs nothing and cannot be shaped into anything that
 * does. The judgement is a pure function over what was read, so every case is
 * pinned in tests without a network.
 */

const ChainName = z.enum(Object.keys(EVM_CHAINS) as [EvmChain, ...EvmChain[]]);
const Address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'An EVM address is 0x followed by 40 hexadecimal characters.');
const TxHash = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'A transaction hash is 0x followed by 64 hexadecimal characters.');
const Wei = z.string().regex(/^[0-9]{1,78}$/, 'An amount in wei, as a string of digits.');

export const TransactionReconcileInput = z
  .object({
    chain: ChainName,
    hash: TxHash,
    /** What the caller believes this transaction is. Each field given is checked. */
    expect: z
      .object({
        from: Address.optional(),
        to: Address.optional(),
        valueWei: Wei.optional(),
        nonce: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    /** Blocks on top before it counts as settled. Twelve unless the caller knows better. */
    confirmations: z.number().int().min(1).max(1_000).default(12),
  })
  .strict();
export type TransactionReconcileInput = z.infer<typeof TransactionReconcileInput>;

export type ReconcileVerdict = 'CONFIRMED' | 'CONFIRMING' | 'REVERTED' | 'STATUS_UNKNOWN' | 'PENDING' | 'REPLACED' | 'NOT_FOUND' | 'MISMATCH';

/** Whether sending again is safe, said as an instruction rather than a boolean. */
export type ResendAdvice = 'NO' | 'ONLY_WITH_SAME_NONCE' | 'YES_AS_A_NEW_DECISION';

/** What was read, normalised. Null means the chain did not say. */
export interface ReconcileObservation {
  transaction: { from: string | null; to: string | null; valueWei: string | null; nonce: number | null; blockNumber: number | null } | null;
  receipt: { succeeded: boolean | null; blockNumber: number | null } | null;
  head: number | null;
  /** The sender's count of mined transactions, read only when it decides something. */
  senderMinedNonce: number | null;
}

export interface Reconciliation {
  verdict: ReconcileVerdict;
  mayResend: ResendAdvice;
  confirmations: number | null;
  findings: { code: string; sentence: string }[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The judgement, from what was read. Pure. */
export function judgeReconciliation(
  observed: ReconcileObservation,
  expect: TransactionReconcileInput['expect'],
  required: number,
): Reconciliation {
  const findings: { code: string; sentence: string }[] = [];
  const tx = observed.transaction;

  if (!tx) {
    if (expect?.from !== undefined && expect.nonce !== undefined && observed.senderMinedNonce !== null) {
      if (observed.senderMinedNonce > expect.nonce) {
        findings.push({
          code: 'NONCE_USED',
          sentence: `The sender has mined ${observed.senderMinedNonce} transactions, so nonce ${expect.nonce} is used, and not by this hash. Find out what took it before doing anything.`,
        });
        return { verdict: 'REPLACED', mayResend: 'NO', confirmations: null, findings };
      }
      findings.push({
        code: 'NONCE_FREE',
        sentence: `Nonce ${expect.nonce} has not been used yet. Sending again with that same nonce can never execute twice.`,
      });
    } else {
      findings.push({
        code: 'NOT_SEEN',
        sentence:
          'The node has no record of this hash. It may not have heard of it yet, or may have dropped it while another mines it. Not seen is not proof it never happened.',
      });
    }
    return { verdict: 'NOT_FOUND', mayResend: 'ONLY_WITH_SAME_NONCE', confirmations: null, findings };
  }

  // The hash exists. Is it the transaction the caller thinks it is?
  const mismatches: string[] = [];
  if (expect?.from && tx.from && !same(expect.from, tx.from)) mismatches.push(`sent from ${tx.from}, not ${expect.from}`);
  if (expect?.to && tx.to && !same(expect.to, tx.to)) mismatches.push(`sent to ${tx.to}, not ${expect.to}`);
  if (expect?.to && tx.to === null) mismatches.push('a contract creation, with no recipient');
  if (expect?.valueWei !== undefined && tx.valueWei !== null && expect.valueWei !== tx.valueWei) {
    mismatches.push(`carrying ${tx.valueWei} wei, not ${expect.valueWei}`);
  }
  if (expect?.nonce !== undefined && tx.nonce !== null && expect.nonce !== tx.nonce) mismatches.push(`at nonce ${tx.nonce}, not ${expect.nonce}`);
  if (mismatches.length > 0) {
    findings.push({ code: 'NOT_WHAT_WAS_EXPECTED', sentence: `This hash is a different transaction: ${mismatches.join('; ')}.` });
    return { verdict: 'MISMATCH', mayResend: 'NO', confirmations: null, findings };
  }

  if (tx.blockNumber === null) {
    findings.push({ code: 'IN_MEMPOOL', sentence: 'Seen but not mined yet. Waiting is the answer; a resend would compete with it.' });
    return { verdict: 'PENDING', mayResend: 'NO', confirmations: null, findings };
  }

  const confirmations = observed.head !== null && observed.head >= tx.blockNumber ? observed.head - tx.blockNumber + 1 : null;
  const outcome = observed.receipt?.succeeded ?? null;

  if (observed.receipt === null) {
    findings.push({ code: 'NO_RECEIPT', sentence: 'Mined, but the node gave no receipt, so whether it succeeded is not known.' });
    return { verdict: 'STATUS_UNKNOWN', mayResend: 'NO', confirmations, findings };
  }
  if (outcome === false) {
    findings.push({
      code: 'REVERTED',
      sentence: 'Mined and reverted: the fee was spent and nothing it asked for happened. Sending again is a new decision, not a retry.',
    });
    return { verdict: 'REVERTED', mayResend: 'YES_AS_A_NEW_DECISION', confirmations, findings };
  }
  if (outcome === null) {
    findings.push({ code: 'NO_STATUS', sentence: 'The receipt carries no status, as receipts from before 2017 do. Success cannot be read from it.' });
    return { verdict: 'STATUS_UNKNOWN', mayResend: 'NO', confirmations, findings };
  }
  if (confirmations === null || confirmations < required) {
    findings.push({
      code: 'CONFIRMING',
      sentence: `Succeeded, with ${confirmations ?? 'an unknown number of'} of the ${required} confirmations asked for. A reorganisation could still remove it.`,
    });
    return { verdict: 'CONFIRMING', mayResend: 'NO', confirmations, findings };
  }
  findings.push({ code: 'CONFIRMED', sentence: `Succeeded, ${confirmations} blocks deep.` });
  return { verdict: 'CONFIRMED', mayResend: 'NO', confirmations, findings };
}

function hexToNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

async function read(chain: EvmChain, method: EvmQuery['method'], params: unknown[]) {
  const answer = await ask<EvmQuery, EvmResult>(evmFamily(chain), { chain, method, params });
  return { result: answer.value.result, source: answer.provenance.upstreamId, readAt: answer.provenance.fetchedAt };
}

export const transactionReconcileCapability = defineCapability({
  id: 'transaction.reconcile',
  name: 'Find out what happened to a transaction',
  description:
    'Whether a transaction somebody is unsure about happened: confirmed, still confirming, reverted, pending, replaced by another ' +
    'with the same nonce, not found, or not the transaction they think it is. Says separately whether sending again is safe. ' +
    'Reads only; sends nothing.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: TransactionReconcileInput,
  output: z.object({
    chain: z.string(),
    hash: z.string(),
    verdict: z.enum(['CONFIRMED', 'CONFIRMING', 'REVERTED', 'STATUS_UNKNOWN', 'PENDING', 'REPLACED', 'NOT_FOUND', 'MISMATCH']),
    mayResend: z.enum(['NO', 'ONLY_WITH_SAME_NONCE', 'YES_AS_A_NEW_DECISION']),
    confirmations: z.number().nullable(),
    blockNumber: z.number().nullable(),
    observed: z.object({ from: z.string().nullable(), to: z.string().nullable(), valueWei: z.string().nullable(), nonce: z.number().nullable() }).nullable(),
    findings: z.array(z.object({ code: z.string(), sentence: z.string() })),
    sources: z.array(z.object({ read: z.string(), source: z.string(), readAt: z.string() })),
  }),
  modelCallable: true,
  timeoutMs: 40_000,
  async run(input) {
    const sources: { read: string; source: string; readAt: string }[] = [];
    const txRead = await read(input.chain, 'eth_getTransactionByHash', [input.hash]);
    sources.push({ read: 'transaction', source: txRead.source, readAt: txRead.readAt });
    const raw = txRead.result as Record<string, unknown> | null;
    const transaction = raw
      ? {
          from: typeof raw.from === 'string' ? raw.from : null,
          to: typeof raw.to === 'string' ? raw.to : null,
          valueWei: hexToExactInteger(raw.value),
          nonce: hexToNumber(raw.nonce),
          blockNumber: hexToNumber(raw.blockNumber),
        }
      : null;

    let receipt: ReconcileObservation['receipt'] = null;
    let head: number | null = null;
    if (transaction?.blockNumber != null) {
      const receiptRead = await read(input.chain, 'eth_getTransactionReceipt', [input.hash]);
      sources.push({ read: 'receipt', source: receiptRead.source, readAt: receiptRead.readAt });
      const row = receiptRead.result as Record<string, unknown> | null;
      if (row) {
        const status = hexToNumber(row.status);
        receipt = { succeeded: status === null ? null : status === 1, blockNumber: hexToNumber(row.blockNumber) };
      }
      const headRead = await read(input.chain, 'eth_blockNumber', []);
      sources.push({ read: 'head', source: headRead.source, readAt: headRead.readAt });
      head = hexToNumber(headRead.result);
    }

    // Only asked when it decides between NOT_FOUND and REPLACED: the count
    // at "latest" is what has been mined, which is what "used" means here.
    let senderMinedNonce: number | null = null;
    if (!transaction && input.expect?.from !== undefined && input.expect.nonce !== undefined) {
      const nonceRead = await read(input.chain, 'eth_getTransactionCount', [input.expect.from, 'latest']);
      sources.push({ read: 'sender nonce', source: nonceRead.source, readAt: nonceRead.readAt });
      senderMinedNonce = hexToNumber(nonceRead.result);
    }

    const judged = judgeReconciliation({ transaction, receipt, head, senderMinedNonce }, input.expect, input.confirmations);
    return {
      chain: input.chain,
      hash: input.hash,
      ...judged,
      blockNumber: transaction?.blockNumber ?? null,
      observed: transaction ? { from: transaction.from, to: transaction.to, valueWei: transaction.valueWei, nonce: transaction.nonce } : null,
      sources,
    };
  },
});
