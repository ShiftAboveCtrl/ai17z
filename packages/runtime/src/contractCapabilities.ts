import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  EVM_CHAINS,
  ask,
  familyHealth,
  type ContractQuery,
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
}
