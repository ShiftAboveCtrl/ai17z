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

import { firstFundingFromTransaction, MAX_HOLDER_MAP_HOLDERS, type FundingRead, type HolderReadInput } from './holderMap';

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
type SolanaReader = typeof readSolana;
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

/** The two programs an SPL token account can belong to. */
const TOKEN_PROGRAMS = [
  { id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', name: 'Token' },
  { id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', name: 'Token-2022' },
] as const;

/** More than this many token accounts is a wallet somebody airdropped dust into; the largest are kept. */
const MAX_HOLDINGS = 100;

const holdings = defineCapability({
  id: 'solana.read_token_holdings',
  name: 'Read the tokens a Solana wallet holds',
  description:
    'Every SPL token a wallet holds a balance of, across both token programs: the mint, the exact amount ' +
    'and its decimals. It names mints, never tickers, and says nothing about what any of it is worth.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ owner: Address, commitment: Commitment_ }),
  output: z.object({
    owner: z.string(),
    holdings: z.array(
      z.object({
        mint: z.string(),
        account: z.string(),
        program: z.string(),
        amount: z.string(),
        decimals: z.number(),
        rendered: z.string(),
      }),
    ),
    /** Accounts holding nothing are left out, and said so; so are any past the largest hundred. */
    emptyAccounts: z.number(),
    truncated: z.boolean(),
    commitment: z.string(),
    slot: z.number().nullable(),
    note: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => solanaReadable(),
  async run(input) {
    // One question per token program: a wallet's Token-2022 holdings are invisible to a read of the original program.
    const reads = await Promise.all(
      TOKEN_PROGRAMS.map((program) =>
        readSolana(
          'getTokenAccountsByOwner',
          [input.owner, { programId: program.id }, { encoding: 'jsonParsed', commitment: input.commitment }],
          input.commitment,
        ).then((read) => ({ program, read })),
      ),
    );
    const rows: { mint: string; account: string; program: string; amount: string; decimals: number; rendered: string }[] = [];
    let emptyAccounts = 0;
    for (const { program, read } of reads) {
      const value = valueOf(read.result);
      if (!Array.isArray(value)) throw new Error('The cluster answered with something that is not a list of token accounts.');
      for (const entry of value as { pubkey?: unknown; account?: { data?: { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } } } } }[]) {
        const info = entry.account?.data?.parsed?.info;
        const amount = exactInteger(info?.tokenAmount?.amount);
        const decimals = info?.tokenAmount?.decimals;
        if (typeof entry.pubkey !== 'string' || typeof info?.mint !== 'string' || amount === null || typeof decimals !== 'number') continue;
        if (amount === '0') {
          emptyAccounts += 1;
          continue;
        }
        rows.push({ mint: info.mint, account: entry.pubkey, program: program.name, amount, decimals, rendered: withDecimals(amount, decimals) });
      }
    }
    // Largest first by exact amount in whole units, compared without a double.
    rows.sort((a, b) => compareRendered(b.rendered, a.rendered));
    const first = reads[0]!.read;
    return {
      owner: input.owner,
      holdings: rows.slice(0, MAX_HOLDINGS),
      emptyAccounts,
      truncated: rows.length > MAX_HOLDINGS,
      commitment: first.commitment,
      slot: first.slot,
      note: 'Amounts are exact and in the token’s own units. This says what is held, not what it is worth; a mint is not a name, and anybody can create a token called anything.',
      provenance: first.provenance,
    };
  },
});

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Who holds a token: the largest balances and who owns each one.
 *
 * A token account is owned by a key. When that key is an ordinary wallet, its
 * own account belongs to the System Program (or does not exist, holding no
 * SOL); when it belongs to anything else, the key is controlled by a program,
 * which for a memecoin is usually a pool's vault or a launchpad's curve. That
 * is the whole of the classification, and it is said to be a heuristic: it
 * separates a pool from a person, and claims nothing about who the person is
 * or whether two wallets are the same one.
 */
const holders = defineCapability({
  id: 'solana.read_token_holders',
  name: 'Read who holds an SPL token',
  description:
    'The largest holders of a token mint, up to twenty: each balance exactly, its share of the supply, and ' +
    'whether its owner looks like a wallet or a program such as a pool or launchpad. Reports how concentrated ' +
    'the supply is, with and without the programs. Takes the exact mint address.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ mint: Address, commitment: Commitment_ }),
  output: z.object({
    mint: z.string(),
    supply: z.string().nullable(),
    decimals: z.number().nullable(),
    holders: z.array(
      z.object({
        account: z.string(),
        owner: z.string().nullable(),
        amount: z.string(),
        rendered: z.string(),
        /** Per cent of the supply, to two places, from exact integers. */
        sharePct: z.number().nullable(),
        kind: z.enum(['WALLET', 'PROGRAM', 'UNKNOWN']),
      }),
    ),
    /** Per cent of the supply in the ten largest accounts, and in the ten largest that belong to wallets. */
    top10Pct: z.number().nullable(),
    top10WalletsPct: z.number().nullable(),
    observations: z.array(z.string()),
    commitment: z.string(),
    slot: z.number().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => solanaReadable(),
  run: (input) => readTokenHolders(input),
});

/** The body of `solana.read_token_holders`, shared with the holder map's bounded read. */
async function readTokenHolders(input: { mint: string; commitment: Commitment }, read_: SolanaReader = readSolana) {
    const [supplyRead, largestRead] = await Promise.all([
      read_('getTokenSupply', [input.mint, { commitment: input.commitment }], input.commitment),
      read_('getTokenLargestAccounts', [input.mint, { commitment: input.commitment }], input.commitment),
    ]);
    const supplyValue = valueOf(supplyRead.result) as { amount?: unknown; decimals?: unknown } | null;
    const supply = exactInteger(supplyValue?.amount);
    const decimals = typeof supplyValue?.decimals === 'number' ? supplyValue.decimals : null;
    const largest = valueOf(largestRead.result);
    if (!Array.isArray(largest)) throw new Error('The cluster answered with something that is not a list of token accounts.');
    const rows = (largest as { address?: unknown; amount?: unknown }[])
      .map((entry) => ({ account: typeof entry.address === 'string' ? entry.address : null, amount: exactInteger(entry.amount) }))
      .filter((r): r is { account: string; amount: string } => r.account !== null && r.amount !== null && r.amount !== '0');

    // Who owns each token account, then what kind of key each owner is.
    const owners = new Map<string, string | null>();
    if (rows.length > 0) {
      const accounts = valueOf(
        (await read_('getMultipleAccounts', [rows.map((r) => r.account), { encoding: 'jsonParsed', commitment: input.commitment }], input.commitment)).result,
      ) as ({ data?: { parsed?: { info?: { owner?: unknown } } } } | null)[] | null;
      rows.forEach((r, i) => {
        const owner = accounts?.[i]?.data?.parsed?.info?.owner;
        owners.set(r.account, typeof owner === 'string' ? owner : null);
      });
    }
    const distinctOwners = [...new Set([...owners.values()].filter((o): o is string => o !== null))];
    const ownerKind = new Map<string, 'WALLET' | 'PROGRAM' | 'UNKNOWN'>();
    if (distinctOwners.length > 0) {
      const ownerAccounts = valueOf(
        (await read_('getMultipleAccounts', [distinctOwners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: input.commitment }], input.commitment)).result,
      ) as ({ owner?: unknown } | null)[] | null;
      distinctOwners.forEach((owner, i) => {
        if (!Array.isArray(ownerAccounts)) return ownerKind.set(owner, 'UNKNOWN');
        const info = ownerAccounts[i];
        // No account at all is a key that has never held SOL: a wallet, not a program.
        ownerKind.set(owner, info === null || info?.owner === SYSTEM_PROGRAM ? 'WALLET' : typeof info?.owner === 'string' ? 'PROGRAM' : 'UNKNOWN');
      });
    }

    // Share of supply from exact integers, in hundredths of a per cent.
    const share = (amount: string) => (supply && supply !== '0' ? Number((BigInt(amount) * 10_000n) / BigInt(supply)) / 100 : null);
    const list = rows.map((r) => {
      const owner = owners.get(r.account) ?? null;
      return {
        account: r.account,
        owner,
        amount: r.amount,
        rendered: decimals === null ? r.amount : withDecimals(r.amount, decimals),
        sharePct: share(r.amount),
        kind: owner ? (ownerKind.get(owner) ?? 'UNKNOWN') : ('UNKNOWN' as const),
      };
    });
    const sumPct = (xs: typeof list) => (supply ? xs.reduce((n, h) => n + (h.sharePct ?? 0), 0) : null);
    const top10Pct = sumPct(list.slice(0, 10));
    const top10WalletsPct = sumPct(list.filter((h) => h.kind === 'WALLET').slice(0, 10));
    const observations: string[] = [];
    if (top10Pct !== null) observations.push(`The ten largest accounts hold ${top10Pct.toFixed(1)}% of the supply.`);
    if (top10WalletsPct !== null) observations.push(`The ten largest that look like wallets hold ${top10WalletsPct.toFixed(1)}%; the rest of the top is held by programs such as pools or launchpads.`);
    const biggestWallet = list.find((h) => h.kind === 'WALLET');
    if (biggestWallet?.sharePct !== null && biggestWallet?.sharePct !== undefined) observations.push(`The largest wallet holds ${biggestWallet.sharePct.toFixed(2)}%.`);
    observations.push('Whether an owner is a wallet or a program is read from what owns its key, a heuristic; it says nothing about who a wallet belongs to or whether two are the same person.');
    return {
      mint: input.mint,
      supply,
      decimals,
      holders: list,
      top10Pct,
      top10WalletsPct,
      observations,
      commitment: largestRead.commitment,
      slot: largestRead.slot,
      provenance: largestRead.provenance,
    };
}

/** Two non-negative decimal strings compared exactly, so a balance past 2^53 is still ordered right. */
function compareRendered(a: string, b: string): number {
  const [aw = '0', af = ''] = a.split('.');
  const [bw = '0', bf = ''] = b.split('.');
  if (aw.length !== bw.length) return aw.length - bw.length;
  if (aw !== bw) return aw < bw ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const ap = af.padEnd(width, '0');
  const bp = bf.padEnd(width, '0');
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}

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

/**
 * ### The holder map's funding read
 *
 * Bounded on every axis, because this is the one read here that fans out. At most
 * `MAX_HOLDER_MAP_HOLDERS` accounts are looked at, and for each plain wallet there are at most
 * `SIGNATURE_PAGES` signature reads plus one transaction read, then one read to learn whether a
 * funder is a program: under forty reads for a whole map, spent under the card flow's own per-asker
 * and per-mint caps. The result is cached per mint, so a mint costs at most one map per cache
 * window however many people ask, and two askers arriving together share one in-flight read.
 *
 * A wallet's first funding is read from the oldest successful transaction in a window of
 * `SIGNATURE_PAGES * SIGNATURE_PAGE` signatures. A wallet whose history runs past the window has an
 * oldest transaction nobody read, so it is `unavailable`, never guessed from a later one. Every
 * other way of not knowing is `unavailable` with a fixed reason too: the caller draws the difference
 * between "not shared" and "not read".
 *
 * Reads only. Nothing here signs, sends or labels anybody.
 */
const SIGNATURE_PAGE = 1000;
const SIGNATURE_PAGES = 2;
const HOLDER_FUNDING_CONCURRENCY = 3;
/** Past this, accounts not yet started are `unavailable`: a map that never finishes holds the reply. */
export const HOLDER_MAP_DEADLINE_MS = 60_000;
export const HOLDER_MAP_CACHE_MS = 10 * 60_000;
const HOLDER_MAP_CACHE_MAX = 64;

export interface HolderFundingRead {
  mint: string;
  /** When the holder list was read. */
  readAt: string;
  /** The upstream that answered, in the lowercase form every card reading carries. */
  source: string;
  holders: HolderReadInput[];
}

const holderMapCache = new Map<string, { at: number; read: Promise<HolderFundingRead> }>();
export function resetHolderMapCacheForTest(): void { holderMapCache.clear(); }

async function firstFundingOf(owner: string, reader: SolanaReader): Promise<FundingRead> {
  try {
    let before: string | undefined;
    let rows: { signature: string; err: unknown }[] = [];
    for (let page = 0; page < SIGNATURE_PAGES; page += 1) {
      const read = await reader('getSignaturesForAddress', [owner, before ? { limit: SIGNATURE_PAGE, before } : { limit: SIGNATURE_PAGE }], 'finalized');
      rows = (Array.isArray(read.result) ? read.result : [])
        .filter((row): row is { signature: string; err?: unknown } => Boolean(row) && typeof row === 'object' && typeof (row as { signature?: unknown }).signature === 'string')
        .map((row) => ({ signature: row.signature, err: row.err ?? null }));
      if (rows.length < SIGNATURE_PAGE) break;
      before = rows[rows.length - 1]!.signature;
      if (page === SIGNATURE_PAGES - 1) return { state: 'unavailable', reason: 'history longer than the read window' };
    }
    if (rows.length === 0) return { state: 'unavailable', reason: 'no transactions read' };
    // Newest first, so the end of the list is the start of the history; a failed one moved no SOL.
    const first = [...rows].reverse().find((row) => row.err === null);
    if (!first) return { state: 'unavailable', reason: 'no successful transaction read' };
    const tx = await reader('getTransaction', [first.signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }], 'finalized');
    const funding = firstFundingFromTransaction(tx.result, owner);
    // A funder's kind is read once for all of them afterwards; until then it is not known.
    return funding.state === 'read' ? { state: 'read', funder: funding.funder, funderIsProgram: false } : funding;
  } catch {
    // Any failure, a rate limit included, is "not read" for this one account and never a result.
    return { state: 'unavailable', reason: 'read failed' };
  }
}

async function readHolderFundingOnce(mint: string, reader: SolanaReader, now: () => number): Promise<HolderFundingRead> {
  const started = now();
  const top = await readTokenHolders({ mint, commitment: 'finalized' }, reader);
  const readAt = new Date(now()).toISOString();
  const rows = top.holders.slice(0, MAX_HOLDER_MAP_HOLDERS);
  const wallets = rows.filter((row) => row.kind === 'WALLET' && row.owner !== null);
  const funding = new Map<string, FundingRead>();
  const finished = new Map<string, string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(HOLDER_FUNDING_CONCURRENCY, wallets.length) }, async () => {
    while (next < wallets.length) {
      const owner = wallets[next++]!.owner!;
      funding.set(owner, now() - started > HOLDER_MAP_DEADLINE_MS
        ? { state: 'unavailable', reason: 'read took too long' } : await firstFundingOf(owner, reader));
      finished.set(owner, new Date(now()).toISOString());
    }
  }));

  // A funder that is a program (a pool, a launchpad, an exchange's program) is not a shared funder.
  const funders = [...new Set([...funding.values()].flatMap((f) => (f.state === 'read' ? [f.funder] : [])))];
  const funderIsProgram = new Map<string, boolean>();
  if (funders.length > 0) {
    try {
      const accounts = valueOf((await reader('getMultipleAccounts', [funders, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'finalized' }], 'finalized')).result) as ({ owner?: unknown } | null)[] | null;
      if (Array.isArray(accounts) && accounts.length === funders.length) {
        funders.forEach((funder, i) => {
          const info = accounts[i];
          // No account at all is a key that holds no SOL now: not a program.
          if (info === null || info?.owner === SYSTEM_PROGRAM) funderIsProgram.set(funder, false);
          else if (typeof info?.owner === 'string') funderIsProgram.set(funder, true);
        });
      }
    } catch {
      // Left unknown below: a funder whose kind was not read is not grouped on.
    }
  }

  const holders: HolderReadInput[] = rows.map((row) => {
    const own = row.owner ? funding.get(row.owner) : undefined;
    let result: FundingRead | undefined = own;
    if (own?.state === 'read') {
      const program = funderIsProgram.get(own.funder);
      result = program === undefined ? { state: 'unavailable', reason: 'funder kind not read' } : { ...own, funderIsProgram: program };
    }
    return {
      owner: row.owner, tokenAccount: row.account, sharePct: row.sharePct, kind: row.kind,
      // An account that was never asked (a program, or an owner the cluster did not name) has no funding read at all.
      funding: result ?? (row.kind === 'PROGRAM' ? undefined : { state: 'unavailable', reason: 'owner not read' }),
      readAt: (row.owner ? finished.get(row.owner) : undefined) ?? readAt,
    };
  });
  // The card carries sources as lowercase tokens; anything else in an upstream id is not part of the name.
  const source = top.provenance.source.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 80) || SOLANA_FAMILY;
  return { mint, readAt, source, holders };
}

/** The holder list with each plain wallet's first funding address, cached per mint. Throws only when the holder list itself could not be read. */
export function readHolderFunding(mint: string, options: { reader?: SolanaReader; now?: () => number } = {}): Promise<HolderFundingRead> {
  const now = options.now ?? Date.now;
  const hit = holderMapCache.get(mint);
  if (hit && now() - hit.at < HOLDER_MAP_CACHE_MS) return hit.read;
  const read = readHolderFundingOnce(mint, options.reader ?? readSolana, now);
  holderMapCache.set(mint, { at: now(), read });
  // A failed read is not kept: the next asker may try again, under the same caps.
  read.catch(() => { if (holderMapCache.get(mint)?.read === read) holderMapCache.delete(mint); });
  while (holderMapCache.size > HOLDER_MAP_CACHE_MAX) holderMapCache.delete(holderMapCache.keys().next().value!);
  return read;
}

export function registerSolanaCapabilities(): void {
  registerCapability(health);
  registerCapability(account);
  registerCapability(balance);
  registerCapability(token);
  registerCapability(holdings);
  registerCapability(holders);
  registerCapability(program);
  registerCapability(transaction);
  registerCapability(signatures);
}
