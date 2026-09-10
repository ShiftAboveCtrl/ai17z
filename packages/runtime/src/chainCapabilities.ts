import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  EVM_CHAINS,
  ask,
  evmFamily,
  familyHealth,
  type EvmChain,
  type EvmQuery,
  type EvmResult,
  type Provenance,
} from '@xbam/upstream';

/**
 * What an agent may ask about a chain.
 *
 * ### The model never learns a vendor's vocabulary
 *
 * It asks `chain.read_balance`, not `eth_getBalance`, and certainly not
 * `ankr.eth_getBalance`. Which node answered is provenance -- worth reporting,
 * never worth choosing -- and an upstream can be replaced tomorrow without
 * anything the model knows becoming wrong. A capability catalogue that leaked
 * endpoint names would be a vendor list the model had to understand, and every
 * change to it would be a change to what agents know.
 *
 * ### Everything here is a read, and several are deliberately absent
 *
 * There is no capability that sends, signs, unlocks or approves, and no generic
 * contract call. `chain.read_token`, `chain.read_supply` and
 * `chain.read_allowance` are **not here yet** on purpose: each needs
 * `eth_call`, which is a read in the protocol's sense and an arbitrary contract
 * invocation in practice. They arrive when there is a typed, bounded
 * contract-view capability that cannot be shaped into transaction-like input --
 * not by opening a hole and promising to be careful.
 *
 * ### An answer says where it came from
 *
 * Every output carries the upstream, the host and the moment. A balance with no
 * source is a number an agent will state as confidently as a right one, and
 * these are numbers people act on.
 */

/** A chain the installation knows, by the name a person would use. */
const ChainName = z.enum(Object.keys(EVM_CHAINS) as [EvmChain, ...EvmChain[]]);

/**
 * An address, checked rather than hoped for.
 *
 * Never normalised into existence: something that is not an address is refused
 * here rather than sent to a node that will answer about a different one, or
 * about zero.
 */
const Address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'An EVM address is 0x followed by 40 hexadecimal characters.');

const TxHash = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'A transaction hash is 0x followed by 64 hexadecimal characters.');

const ProvenanceOut = z.object({
  source: z.string(),
  host: z.string(),
  readAt: z.string(),
  fellBackFrom: z.array(z.string()),
});

/** Turns the runtime's provenance into the shape an answer carries. */
function reported(provenance: Provenance): z.infer<typeof ProvenanceOut> {
  return {
    source: provenance.upstreamId,
    host: provenance.origin,
    readAt: provenance.fetchedAt,
    fellBackFrom: provenance.fellBackFrom,
  };
}

/** One question to one chain's family, normalised. */
async function readChain(chain: EvmChain, method: EvmQuery['method'], params: unknown[] = []) {
  const answer = await ask<EvmQuery, EvmResult>(evmFamily(chain), { chain, method, params });
  return { result: answer.value.result, chainId: answer.value.chainId, provenance: reported(answer.provenance) };
}

/** Hex quantity to a decimal string, because a balance does not fit in a number. */
function hexToDecimalString(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
  return BigInt(value === '0x' ? '0x0' : value).toString(10);
}

function hexToNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether any chain can be read at all.
 *
 * Deliberately not per chain: readiness is asked before there is an input, so
 * it cannot know which chain is about to be wanted. It answers the question a
 * screen is actually asking -- can this agent read a chain at all -- and
 * `chain.health` answers the detailed one on demand. An earlier version reached
 * into the context for a chain the context does not carry, which would have
 * quietly reported on Ethereum whatever was asked.
 */
async function anyChainReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const chains = Object.keys(EVM_CHAINS) as EvmChain[];
  const unavailable: string[] = [];
  for (const chain of chains) {
    const health = await familyHealth(evmFamily(chain));
    if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
    unavailable.push(chain);
  }
  return {
    status: 'UNAVAILABLE',
    why:
      unavailable.length === chains.length && chains.length > 0
        ? 'No chain source is answering at the moment. Ask chain.health for which and why.'
        : 'No chain source is configured.',
  };
}

const balance = defineCapability({
  id: 'chain.read_balance',
  name: 'Read a wallet balance on a chain',
  description:
    'The native coin balance of an address on a specific chain, in wei and as a decimal string. ' +
    'Needs the exact chain and the exact address; it will not guess either.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: Address }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    address: z.string(),
    wei: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => anyChainReadable(),
  async run(input) {
    const read = await readChain(input.chain, 'eth_getBalance', [input.address, 'latest']);
    const wei = hexToDecimalString(read.result);
    if (wei === null) throw new Error('That node answered with something that is not a balance.');
    return {
      chain: input.chain,
      chainId: read.chainId,
      address: input.address,
      wei,
      provenance: read.provenance,
    };
  },
});

const code = defineCapability({
  id: 'chain.read_code',
  name: 'Tell whether an address is a contract',
  description:
    'Whether an address holds contract code on a chain, and how large that code is. ' +
    'An address with no code is an ordinary wallet.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: Address }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    address: z.string(),
    isContract: z.boolean(),
    codeBytes: z.number(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run(input) {
    const read = await readChain(input.chain, 'eth_getCode', [input.address, 'latest']);
    const hex = typeof read.result === 'string' ? read.result : '0x';
    const bytes = Math.max(0, Math.floor((hex.replace(/^0x/, '').length || 0) / 2));
    return {
      chain: input.chain,
      chainId: read.chainId,
      address: input.address,
      isContract: bytes > 0,
      codeBytes: bytes,
      provenance: read.provenance,
    };
  },
});

const transaction = defineCapability({
  id: 'chain.read_transaction',
  name: 'Read a transaction',
  description:
    'What a transaction did, by its hash, on a specific chain. Reports whether it is still pending. ' +
    'Says it could not find it rather than guessing when the hash is not on that chain.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, hash: TxHash }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    found: z.boolean(),
    pending: z.boolean(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    valueWei: z.string().nullable(),
    blockNumber: z.number().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run(input) {
    const read = await readChain(input.chain, 'eth_getTransactionByHash', [input.hash]);
    const tx = read.result as Record<string, unknown> | null;
    if (!tx) {
      // Absent is not zero, and "not on this chain" is a real answer rather
      // than a failure to be retried round the family.
      return {
        chain: input.chain,
        chainId: read.chainId,
        found: false,
        pending: false,
        from: null,
        to: null,
        valueWei: null,
        blockNumber: null,
        provenance: read.provenance,
      };
    }
    const blockNumber = hexToNumber(tx.blockNumber);
    return {
      chain: input.chain,
      chainId: read.chainId,
      found: true,
      // A transaction with no block is in the mempool, which is a different
      // thing from one that has been mined and is worth saying plainly.
      pending: blockNumber === null,
      from: typeof tx.from === 'string' ? tx.from : null,
      to: typeof tx.to === 'string' ? tx.to : null,
      valueWei: hexToDecimalString(tx.value),
      blockNumber,
      provenance: read.provenance,
    };
  },
});

const receipt = defineCapability({
  id: 'chain.read_receipt',
  name: 'Read whether a transaction succeeded',
  description:
    'The outcome of a mined transaction: whether it succeeded, what it cost, and how many logs it produced. ' +
    'A transaction that is still pending has no receipt yet, and that is reported rather than treated as a failure.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, hash: TxHash }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    found: z.boolean(),
    succeeded: z.boolean().nullable(),
    gasUsed: z.string().nullable(),
    blockNumber: z.number().nullable(),
    logCount: z.number().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run(input) {
    const read = await readChain(input.chain, 'eth_getTransactionReceipt', [input.hash]);
    const row = read.result as Record<string, unknown> | null;
    if (!row) {
      return {
        chain: input.chain,
        chainId: read.chainId,
        found: false,
        succeeded: null,
        gasUsed: null,
        blockNumber: null,
        logCount: null,
        provenance: read.provenance,
      };
    }
    const status = hexToNumber(row.status);
    return {
      chain: input.chain,
      chainId: read.chainId,
      found: true,
      // Pre-Byzantium receipts have no status field. Null rather than false:
      // "unknown" and "reverted" are different answers.
      succeeded: status === null ? null : status === 1,
      gasUsed: hexToDecimalString(row.gasUsed),
      blockNumber: hexToNumber(row.blockNumber),
      logCount: Array.isArray(row.logs) ? row.logs.length : null,
      provenance: read.provenance,
    };
  },
});

const block = defineCapability({
  id: 'chain.read_block',
  name: 'Read a block',
  description:
    'A block on a chain, by number or the latest one: when it was produced, how many transactions it holds, ' +
    'and what gas it used. Useful for turning a block number into a time.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: ChainName,
    // A number, or the head. Deliberately not an arbitrary tag: "pending" and
    // "safe" mean different things on different chains and would answer
    // differently depending on which node happened to be asked.
    block: z.union([z.number().int().nonnegative(), z.literal('latest')]).default('latest'),
  }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    number: z.number().nullable(),
    minedAt: z.string().nullable(),
    transactionCount: z.number().nullable(),
    gasUsed: z.string().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run(input) {
    const tag = input.block === 'latest' ? 'latest' : `0x${input.block.toString(16)}`;
    // `false` asks for hashes rather than whole transactions: a full block on a
    // busy chain is megabytes, and nothing here needs it.
    const read = await readChain(input.chain, 'eth_getBlockByNumber', [tag, false]);
    const row = read.result as Record<string, unknown> | null;
    if (!row) {
      return {
        chain: input.chain,
        chainId: read.chainId,
        number: null,
        minedAt: null,
        transactionCount: null,
        gasUsed: null,
        provenance: read.provenance,
      };
    }
    const timestamp = hexToNumber(row.timestamp);
    return {
      chain: input.chain,
      chainId: read.chainId,
      number: hexToNumber(row.number),
      minedAt: timestamp === null ? null : new Date(timestamp * 1000).toISOString(),
      transactionCount: Array.isArray(row.transactions) ? row.transactions.length : null,
      gasUsed: hexToDecimalString(row.gasUsed),
      provenance: read.provenance,
    };
  },
});

/**
 * The widest span of blocks one question may cover.
 *
 * A log query over a whole chain is a request nobody's free endpoint wants and
 * an answer nothing here could hold. Bounded at the schema so the refusal is a
 * sentence about the question rather than a timeout halfway through.
 */
const MAX_LOG_SPAN = 2_000;

const logs = defineCapability({
  id: 'chain.read_logs',
  name: 'Read events a contract emitted',
  description:
    'Events emitted by one contract over a bounded range of blocks. ' +
    `The range may cover at most ${MAX_LOG_SPAN} blocks, because a wider question is one no public node will answer.`,
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z
    .object({
      chain: ChainName,
      address: Address,
      fromBlock: z.number().int().nonnegative(),
      toBlock: z.number().int().nonnegative(),
      /** Topic filters, as the chain expresses them. Bounded and optional. */
      topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(4).default([]),
    })
    .refine((value) => value.toBlock >= value.fromBlock, {
      message: 'The range has to end at or after it starts.',
    })
    .refine((value) => value.toBlock - value.fromBlock < MAX_LOG_SPAN, {
      message: `The range may cover at most ${MAX_LOG_SPAN} blocks.`,
    }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    count: z.number(),
    events: z
      .array(
        z.object({
          blockNumber: z.number().nullable(),
          transactionHash: z.string().nullable(),
          topics: z.array(z.string()),
        }),
      )
      .max(200),
    truncated: z.boolean(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  async run(input) {
    const read = await readChain(input.chain, 'eth_getLogs', [
      {
        address: input.address,
        fromBlock: `0x${input.fromBlock.toString(16)}`,
        toBlock: `0x${input.toBlock.toString(16)}`,
        ...(input.topics.length > 0 ? { topics: input.topics } : {}),
      },
    ]);
    const rows = Array.isArray(read.result) ? (read.result as Record<string, unknown>[]) : [];
    // Truncated rather than trimmed silently: a model told it has every event
    // will reason as though it does.
    const kept = rows.slice(0, 200);
    return {
      chain: input.chain,
      chainId: read.chainId,
      count: rows.length,
      events: kept.map((row) => ({
        blockNumber: hexToNumber(row.blockNumber),
        transactionHash: typeof row.transactionHash === 'string' ? row.transactionHash : null,
        topics: Array.isArray(row.topics) ? (row.topics as string[]) : [],
      })),
      truncated: rows.length > kept.length,
      provenance: read.provenance,
    };
  },
});

const health = defineCapability({
  id: 'chain.health',
  name: 'Say which chains can be read right now',
  description:
    'Which chains this installation can currently read, which sources answer for each, and why any of them cannot. ' +
    'Useful when a chain question has just failed and the agent needs to say whether it is the question or the source.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName.optional() }),
  output: z.object({
    chains: z.array(
      z.object({
        chain: z.string(),
        chainId: z.number(),
        readable: z.boolean(),
        sources: z.array(z.object({ name: z.string(), host: z.string(), state: z.string(), why: z.string() })),
      }),
    ),
  }),
  modelCallable: true,
  timeoutMs: 10_000,
  async run(input) {
    const wanted = input.chain ? [input.chain] : (Object.keys(EVM_CHAINS) as EvmChain[]);
    const chains = [];
    for (const chain of wanted) {
      const entries = await familyHealth(evmFamily(chain));
      chains.push({
        chain,
        chainId: EVM_CHAINS[chain],
        readable: entries.some((entry) => entry.health.state === 'READY'),
        sources: entries.map((entry) => ({
          name: entry.upstream.name,
          host: entry.upstream.origin,
          state: entry.health.state,
          why: entry.health.why,
        })),
      });
    }
    return { chains };
  },
});

/**
 * Registered explicitly, at bootstrap, like every other capability.
 *
 * A registry filled at import time holds whatever happened to be imported.
 */
export function registerChainCapabilities(): void {
  // One at a time rather than over an array: the schemas differ per capability,
  // so an array of them infers a union and nothing matches it.
  registerCapability(balance);
  registerCapability(code);
  registerCapability(transaction);
  registerCapability(receipt);
  registerCapability(block);
  registerCapability(logs);
  registerCapability(health);
}
