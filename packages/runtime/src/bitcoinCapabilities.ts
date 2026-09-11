import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  BITCOIN_FAMILY,
  BITCOIN_FEES_FAMILY,
  ask,
  exactInteger,
  familyHealth,
  parseBitcoinAddress,
  isBitcoinTxid,
  sumExact,
  withDecimals,
  type BitcoinQuery,
  type BitcoinResult,
  type Provenance,
} from '@xbam/upstream';

/**
 * What an agent may ask about Bitcoin.
 *
 * ### The sentence that has to be on every address answer
 *
 * **An address is not a wallet.** Bitcoin wallets use a fresh address per
 * payment by design, so one address is a fragment of somebody's activity.
 * "This address holds 0.4 BTC" is true and, as an answer to "how much do they
 * have", almost always wrong. An agent that leaves that out is not being
 * concise, it is being misleading, so the caveat is part of the output rather
 * than something the prompt is trusted to remember.
 *
 * ### Confirmed is a depth, not a flag
 *
 * A transaction in the mempool can be replaced -- that is what replace-by-fee
 * is for -- and one in the latest block can still be reorganised away. So
 * confirmations are counted and reported, and an unconfirmed transaction says
 * that plainly instead of being reported as a payment that happened.
 *
 * ### Confirmed and unconfirmed money are never added together
 *
 * Esplora reports `chain_stats` and `mempool_stats` separately, and summing
 * them turns money that might never arrive into a balance. They stay apart all
 * the way to the answer.
 */

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

function reported(provenance: Provenance): z.infer<typeof ProvenanceOut> {
  return {
    source: provenance.upstreamId,
    host: provenance.origin,
    readAt: provenance.fetchedAt,
    fellBackFrom: provenance.fellBackFrom,
  };
}

/**
 * An address, checked by its own checksum.
 *
 * Also refuses a testnet address, which is the mistake that otherwise ends with
 * a confident zero balance for an address that was never on this chain.
 */
const Address = z
  .string()
  .trim()
  .superRefine((value, context) => {
    const parsed = parseBitcoinAddress(value);
    if (!parsed) {
      context.addIssue({
        code: 'custom',
        message: 'That is not a Bitcoin address: its own checksum does not match.',
      });
      return;
    }
    if (parsed.network !== 'mainnet') {
      context.addIssue({
        code: 'custom',
        message: 'That is a testnet address. This reads the main Bitcoin chain, where it does not exist.',
      });
    }
  });

const Txid = z
  .string()
  .trim()
  .refine(isBitcoinTxid, 'A Bitcoin transaction id is 64 hexadecimal characters, with no 0x in front.');

const SATOSHI_DECIMALS = 8;

async function readBitcoin(operation: BitcoinQuery['operation'], target = '') {
  const answer = await ask<BitcoinQuery, BitcoinResult>(BITCOIN_FAMILY, { operation, target });
  return { value: answer.value.value, tooMany: answer.value.tooMany, provenance: reported(answer.provenance) };
}

async function bitcoinReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(BITCOIN_FAMILY);
  if (health.length === 0) return { status: 'UNAVAILABLE', why: 'No Bitcoin source is configured.' };
  if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  return { status: 'UNAVAILABLE', why: 'No Bitcoin source is answering. Ask bitcoin.health for why.' };
}

/** Esplora's per-address counters, which are whole numbers of satoshis. */
const Stats = z.object({
  received: z.string(),
  spent: z.string(),
  balance: z.string(),
  transactions: z.number(),
});

function statsOf(raw: unknown): z.infer<typeof Stats> | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const funded = exactInteger(row.funded_txo_sum);
  const spent = exactInteger(row.spent_txo_sum);
  const count = row.tx_count;
  if (funded === null || spent === null || typeof count !== 'number') return null;
  // A balance is a subtraction somebody has to do, and BigInt is what does it
  // without going through a double.
  const balance = (BigInt(funded) - BigInt(spent)).toString();
  return { received: funded, spent, balance, transactions: count };
}

const health = defineCapability({
  id: 'bitcoin.health',
  name: 'Say whether Bitcoin can be read right now',
  description:
    'Whether this installation can read the Bitcoin chain, what the current block height is, and which sources ' +
    'are answering.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({}),
  output: z.object({
    readable: z.boolean(),
    blockHeight: z.number().nullable(),
    sources: z.array(z.object({ id: z.string(), host: z.string(), state: z.string(), why: z.string().nullable() })),
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run() {
    const entries = await familyHealth(BITCOIN_FAMILY);
    let blockHeight: number | null = null;
    let readable = false;
    try {
      const tip = await readBitcoin('tip_height');
      blockHeight = typeof tip.value === 'number' ? tip.value : null;
      readable = blockHeight !== null;
    } catch {
      readable = false;
    }
    return {
      readable,
      blockHeight,
      sources: entries.map((entry) => ({
        id: entry.upstream.id,
        host: entry.upstream.origin,
        state: entry.health.state,
        why: entry.health.why || null,
      })),
    };
  },
});

const address = defineCapability({
  id: 'bitcoin.read_address',
  name: 'Read a Bitcoin address',
  description:
    'What one Bitcoin address has received, spent and currently holds, and what it has pending. ' +
    'Takes an exact address. Remember that a wallet normally uses many addresses, so this is a fragment.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ address: Address }),
  output: z.object({
    address: z.string(),
    kind: z.string(),
    /** Settled, on the chain. */
    confirmed: Stats,
    /** In the mempool, and deliberately not added to the above. */
    pending: Stats,
    balanceBtc: z.string(),
    pendingBtc: z.string(),
    /** Said every time. It is the mistake this answer invites. */
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => bitcoinReadable(),
  async run(input) {
    const parsedAddress = parseBitcoinAddress(input.address)!;
    const read = await readBitcoin('address', input.address);
    const row = read.value as { chain_stats?: unknown; mempool_stats?: unknown } | null;

    const confirmed = statsOf(row?.chain_stats);
    const pending = statsOf(row?.mempool_stats);
    if (!confirmed || !pending) {
      throw new Error('That source answered with something that is not an address summary.');
    }

    const caveats = [
      'A Bitcoin wallet normally uses a new address for every payment, so this is one address rather than ' +
        'everything somebody holds.',
    ];
    if (pending.transactions > 0) {
      caveats.push(
        `There ${pending.transactions === 1 ? 'is 1 transaction' : `are ${pending.transactions} transactions`} ` +
          'still unconfirmed. That money is not settled and is not included in the balance.',
      );
    }

    return {
      address: input.address,
      kind: `${parsedAddress.kind} — ${parsedAddress.describe}`,
      confirmed,
      pending,
      balanceBtc: withDecimals(confirmed.balance, SATOSHI_DECIMALS),
      pendingBtc: withDecimals(pending.balance, SATOSHI_DECIMALS),
      caveats,
      provenance: read.provenance,
    };
  },
});

const transaction = defineCapability({
  id: 'bitcoin.read_transaction',
  name: 'Read a Bitcoin transaction',
  description:
    'What one transaction did: whether it has confirmed and how deeply, what it paid in fees, and how many ' +
    'inputs and outputs it has. An unconfirmed transaction is reported as unconfirmed.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ txid: Txid }),
  output: z.object({
    txid: z.string(),
    confirmed: z.boolean(),
    /** Depth, not a flag. Null while it is still unconfirmed. */
    confirmations: z.number().nullable(),
    blockHeight: z.number().nullable(),
    at: z.string().nullable(),
    feeSats: z.string().nullable(),
    feeBtc: z.string().nullable(),
    inputs: z.number(),
    outputs: z.number(),
    totalOutSats: z.string().nullable(),
    notes: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => bitcoinReadable(),
  async run(input) {
    const read = await readBitcoin('transaction', input.txid);
    const row = read.value as {
      status?: { confirmed?: unknown; block_height?: unknown; block_time?: unknown };
      fee?: unknown;
      vin?: unknown[];
      vout?: { value?: unknown }[];
    } | null;
    if (!row || typeof row !== 'object') {
      throw new Error('That source answered with something that is not a transaction.');
    }

    const confirmed = row.status?.confirmed === true;
    const blockHeight = typeof row.status?.block_height === 'number' ? row.status.block_height : null;

    // Confirmations need the tip, which is a second request. Worth it: "six
    // confirmations" is the thing anybody actually wants to know, and
    // "confirmed: true" for a transaction one block deep overstates it.
    let confirmations: number | null = null;
    if (confirmed && blockHeight !== null) {
      try {
        const tip = await readBitcoin('tip_height');
        if (typeof tip.value === 'number') confirmations = tip.value - blockHeight + 1;
      } catch {
        // The transaction is still worth reporting without the depth.
        confirmations = null;
      }
    }

    const outputs = Array.isArray(row.vout) ? row.vout : [];
    const totalOut = outputs.reduce((total, output) => {
      const value = exactInteger(output?.value);
      return value === null ? total : total + BigInt(value);
    }, 0n);

    const fee = exactInteger(row.fee);
    const notes: string[] = [];
    if (!confirmed) {
      notes.push(
        'This transaction is still in the mempool. It has not confirmed, and until it does it can be replaced ' +
          'by a version paying a higher fee.',
      );
    } else if (confirmations !== null && confirmations < 6) {
      notes.push(
        `It has ${confirmations} confirmation${confirmations === 1 ? '' : 's'}. Six is the usual point at which ` +
          'a payment is treated as settled.',
      );
    }

    return {
      txid: input.txid,
      confirmed,
      confirmations,
      blockHeight,
      at: typeof row.status?.block_time === 'number' ? new Date(row.status.block_time * 1000).toISOString() : null,
      feeSats: fee,
      feeBtc: fee === null ? null : withDecimals(fee, SATOSHI_DECIMALS),
      inputs: Array.isArray(row.vin) ? row.vin.length : 0,
      outputs: outputs.length,
      totalOutSats: outputs.length > 0 ? totalOut.toString() : null,
      notes,
      provenance: read.provenance,
    };
  },
});

const unspent = defineCapability({
  id: 'bitcoin.read_unspent',
  name: 'List an address’s unspent outputs',
  description:
    'The individual unspent outputs held by one address — the coins themselves, rather than a total. ' +
    'Very busy addresses have too many to list, and this says so rather than failing.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ address: Address, limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({
    address: z.string(),
    listed: z.boolean(),
    outputs: z.array(
      z.object({
        txid: z.string(),
        vout: z.number(),
        valueSats: z.string(),
        valueBtc: z.string(),
        confirmed: z.boolean(),
        blockHeight: z.number().nullable(),
      }),
    ),
    totalShownSats: z.string(),
    truncated: z.boolean(),
    note: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => bitcoinReadable(),
  async run(input) {
    const read = await readBitcoin('unspent', input.address);

    // Not a failure: it is the source telling us something true about the
    // address. An agent told "that failed" tries something else; an agent told
    // there are too many to list has learned what it asked.
    if (read.tooMany) {
      return {
        address: input.address,
        listed: false,
        outputs: [],
        totalShownSats: '0',
        truncated: false,
        note: 'This address has too many unspent outputs for the source to list. Ask bitcoin.read_address for its totals instead.',
        provenance: read.provenance,
      };
    }

    const rows = Array.isArray(read.value) ? read.value : [];
    const outputs = rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .slice(0, input.limit)
      .map((row) => {
        const value = exactInteger(row.value) ?? '0';
        const status = (row.status ?? {}) as { confirmed?: unknown; block_height?: unknown };
        return {
          txid: typeof row.txid === 'string' ? row.txid : '',
          vout: typeof row.vout === 'number' ? row.vout : 0,
          valueSats: value,
          valueBtc: withDecimals(value, SATOSHI_DECIMALS),
          confirmed: status.confirmed === true,
          blockHeight: typeof status.block_height === 'number' ? status.block_height : null,
        };
      });

    // Summed exactly: a total can pass the safe range even when no single
    // output does.
    const total = sumExact(outputs.map((output) => output.valueSats));
    const truncated = rows.length > outputs.length;

    return {
      address: input.address,
      listed: true,
      outputs,
      totalShownSats: total,
      truncated,
      note: truncated
        ? `Showing ${outputs.length} of ${rows.length} unspent outputs, so the total above is not the address's balance.`
        : 'These are all of this address’s unspent outputs.',
      provenance: read.provenance,
    };
  },
});

const fees = defineCapability({
  id: 'bitcoin.read_fees',
  name: 'Say what a Bitcoin transaction costs right now',
  description:
    'The fee rates a transaction currently needs to confirm quickly, within half an hour, or eventually, ' +
    'in satoshis per virtual byte.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({}),
  output: z.object({
    fastestSatsPerVbyte: z.number().nullable(),
    halfHourSatsPerVbyte: z.number().nullable(),
    hourSatsPerVbyte: z.number().nullable(),
    minimumSatsPerVbyte: z.number().nullable(),
    note: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: async () => {
    const entries = await familyHealth(BITCOIN_FEES_FAMILY);
    if (entries.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' as const };
    return { status: 'UNAVAILABLE' as const, why: 'The fee source is not answering.' };
  },
  async run() {
    const answer = await ask<Record<string, never>, Record<string, unknown>>(BITCOIN_FEES_FAMILY, {});
    const row = answer.value;
    const rate = (key: string) => (typeof row[key] === 'number' ? (row[key] as number) : null);

    return {
      fastestSatsPerVbyte: rate('fastestFee'),
      halfHourSatsPerVbyte: rate('halfHourFee'),
      hourSatsPerVbyte: rate('hourFee'),
      minimumSatsPerVbyte: rate('minimumFee'),
      note: 'These are estimates from one source, and the fee market moves with each block. They are a guide, not a quote.',
      provenance: reported(answer.provenance),
    };
  },
});

export function registerBitcoinCapabilities(): void {
  registerCapability(health);
  registerCapability(address);
  registerCapability(transaction);
  registerCapability(unspent);
  registerCapability(fees);
}
