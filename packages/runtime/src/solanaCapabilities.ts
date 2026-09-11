import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  COMMITMENTS,
  SOLANA_FAMILY,
  ask,
  exactInteger,
  familyHealth,
  isAddress,
  isSignature,
  withDecimals,
  type Commitment,
  type Provenance,
  type SolanaQuery,
  type SolanaResult,
} from '@xbam/upstream';

/**
 * What an agent may ask about Solana.
 *
 * ### Three things every answer here carries
 *
 * **Which commitment.** `finalized` by default. A `processed` read can still be
 * rolled back, so a number without its commitment is a number whose reliability
 * nobody can judge. It travels with the answer rather than being assumed.
 *
 * **Which slot.** Solana reports the slot a state read happened at, on the read
 * itself. It is a better answer to "as of when" than a timestamp taken locally
 * afterwards, and it is free, so it is always passed on.
 *
 * **Exactly.** Lamports and token amounts are u64 and arrive as exact decimal
 * strings, never as doubles. A balance rounded by `JSON.parse` is an invented
 * number, and this is the kind of number people act on.
 *
 * ### A failed transaction is still a transaction
 *
 * `getSignaturesForAddress` returns transactions that reverted, with an `err`
 * field. Reading that list as "recent activity" and dropping `err` reports a
 * failed transfer as a transfer -- so `succeeded` is stated on every entry, and
 * the capability that returns a list says how many of them failed.
 *
 * ### Nothing here signs, sends, or asks the cluster to execute anything
 *
 * No `sendTransaction`, no `requestAirdrop`, no `simulateTransaction`. The
 * upstream's allowlist is the enforcement; this layer never has the vocabulary
 * in the first place.
 */

const Commitment_ = z.enum(COMMITMENTS).default('finalized');

/**
 * An address, decoded rather than pattern-matched.
 *
 * 32 bytes of base58. A length regex both accepts things that are not addresses
 * and rejects real ones that encode short, so the check is a decode.
 */
const Address = z
  .string()
  .trim()
  .refine(isAddress, 'A Solana address is 32 bytes of base58, usually 32 to 44 characters.');

const Signature = z
  .string()
  .trim()
  .refine(isSignature, 'A Solana transaction signature is 64 bytes of base58, usually 87 or 88 characters.');

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

/** One question to the cluster, normalised. */
async function readSolana(method: SolanaQuery['method'], params: unknown[], commitment: Commitment) {
  const answer = await ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, { method, params, commitment });
  return {
    result: answer.value.result,
    commitment: answer.value.commitment,
    slot: answer.value.slot,
    provenance: reported(answer.provenance),
  };
}

/** The `value` of a state read, which Solana wraps in a context envelope. */
function valueOf(result: unknown): unknown {
  if (result && typeof result === 'object' && 'value' in result) return (result as { value: unknown }).value;
  return result;
}

async function solanaReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(SOLANA_FAMILY);
  if (health.length === 0) return { status: 'UNAVAILABLE', why: 'No Solana source is configured.' };
  if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  return {
    status: 'UNAVAILABLE',
    why: 'The Solana source is not answering at the moment. Ask solana.health for why.',
  };
}

const LAMPORT_DECIMALS = 9;

const health = defineCapability({
  id: 'solana.health',
  name: 'Say whether Solana can be read right now',
  description:
    'Whether this installation can read Solana, which slot the cluster is on, and what the node is running. ' +
    'Useful when a Solana question has just failed and it matters whether the chain or the source is the problem.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({}),
  output: z.object({
    readable: z.boolean(),
    slot: z.number().nullable(),
    nodeVersion: z.string().nullable(),
    sources: z.array(z.object({ id: z.string(), host: z.string(), state: z.string(), why: z.string().nullable() })),
    /** Said plainly, because one source means no fallback. */
    note: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run() {
    const entries = await familyHealth(SOLANA_FAMILY);
    const sources = entries.map((entry) => ({
      id: entry.upstream.id,
      host: entry.upstream.origin,
      state: entry.health.state,
      // `|| null` rather than `?? null`: a healthy source reports an empty
      // reason, and an empty string in an answer is noise a reader has to
      // interpret.
      why: entry.health.why || null,
    }));

    let slot: number | null = null;
    let nodeVersion: string | null = null;
    let readable = false;
    try {
      const read = await readSolana('getSlot', [{ commitment: 'finalized' }], 'finalized');
      slot = typeof read.result === 'number' ? read.result : null;
      readable = true;
      const version = await readSolana('getVersion', [], 'finalized');
      const core = (version.result as { 'solana-core'?: unknown } | null)?.['solana-core'];
      nodeVersion = typeof core === 'string' ? core : null;
    } catch {
      readable = false;
    }

    return {
      readable,
      slot,
      nodeVersion,
      sources,
      note:
        sources.length === 1
          ? 'There is one public Solana source and no fallback: if it is not answering, Solana cannot be read at all.'
          : `There are ${sources.length} Solana sources.`,
    };
  },
});

const account = defineCapability({
  id: 'solana.read_account',
  name: 'Read a Solana account',
  description:
    'What an address actually is on Solana: its balance in lamports, which program owns it, whether it is an ' +
    'executable program, and its parsed contents when the owning program is one the cluster can parse. ' +
    'On Solana a wallet, a token mint and a token balance are all accounts.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ address: Address, commitment: Commitment_ }),
  output: z.object({
    address: z.string(),
    exists: z.boolean(),
    lamports: z.string().nullable(),
    sol: z.string().nullable(),
    /** The program that owns it, which is what says what kind of thing it is. */
    owner: z.string().nullable(),
    executable: z.boolean().nullable(),
    spaceBytes: z.number().nullable(),
    /** "mint", "account", and so on, when the cluster could parse the contents. */
    parsedType: z.string().nullable(),
    parsedProgram: z.string().nullable(),
    commitment: z.string(),
    slot: z.number().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => solanaReadable(),
  async run(input) {
    const read = await readSolana(
      'getAccountInfo',
      [input.address, { commitment: input.commitment, encoding: 'jsonParsed' }],
      input.commitment,
    );
    const value = valueOf(read.result) as {
      lamports?: unknown;
      owner?: unknown;
      executable?: unknown;
      space?: unknown;
      data?: unknown;
    } | null;

    // A null value is an account that does not exist -- which on Solana is an
    // ordinary answer about an address nobody has funded, not a failure.
    if (!value) {
      return {
        address: input.address,
        exists: false,
        lamports: null,
        sol: null,
        owner: null,
        executable: null,
        spaceBytes: null,
        parsedType: null,
        parsedProgram: null,
        commitment: read.commitment,
        slot: read.slot,
        provenance: read.provenance,
      };
    }

    const lamports = exactInteger(value.lamports);
    const parsed = (value.data as { parsed?: { type?: unknown }; program?: unknown } | undefined) ?? undefined;

    return {
      address: input.address,
      exists: true,
      lamports,
      sol: lamports === null ? null : withDecimals(lamports, LAMPORT_DECIMALS),
      owner: typeof value.owner === 'string' ? value.owner : null,
      executable: typeof value.executable === 'boolean' ? value.executable : null,
      spaceBytes: typeof value.space === 'number' ? value.space : null,
      parsedType: typeof parsed?.parsed?.type === 'string' ? parsed.parsed.type : null,
      parsedProgram: typeof parsed?.program === 'string' ? parsed.program : null,
      commitment: read.commitment,
      slot: read.slot,
      provenance: read.provenance,
    };
  },
});

const balance = defineCapability({
  id: 'solana.read_balance',
  name: 'Read a Solana wallet balance',
  description:
    'The SOL balance of an address, in lamports exactly and rendered in SOL. ' +
    'This is the native balance only: SPL token balances live in separate accounts.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ address: Address, commitment: Commitment_ }),
  output: z.object({
    address: z.string(),
    lamports: z.string(),
    sol: z.string(),
    commitment: z.string(),
    slot: z.number().nullable(),
    /** Said every time, because it is the mistake somebody would make with it. */
    note: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => solanaReadable(),
  async run(input) {
    const read = await readSolana(
      'getBalance',
      [input.address, { commitment: input.commitment }],
      input.commitment,
    );
    const lamports = exactInteger(valueOf(read.result));
    if (lamports === null) throw new Error('The cluster answered with something that is not a balance.');

    return {
      address: input.address,
      lamports,
      sol: withDecimals(lamports, LAMPORT_DECIMALS),
      commitment: read.commitment,
      slot: read.slot,
      note: 'This is the SOL balance only. Any tokens this wallet holds are in separate accounts and are not counted here.',
      provenance: read.provenance,
    };
  },
});

const token = defineCapability({
  id: 'solana.read_token',
  name: 'Read an SPL token mint',
  description:
    'What a token mint says about itself: total supply exactly, decimal places, and whether anybody can still ' +
    'mint more or freeze balances. Takes the exact mint address; it will not look a token up by name or ticker.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ mint: Address, commitment: Commitment_ }),
  output: z.object({
    mint: z.string(),
    isMint: z.boolean(),
    supply: z.string().nullable(),
    decimals: z.number().nullable(),
    supplyRendered: z.string().nullable(),
    /** Present means somebody can still create more of it. */
    mintAuthority: z.string().nullable(),
    /** Present means somebody can freeze a holder's balance. */
    freezeAuthority: z.string().nullable(),
    observations: z.array(z.string()),
    commitment: z.string(),
    slot: z.number().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => solanaReadable(),
  async run(input) {
    const read = await readSolana(
      'getAccountInfo',
      [input.mint, { commitment: input.commitment, encoding: 'jsonParsed' }],
      input.commitment,
    );
    const value = valueOf(read.result) as { data?: { parsed?: { type?: unknown; info?: unknown } } } | null;
    const parsed = value?.data?.parsed;

    // An address that is not a mint is a plain answer, not an error: somebody
    // pasted a wallet, and saying so is more useful than a failure.
    if (!value || parsed?.type !== 'mint') {
      return {
        mint: input.mint,
        isMint: false,
        supply: null,
        decimals: null,
        supplyRendered: null,
        mintAuthority: null,
        freezeAuthority: null,
        observations: [
          value
            ? 'This address is an account, but it is not a token mint.'
            : 'There is no account at this address on Solana.',
        ],
        commitment: read.commitment,
        slot: read.slot,
        provenance: read.provenance,
      };
    }

    const info = (parsed.info ?? {}) as {
      supply?: unknown;
      decimals?: unknown;
      mintAuthority?: unknown;
      freezeAuthority?: unknown;
    };
    const supply = exactInteger(info.supply);
    const decimals = typeof info.decimals === 'number' ? info.decimals : null;
    const mintAuthority = typeof info.mintAuthority === 'string' ? info.mintAuthority : null;
    const freezeAuthority = typeof info.freezeAuthority === 'string' ? info.freezeAuthority : null;

    // Observations, in the same spirit as token.inspect_risk: what the chain
    // says, never a verdict about the token or the people behind it.
    const observations: string[] = [];
    observations.push(
      mintAuthority
        ? 'A mint authority is set, so more of this token can still be created.'
        : 'No mint authority is set, so the supply cannot be increased.',
    );
    observations.push(
      freezeAuthority
        ? 'A freeze authority is set, so holders’ balances can be frozen.'
        : 'No freeze authority is set.',
    );

    return {
      mint: input.mint,
      isMint: true,
      supply,
      decimals,
      supplyRendered: supply !== null && decimals !== null ? withDecimals(supply, decimals) : null,
      mintAuthority,
      freezeAuthority,
      observations,
      commitment: read.commitment,
      slot: read.slot,
      provenance: read.provenance,
    };
  },
});

const program = defineCapability({
  id: 'solana.read_program',
  name: 'Tell whether a Solana address is a program',
  description:
    'Whether an address is executable program code on Solana, and which loader owns it. ' +
    'An address that is not executable is an ordinary account.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ address: Address, commitment: Commitment_ }),
  output: z.object({
    address: z.string(),
    exists: z.boolean(),
    isProgram: z.boolean(),
    loader: z.string().nullable(),
    /** Upgradeable programs can be replaced by whoever holds the authority. */
    upgradeable: z.boolean().nullable(),
    spaceBytes: z.number().nullable(),
    observations: z.array(z.string()),
    commitment: z.string(),
    slot: z.number().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => solanaReadable(),
  async run(input) {
    const read = await readSolana(
      'getAccountInfo',
      [input.address, { commitment: input.commitment, encoding: 'base64' }],
      input.commitment,
    );
    const value = valueOf(read.result) as { owner?: unknown; executable?: unknown; space?: unknown } | null;

    if (!value) {
      return {
        address: input.address,
        exists: false,
        isProgram: false,
        loader: null,
        upgradeable: null,
        spaceBytes: null,
        observations: ['There is no account at this address on Solana.'],
        commitment: read.commitment,
        slot: read.slot,
        provenance: read.provenance,
      };
    }

    const loader = typeof value.owner === 'string' ? value.owner : null;
    const executable = value.executable === true;
    // The upgradeable loader's own address. A program it owns can be replaced
    // by whoever holds the upgrade authority, which is worth saying plainly.
    const upgradeable = loader === null ? null : loader === 'BPFLoaderUpgradeab1e11111111111111111111111';

    const observations: string[] = [];
    if (!executable) {
      observations.push('This address holds data rather than program code.');
    } else if (upgradeable) {
      observations.push(
        'This is an upgradeable program: whoever holds its upgrade authority can replace the code that runs.',
      );
    } else {
      observations.push('This is a program, and its loader does not support upgrades.');
    }

    return {
      address: input.address,
      exists: true,
      isProgram: executable,
      loader,
      upgradeable: executable ? upgradeable : null,
      spaceBytes: typeof value.space === 'number' ? value.space : null,
      observations,
      commitment: read.commitment,
      slot: read.slot,
      provenance: read.provenance,
    };
  },
});

const transaction = defineCapability({
  id: 'solana.read_transaction',
  name: 'Read a Solana transaction',
  description:
    'What happened in one transaction, by its signature: whether it succeeded or failed, which slot it landed in, ' +
    'when, what it cost, and which programs it touched.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ signature: Signature, commitment: z.enum(['finalized', 'confirmed']).default('finalized') }),
  output: z.object({
    signature: z.string(),
    found: z.boolean(),
    /** Stated first, because a failed transaction looks like a successful one in a list. */
    succeeded: z.boolean().nullable(),
    failureReason: z.string().nullable(),
    slot: z.number().nullable(),
    blockTime: z.string().nullable(),
    feeLamports: z.string().nullable(),
    accounts: z.array(z.string()),
    commitment: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => solanaReadable(),
  async run(input) {
    const read = await readSolana(
      'getTransaction',
      [
        input.signature,
        {
          commitment: input.commitment,
          encoding: 'json',
          // Without this the node refuses every versioned transaction outright,
          // which today is most of them.
          maxSupportedTransactionVersion: 0,
        },
      ],
      input.commitment,
    );

    const value = read.result as {
      slot?: unknown;
      blockTime?: unknown;
      meta?: { err?: unknown; fee?: unknown };
      transaction?: { message?: { accountKeys?: unknown } };
    } | null;

    if (!value) {
      return {
        signature: input.signature,
        found: false,
        succeeded: null,
        failureReason: null,
        slot: null,
        blockTime: null,
        feeLamports: null,
        accounts: [],
        commitment: input.commitment,
        provenance: read.provenance,
      };
    }

    const err = value.meta?.err ?? null;
    const keys = value.transaction?.message?.accountKeys;

    return {
      signature: input.signature,
      found: true,
      succeeded: err === null,
      // Kept as the cluster's own structure rendered to text rather than
      // interpreted: guessing at what an InstructionError meant is how a
      // confident wrong explanation gets written.
      failureReason: err === null ? null : `The cluster reported: ${JSON.stringify(err)}`,
      slot: typeof value.slot === 'number' ? value.slot : null,
      blockTime:
        typeof value.blockTime === 'number' ? new Date(value.blockTime * 1000).toISOString() : null,
      feeLamports: exactInteger(value.meta?.fee),
      accounts: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string').slice(0, 30) : [],
      commitment: input.commitment,
      provenance: read.provenance,
    };
  },
});

const signatures = defineCapability({
  id: 'solana.read_signatures',
  name: 'List recent transactions for a Solana address',
  description:
    'The most recent transactions that touched an address, newest first, each marked as having succeeded or ' +
    'failed. Use it to see whether an account has been active and what happened, not to total up its balance.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    address: Address,
    // Capped well below the thousand the method allows: a list this long is
    // already more than an answer needs, and the cap is also what keeps one
    // question from becoming a large download.
    limit: z.number().int().min(1).max(50).default(10),
  }),
  output: z.object({
    address: z.string(),
    transactions: z.array(
      z.object({
        signature: z.string(),
        succeeded: z.boolean(),
        slot: z.number().nullable(),
        at: z.string().nullable(),
        confirmationStatus: z.string().nullable(),
        memo: z.string().nullable(),
      }),
    ),
    /** Counted out, because "recent activity" that was all failures is not activity. */
    failedCount: z.number(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => solanaReadable(),
  async run(input) {
    const read = await readSolana('getSignaturesForAddress', [input.address, { limit: input.limit }], 'finalized');
    const rows = Array.isArray(read.result) ? read.result : [];

    const transactions = rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map((row) => ({
        signature: typeof row.signature === 'string' ? row.signature : '',
        // The whole point of carrying `err` through: a reverted transaction is
        // in this list and looks identical to a successful one without it.
        succeeded: (row.err ?? null) === null,
        slot: typeof row.slot === 'number' ? row.slot : null,
        at: typeof row.blockTime === 'number' ? new Date(row.blockTime * 1000).toISOString() : null,
        confirmationStatus: typeof row.confirmationStatus === 'string' ? row.confirmationStatus : null,
        memo: typeof row.memo === 'string' ? row.memo : null,
      }))
      .filter((row) => row.signature.length > 0);

    return {
      address: input.address,
      transactions,
      failedCount: transactions.filter((row) => !row.succeeded).length,
      provenance: read.provenance,
    };
  },
});

export function registerSolanaCapabilities(): void {
  registerCapability(health);
  registerCapability(account);
  registerCapability(balance);
  registerCapability(token);
  registerCapability(program);
  registerCapability(transaction);
  registerCapability(signatures);
}
