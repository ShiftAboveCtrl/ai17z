import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  CURATED_SIGNATURES_FAMILY,
  EVM_CHAINS,
  REGISTRY_SIGNATURES_FAMILY,
  ask,
  familyHealth,
  type ContractQuery,
  type SignatureCandidates,
  type SignatureQuery,
  type ContractRecord,
  type EvmChain,
  type Provenance,
} from '@xbam/upstream';

/**
 * What is known about a contract, and how well it is known.
 *
 * ### "Verified" is not a boolean
 *
 * Bytecode says what a contract does; source says what somebody claims it is.
 * They are only connected when a verifier recompiled the source and matched it
 * against the chain, and *how* it matched is the whole value. An `exact_match`
 * includes the metadata hash, so the source is byte-for-byte what produced the
 * deployed code. A `match` means the runtime behaviour agrees but the metadata
 * differs -- almost always fine, occasionally the difference that matters. So
 * the match quality travels with every answer rather than being flattened.
 *
 * ### A proxy's source does not describe a proxy's behaviour
 *
 * This is the trap the whole family exists to avoid. USDC's verified source is
 * `FiatTokenProxy` -- forty lines of delegation. An agent that read "verified"
 * and then answered questions about what USDC *does* would be describing the
 * proxy while a person asked about the token. Proxy and implementation are
 * reported as separate things, each with its own verification, and nothing here
 * claims one describes the other.
 */

const ChainName = z.enum(Object.keys(EVM_CHAINS) as [EvmChain, ...EvmChain[]]);

const Address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'A contract address is 0x followed by 40 hexadecimal characters.');

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

async function lookUp(chain: EvmChain, address: string, fields: ContractQuery['fields']) {
  const answer = await ask<ContractQuery, ContractRecord>(`contract_${chain}`, { chain, address, fields });
  return { record: answer.value, provenance: reported(answer.provenance) };
}

/**
 * How well a recompiled source matched the chain, in words rather than a flag.
 *
 * The service's own vocabulary is `exact_match` and `match`; a person needs to
 * know which they are looking at without learning it.
 */
function describeMatch(runtime: string | null, creation: string | null): string {
  const best = runtime ?? creation;
  if (!best) return 'Not verified.';
  if (best === 'exact_match') {
    return 'Verified, and the source is byte-for-byte what produced the deployed code.';
  }
  return 'Verified: the compiled behaviour matches the chain, though the build metadata differs.';
}

async function contractsReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  for (const chain of Object.keys(EVM_CHAINS) as EvmChain[]) {
    const health = await familyHealth(`contract_${chain}`);
    if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  }
  return { status: 'UNAVAILABLE', why: 'No source of verified contract information is answering.' };
}

const inspect = defineCapability({
  id: 'contract.inspect',
  name: 'Look up what a contract is',
  description:
    'What is known about a contract at an exact address on an exact chain: whether its source has been verified, ' +
    'what it is called, what compiled it, and whether it is a proxy standing in front of something else. ' +
    'Says plainly when nobody has verified it, which is true of most contracts.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: Address }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    address: z.string(),
    verified: z.boolean(),
    verification: z.string(),
    name: z.string().nullable(),
    compiler: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    isProxy: z.boolean(),
    proxyType: z.string().nullable(),
    /** Named separately, because a proxy's source is not the implementation's. */
    implementations: z.array(z.object({ address: z.string(), name: z.string().nullable() })),
    caution: z.string().nullable(),
    deployedBy: z.string().nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => contractsReadable(),
  async run(input) {
    const { record, provenance } = await lookUp(input.chain, input.address, [
      'compilation',
      'deployment',
      'proxyResolution',
    ]);

    const isProxy = record.proxy?.isProxy === true;
    const implementations = (record.proxy?.implementations ?? []).map((entry) => ({
      address: entry.address,
      name: entry.name ?? null,
    }));

    return {
      chain: input.chain,
      chainId: record.chainId,
      address: input.address,
      verified: record.found,
      verification: record.found ? describeMatch(record.runtimeMatch, record.creationMatch) : 'Not verified.',
      name: record.name,
      compiler: record.compilerVersion ?? record.compiler,
      verifiedAt: record.verifiedAt,
      isProxy,
      proxyType: record.proxy?.proxyType ?? null,
      implementations,
      // Said out loud, every time, because this is the mistake: the verified
      // source of a proxy describes the proxy. Answering questions about what
      // the thing *does* means looking at the implementation instead.
      caution: isProxy
        ? 'This is a proxy. Anything verified here describes the proxy itself, not the code it delegates to. ' +
          (implementations.length > 0
            ? `Ask about ${implementations[0]!.address} for the behaviour.`
            : 'The implementation address could not be resolved.')
        : null,
      deployedBy: record.deployment?.deployer ?? null,
      provenance,
    };
  },
});

const verification = defineCapability({
  id: 'contract.verification',
  name: 'Say how well a contract is verified',
  description:
    'Whether a contract at an exact address has verified source, how exactly the source matched the deployed code, ' +
    'and when that was established. Use when the question is how much to trust what a contract claims to be.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: Address }),
  output: z.object({
    chain: z.string(),
    address: z.string(),
    verified: z.boolean(),
    exact: z.boolean(),
    runtimeMatch: z.string().nullable(),
    creationMatch: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    explanation: z.string(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run(input) {
    const { record, provenance } = await lookUp(input.chain, input.address, ['compilation']);
    return {
      chain: input.chain,
      address: input.address,
      verified: record.found,
      exact: record.runtimeMatch === 'exact_match' || record.creationMatch === 'exact_match',
      runtimeMatch: record.runtimeMatch,
      creationMatch: record.creationMatch,
      verifiedAt: record.verifiedAt,
      explanation: describeMatch(record.runtimeMatch, record.creationMatch),
      provenance,
    };
  },
});

/**
 * The most entries of an ABI one answer carries.
 *
 * A large contract's ABI runs to hundreds of entries and thousands of tokens.
 * A model asking what a contract can do needs the shape, not the whole of it,
 * and a truncated answer that says it was truncated is better than one that
 * quietly fills the context.
 */
const MAX_ABI_ENTRIES = 120;

const abi = defineCapability({
  id: 'contract.abi',
  name: 'List what a contract can be asked to do',
  description:
    'The functions and events a verified contract exposes, by name. ' +
    'Only available for a contract somebody has verified; an unverified one has no published interface.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    chain: ChainName,
    address: Address,
    /** Narrows a long interface to the part that was asked about. */
    kind: z.enum(['all', 'function', 'event']).default('all'),
  }),
  output: z.object({
    chain: z.string(),
    address: z.string(),
    verified: z.boolean(),
    functions: z.array(z.object({ name: z.string(), inputs: z.array(z.string()), mutability: z.string().nullable() })),
    events: z.array(z.object({ name: z.string(), inputs: z.array(z.string()) })),
    truncated: z.boolean(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run(input) {
    const { record, provenance } = await lookUp(input.chain, input.address, ['abi']);
    const entries = Array.isArray(record.abi) ? (record.abi as Record<string, unknown>[]) : [];

    const typesOf = (entry: Record<string, unknown>): string[] =>
      Array.isArray(entry.inputs)
        ? (entry.inputs as Record<string, unknown>[]).map((i) => String(i.type ?? 'unknown'))
        : [];

    const functions = entries
      .filter((entry) => entry.type === 'function' && typeof entry.name === 'string')
      .map((entry) => ({
        name: entry.name as string,
        inputs: typesOf(entry),
        mutability: typeof entry.stateMutability === 'string' ? entry.stateMutability : null,
      }));
    const events = entries
      .filter((entry) => entry.type === 'event' && typeof entry.name === 'string')
      .map((entry) => ({ name: entry.name as string, inputs: typesOf(entry) }));

    const keptFunctions = input.kind === 'event' ? [] : functions.slice(0, MAX_ABI_ENTRIES);
    const keptEvents = input.kind === 'function' ? [] : events.slice(0, MAX_ABI_ENTRIES);

    return {
      chain: input.chain,
      address: input.address,
      verified: record.found,
      functions: keptFunctions,
      events: keptEvents,
      truncated: keptFunctions.length < functions.length || keptEvents.length < events.length,
      provenance,
    };
  },
});

const sourceMetadata = defineCapability({
  id: 'contract.source_metadata',
  name: 'Say what a contract was built from',
  description:
    'Which source files a verified contract was compiled from, with which compiler and language. ' +
    'The file names and the build, not the source text.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: Address }),
  output: z.object({
    chain: z.string(),
    address: z.string(),
    verified: z.boolean(),
    language: z.string().nullable(),
    compiler: z.string().nullable(),
    compilerVersion: z.string().nullable(),
    sourceFiles: z.array(z.string()).max(200),
    deployment: z
      .object({ transactionHash: z.string().nullable(), blockNumber: z.string().nullable(), deployer: z.string().nullable() })
      .nullable(),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run(input) {
    const { record, provenance } = await lookUp(input.chain, input.address, ['compilation', 'sourceIds', 'deployment']);
    return {
      chain: input.chain,
      address: input.address,
      verified: record.found,
      language: record.language,
      compiler: record.compiler,
      compilerVersion: record.compilerVersion,
      sourceFiles: record.sourceFiles.slice(0, 200),
      deployment: record.deployment,
      provenance,
    };
  },
});

export function registerContractCapabilities(): void {
  registerCapability(inspect);
  registerCapability(verification);
  registerCapability(abi);
  registerCapability(sourceMetadata);
  registerCapability(decodeFunction);
  registerCapability(decodeEvent);
}

// ── Naming a call or a log ───────────────────────────────────────────────────

/**
 * What a call or a log refers to, when a four-byte hash is not an identity.
 *
 * ### The problem these exist for
 *
 * `0xa9059cbb` is the commonest selector on Ethereum. Six registered signatures
 * hash to it, and the open registry lists them newest first, so `transfer(
 * address,uint256)` comes **last** and `workMyDirefulOwner(uint256,uint256)`
 * first. Naming a function from a signature database alone means reporting
 * every ERC-20 transfer on the chain as `workMyDirefulOwner`.
 *
 * ### How this answers exactly instead of guessing
 *
 * The databases supply candidates; the contract's **own verified ABI** decides
 * between them. Intersect the two and a real selector usually leaves exactly
 * one signature, which is an answer rather than a ranking -- and it is the
 * contract's own declaration of what that selector means, not a popularity
 * contest.
 *
 * Three honest outcomes, and they are different facts:
 *
 *   `CONFIRMED`  one candidate is in this contract's ABI. Authoritative.
 *   `AMBIGUOUS`  several candidates, and nothing here can choose. Every one is
 *                reported; none is promoted.
 *   `UNKNOWN`    no database knows the hash, or the contract is unverified so
 *                there is nothing to check against.
 *
 * ### Why there is no keccak here, and what that costs
 *
 * Matching a selector to an ABI entry directly would mean hashing each
 * signature, which needs keccak-256 -- a dependency this tree does not have and
 * which was a deliberate decision to avoid: intersecting candidates with the
 * ABI reaches the same authoritative answer without one, and reuses sources
 * already adopted.
 *
 * The cost is precise and worth stating: a selector that **no** database knows,
 * on a verified contract, cannot be named. The ABI is there and the function is
 * in it, but without hashing there is no way to say which entry it is. That is
 * reported as `UNKNOWN` with the reason, rather than guessed at. If that case
 * turns out to matter in practice, the answer is to add a small audited keccak
 * and match directly -- with evidence, rather than by re-litigating this.
 *
 * ### Identity, and what this deliberately does not do
 *
 * It names the function or event. It does **not** decode argument values: that
 * needs a full ABI decoder, and a subtly wrong one would produce confident
 * wrong numbers, which is worse than not offering it. The description says so
 * rather than leaving a reader to infer it from the name.
 */

/**
 * How confident the answer is, as three different facts rather than a score.
 */
const DECODE_CONFIDENCE = ['CONFIRMED', 'AMBIGUOUS', 'UNKNOWN'] as const;

const Selector = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{8}([0-9a-fA-F]{2})*$/, 'Call data is 0x followed by a 4-byte selector and any arguments.');

const Topic = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'An event topic is 0x followed by 64 hexadecimal characters.');

/** Every signature any source knows for a hash, with who said so. */
async function candidatesFor(kind: 'function' | 'event', hash: string) {
  const families: [string, string][] = [
    [CURATED_SIGNATURES_FAMILY, 'a curated signature database'],
    [REGISTRY_SIGNATURES_FAMILY, 'an open signature registry'],
  ];
  const all = new Map<string, string[]>();
  const asked: string[] = [];
  const unreachable: string[] = [];

  for (const [family, label] of families) {
    const answer = await ask<SignatureQuery, SignatureCandidates>(family, { kind, hash }).catch(() => null);
    if (!answer) {
      unreachable.push(label);
      continue;
    }
    asked.push(label);
    for (const candidate of answer.value.candidates) {
      all.set(candidate, [...(all.get(candidate) ?? []), answer.value.sourceName]);
    }
  }
  return { all, asked, unreachable };
}

/** The signature strings a verified ABI declares, in canonical form. */
function signaturesInAbi(record: ContractRecord, kind: 'function' | 'event'): Set<string> {
  const entries = Array.isArray(record.abi) ? (record.abi as Record<string, unknown>[]) : [];
  const wanted = kind === 'function' ? 'function' : 'event';
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== wanted || typeof entry.name !== 'string') continue;
    const types = Array.isArray(entry.inputs)
      ? (entry.inputs as Record<string, unknown>[]).map((input) => String(input.type ?? ''))
      : [];
    out.add(`${entry.name}(${types.join(',')})`);
  }
  return out;
}

/** Shared by both decoders: candidates in, one honest verdict out. */
async function name(kind: 'function' | 'event', hash: string, chain: EvmChain | null, address: string | null) {
  const { all, asked, unreachable } = await candidatesFor(kind, hash);
  const candidates = [...all.keys()];

  let inAbi: Set<string> | null = null;
  let verified = false;
  let provenance: z.infer<typeof ProvenanceOut> | null = null;
  if (chain && address) {
    const looked = await lookUp(chain, address, ['abi']).catch(() => null);
    if (looked) {
      provenance = looked.provenance;
      verified = Array.isArray(looked.record.abi) && looked.record.abi.length > 0;
      if (verified) inAbi = signaturesInAbi(looked.record, kind);
    }
  }

  const confirmed = inAbi ? candidates.filter((candidate) => inAbi.has(candidate)) : [];

  let confidence: (typeof DECODE_CONFIDENCE)[number];
  let why: string;
  if (confirmed.length === 1) {
    confidence = 'CONFIRMED';
    why = "This is the only candidate that appears in the contract's own verified interface.";
  } else if (candidates.length === 0) {
    confidence = 'UNKNOWN';
    why = verified
      ? 'No signature database knows this hash. The contract is verified, so the entry is in its interface, but ' +
        'naming which one would mean hashing each signature, which this does not do.'
      : 'No signature database knows this hash, and there is no verified interface to check against.';
  } else if (confirmed.length > 1) {
    confidence = 'AMBIGUOUS';
    why = "More than one candidate appears in the contract's interface, which is unusual and is reported rather than resolved.";
  } else {
    confidence = 'AMBIGUOUS';
    why = verified
      ? 'None of the known signatures appears in this contract’s interface, so the call may be to a proxy’s ' +
        'implementation rather than to this address.'
      : address
        ? 'This contract is not verified, so there is no interface to choose between the candidates.'
        : 'No contract was given, so there is nothing to choose between the candidates.';
  }

  return {
    hash,
    signature: confidence === 'CONFIRMED' ? confirmed[0]! : null,
    confidence,
    why,
    candidates: candidates.map((candidate) => ({ signature: candidate, sources: all.get(candidate) ?? [] })),
    checkedAgainstAbi: verified,
    sourcesAsked: asked,
    sourcesUnreachable: unreachable,
    note:
      'A four-byte selector is not unique: signatures that collide with a common one are registered deliberately. ' +
      'Argument values are not decoded here — only which function or event this refers to.',
    provenance,
  };
}

const Named = z.object({
  hash: z.string(),
  /** Set only when the contract's own interface confirmed it. */
  signature: z.string().nullable(),
  confidence: z.enum(DECODE_CONFIDENCE),
  why: z.string(),
  /** Every signature any source knows for this hash, each with who said so. */
  candidates: z.array(z.object({ signature: z.string(), sources: z.array(z.string()) })),
  checkedAgainstAbi: z.boolean(),
  sourcesAsked: z.array(z.string()),
  sourcesUnreachable: z.array(z.string()),
  note: z.string(),
  provenance: ProvenanceOut.nullable(),
});

const decodeFunction = defineCapability({
  id: 'contract.decode_function',
  name: 'Say which function a call refers to',
  description:
    'Identifies the function behind a four-byte selector or a piece of call data. Give the chain and the exact ' +
    'contract address and its verified interface decides between the candidates; without one, every candidate is ' +
    'reported because a selector is not unique. It names the function — it does not decode argument values.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /** Call data or a bare selector. Only the first four bytes are used. */
    callData: Selector,
    chain: ChainName.optional(),
    address: Address.optional(),
  }),
  output: Named,
  modelCallable: true,
  timeoutMs: 30_000,
  async run(input) {
    // Only the selector matters; the rest is arguments this does not decode.
    const selector = input.callData.slice(0, 10).toLowerCase();
    return name('function', selector, input.chain ?? null, input.address ?? null);
  },
});

const decodeEvent = defineCapability({
  id: 'contract.decode_event',
  name: 'Say which event a log refers to',
  description:
    'Identifies the event behind a log topic. Give the chain and the exact contract address and its verified ' +
    'interface decides between the candidates; without one, every candidate is reported. ' +
    'It names the event — it does not decode the logged values.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({
    /** The first topic of a log, which is the hash of the event signature. */
    topic: Topic,
    chain: ChainName.optional(),
    address: Address.optional(),
  }),
  output: Named,
  modelCallable: true,
  timeoutMs: 30_000,
  async run(input) {
    return name('event', input.topic.toLowerCase(), input.chain ?? null, input.address ?? null);
  },
});
