import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  EVM_CHAINS,
  ask,
  familyHealth,
  type AddressRisk,
  type ContractSecurity,
  type EvmChain,
  type Reported,
  type TokenRiskQuery,
  type TradeSimulation,
} from '@xbam/upstream';

/**
 * What is observable about a token contract, with who observed it.
 *
 * ### There is no verdict here, deliberately
 *
 * "Safe" and "scam" are the two words this must never produce. A security
 * service reports attributes -- a tax figure, a mintable flag, how much the
 * creator still holds, whether a simulated buy could be sold again -- and the
 * useful, defensible thing is the attribute with its source attached. "GoPlus
 * reports a 15% sell tax and that ownership can be taken back" is evidence
 * somebody can act on. "This token is a scam" is a claim AI17Z is not in a
 * position to make, cannot support, and would be believed anyway.
 *
 * So the output is observations, and the things nobody checked, and nothing
 * else. Whether that adds up to a reason to stay away is the reader's judgement
 * and the persona's business.
 *
 * ### What was not checked is part of the answer
 *
 * The services return an empty string for a field they did not look at. Reading
 * that as "no" would turn silence into reassurance, which is the worst
 * direction for this error. Unchecked fields are listed, by name, so an agent
 * saying "nothing concerning was reported" is saying something true rather than
 * something lucky.
 */

const ChainName = z.enum(Object.keys(EVM_CHAINS) as [EvmChain, ...EvmChain[]]);

const Address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'A token address is 0x followed by 40 hexadecimal characters.');

const AnyAddress = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'An address is 0x followed by 40 hexadecimal characters.');

const Observation = z.object({
  /** What was observed, in a few words. */
  what: z.string(),
  /** The reading itself, as the source gave it. */
  detail: z.string(),
  /** Which service said it. Every claim is attributable. */
  source: z.string(),
  /**
   * Whether the source itself treated this as something to flag.
   *
   * Not AI17Z's opinion -- a report of theirs. `FACT` is a neutral reading like
   * a holder count; `FLAG` is one the service raised.
   */
  kind: z.enum(['FACT', 'FLAG']),
});

function pct(value: number): string {
  return `${(value * 100).toFixed(2).replace(/\.00$/, '')}%`;
}

/** Adds an observation when the source actually reported something. */
function ifKnown<T>(
  reported: Reported<T>,
  source: string,
  what: string,
  render: (value: T) => { detail: string; kind: 'FACT' | 'FLAG' } | null,
  into: z.infer<typeof Observation>[],
  unchecked: string[],
): void {
  if (!reported.known) {
    unchecked.push(`${what} (${source})`);
    return;
  }
  const rendered = render(reported.value);
  if (rendered) into.push({ what, detail: rendered.detail, source, kind: rendered.kind });
}

async function addressReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth('address_risk');
  return health.some((entry) => entry.health.state === 'READY')
    ? { status: 'AVAILABLE' }
    : { status: 'UNAVAILABLE', why: 'No source of address reports is answering.' };
}

async function riskReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  for (const family of ['token_security', 'token_tradeable']) {
    const health = await familyHealth(family);
    if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  }
  return { status: 'UNAVAILABLE', why: 'No token security source is answering.' };
}

const inspectRisk = defineCapability({
  id: 'token.inspect_risk',
  name: 'What security services observe about a token',
  description:
    'Attributes two independent security services report about a token contract: taxes, whether it can be minted ' +
    'or paused, how much the creator holds, and whether a simulated trade could be sold again. ' +
    'Returns observations with their source and what was not checked. It does not judge a token safe or unsafe.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: Address }),
  output: z.object({
    chain: z.string(),
    chainId: z.number(),
    address: z.string(),
    observations: z.array(Observation),
    /** Named, so "nothing concerning" can be told apart from "nobody looked". */
    notChecked: z.array(z.string()),
    /** What these sources cannot tell anybody, said every time. */
    limitations: z.array(z.string()),
    sourcesAnswering: z.number(),
  }),
  modelCallable: true,
  timeoutMs: 40_000,
  readiness: () => riskReadable(),
  async run(input) {
    const chainId = EVM_CHAINS[input.chain];
    const query: TokenRiskQuery = { chainId, address: input.address };
    const observations: z.infer<typeof Observation>[] = [];
    const notChecked: string[] = [];
    let answering = 0;

    // Asked independently. One failing is a smaller answer, not no answer, and
    // the count of sources that spoke goes out with it.
    const security = await ask<TokenRiskQuery, ContractSecurity>('token_security', query).catch(() => null);
    if (security?.value) {
      answering += 1;
      const value = security.value;
      const from = 'contract analysis';
      if (!value.found) {
        observations.push({
          what: 'Never analysed',
          detail: 'This service has no record of this contract, which is itself worth knowing about a new token.',
          source: from,
          kind: 'FLAG',
        });
      } else {
        ifKnown(value.buyTax, from, 'Buy tax', (v) => ({ detail: pct(v), kind: v > 0.1 ? 'FLAG' : 'FACT' }), observations, notChecked);
        ifKnown(value.sellTax, from, 'Sell tax', (v) => ({ detail: pct(v), kind: v > 0.1 ? 'FLAG' : 'FACT' }), observations, notChecked);
        ifKnown(value.isHoneypot, from, 'Cannot be sold', (v) => (v ? { detail: 'Reported as a honeypot.', kind: 'FLAG' } : null), observations, notChecked);
        ifKnown(value.isMintable, from, 'More can be minted', (v) => (v ? { detail: 'Supply can be increased.', kind: 'FLAG' } : null), observations, notChecked);
        ifKnown(value.transferPausable, from, 'Transfers can be paused', (v) => (v ? { detail: 'Someone can stop transfers.', kind: 'FLAG' } : null), observations, notChecked);
        ifKnown(value.canTakeBackOwnership, from, 'Ownership can be reclaimed', (v) => (v ? { detail: 'Renounced ownership can be taken back.', kind: 'FLAG' } : null), observations, notChecked);
        ifKnown(value.hiddenOwner, from, 'Hidden owner', (v) => (v ? { detail: 'An owner not visible in the obvious place.', kind: 'FLAG' } : null), observations, notChecked);
        ifKnown(value.selfDestruct, from, 'Can self-destruct', (v) => (v ? { detail: 'The contract can destroy itself.', kind: 'FLAG' } : null), observations, notChecked);
        ifKnown(value.isOpenSource, from, 'Source published', (v) => ({ detail: v ? 'Yes.' : 'No published source.', kind: v ? 'FACT' : 'FLAG' }), observations, notChecked);
        ifKnown(value.holderCount, from, 'Holders', (v) => ({ detail: v.toLocaleString(), kind: 'FACT' }), observations, notChecked);
        ifKnown(value.creatorPercent, from, 'Held by the creator', (v) => ({ detail: pct(v), kind: v > 0.2 ? 'FLAG' : 'FACT' }), observations, notChecked);
        ifKnown(value.ownerPercent, from, 'Held by the owner', (v) => ({ detail: pct(v), kind: v > 0.2 ? 'FLAG' : 'FACT' }), observations, notChecked);
      }
    }

    const simulation = await ask<TokenRiskQuery, TradeSimulation>('token_tradeable', query).catch(() => null);
    if (simulation?.value) {
      answering += 1;
      const value = simulation.value;
      const from = 'trade simulation';
      if (!value.simulated) {
        notChecked.push(`Whether it can be sold (${from})`);
        if (value.note) observations.push({ what: 'Simulation', detail: value.note, source: from, kind: 'FACT' });
      } else {
        ifKnown(value.isHoneypot, from, 'Could be sold again', (v) => ({ detail: v ? 'A simulated buy could not be sold.' : 'A simulated buy could be sold.', kind: v ? 'FLAG' : 'FACT' }), observations, notChecked);
        ifKnown(value.buyTax, from, 'Buy tax, simulated', (v) => ({ detail: pct(v), kind: v > 0.1 ? 'FLAG' : 'FACT' }), observations, notChecked);
        ifKnown(value.sellTax, from, 'Sell tax, simulated', (v) => ({ detail: pct(v), kind: v > 0.1 ? 'FLAG' : 'FACT' }), observations, notChecked);
      }
    }

    return {
      chain: input.chain,
      chainId,
      address: input.address,
      observations,
      notChecked,
      // Said every time, not only when something looks wrong. These are the
      // boundaries of what any of this can support, and an agent that forgets
      // them will overstate what it found.
      limitations: [
        'These are attributes of a contract, not a judgement about a token or the people behind it.',
        'A contract with nothing flagged can still lose money, and one with flags can be entirely ordinary.',
        answering < 2
          ? 'Only one source answered, so nothing here has been corroborated.'
          : 'Two independent sources answered; where they overlap, both readings are shown.',
      ],
      sourcesAnswering: answering,
    };
  },
});

/**
 * The labels this source can carry, and the words to report each one in.
 *
 * Written out rather than derived from the field names because the field names
 * are the service's and some of them are accusations. `stealing_attack` becomes
 * "Recorded in a theft", which says the same thing without AI17Z asserting it
 * in its own voice -- the claim belongs to whoever is named in `dataSource`.
 */
const ADDRESS_LABELS: { key: keyof AddressRisk; what: string; detail: string }[] = [
  { key: 'sanctioned', what: 'Sanctions list', detail: 'Recorded as appearing on a sanctions list.' },
  { key: 'stealingAttack', what: 'Theft', detail: 'Recorded in connection with a theft.' },
  { key: 'phishingActivities', what: 'Phishing', detail: 'Recorded in connection with phishing.' },
  { key: 'blackmailActivities', what: 'Blackmail', detail: 'Recorded in connection with blackmail.' },
  { key: 'darkwebTransactions', what: 'Dark web', detail: 'Recorded in dark web transactions.' },
  { key: 'cybercrime', what: 'Cybercrime', detail: 'Recorded in connection with cybercrime.' },
  { key: 'moneyLaundering', what: 'Money laundering', detail: 'Recorded in connection with money laundering.' },
  { key: 'financialCrime', what: 'Financial crime', detail: 'Recorded in connection with financial crime.' },
  { key: 'maliciousMiningActivities', what: 'Malicious mining', detail: 'Recorded in connection with malicious mining.' },
  { key: 'honeypotRelatedAddress', what: 'Honeypot tokens', detail: 'Recorded as connected to honeypot tokens.' },
  { key: 'fakeKyc', what: 'Fake KYC', detail: 'Recorded in connection with fake identity verification.' },
  { key: 'fakeToken', what: 'Counterfeit token', detail: 'Recorded as a counterfeit of a mainstream asset.' },
  { key: 'fakeStandardInterface', what: 'Fake interface', detail: 'Claims a standard interface it does not implement.' },
  { key: 'gasAbuse', what: 'Gas abuse', detail: 'Recorded as abusing gas fees.' },
  { key: 'mixer', what: 'Mixer', detail: 'Recorded as a coin mixer.' },
  {
    key: 'blacklistDoubt',
    what: 'Suspected',
    detail: 'Suspected of malicious behaviour, which is weaker than the other entries here and is the source hedging.',
  },
];

/**
 * Said on every answer where nothing matched, and it is the important half.
 *
 * Probed in September 2026: the Uniswap V2 router -- a contract every security
 * service has looked at -- comes back with every field nought and no source at
 * all, exactly like an address that has never been used. There is no field that
 * distinguishes "we checked and it is fine" from "it is not in our lists",
 * because the service only speaks when it has something to say. An agent
 * allowed to read that silence as a clean bill will eventually reassure
 * somebody about an address that is about to take their money.
 */
const NO_MATCH =
  'This address does not appear in the known-malicious lists this source holds. ' +
  'That is not the same as it having been checked and found safe: the source only reports addresses it has an ' +
  'entry for, and a new or unreported address looks exactly like a clean one here.';

const addressRisk = defineCapability({
  id: 'address.risk_evidence',
  name: 'Whether an address appears in known-malicious lists',
  description:
    'Checks one address against databases of addresses recorded in sanctions listings, thefts, phishing and ' +
    'similar, and reports what is recorded with who recorded it. A negative result means the address is not in ' +
    'those lists, which is explicitly not a finding that it is safe. It never judges an address safe or unsafe.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ chain: ChainName, address: AnyAddress }),
  output: z.object({
    chain: z.string(),
    address: z.string(),
    /** False when nothing is recorded, which is the common case and not a clean bill. */
    matched: z.boolean(),
    observations: z.array(Observation),
    /** Who the source credits, when it credits anybody. */
    recordedBy: z.string().nullable(),
    /** Whether the address holds code, which is a fact about it rather than a mark against it. */
    isContract: z.boolean().nullable(),
    /** Said every answer, matched or not. */
    limitations: z.array(z.string()),
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => addressReadable(),
  async run(input) {
    const chainId = EVM_CHAINS[input.chain];
    const answer = await ask<TokenRiskQuery, AddressRisk>('address_risk', { chainId, address: input.address });
    const value = answer.value;
    // Named for the reader, not by its id: "GoPlus, citing SlowMist" is the
    // attribution somebody can weigh.
    const source = value.dataSource ? `${answer.provenance.upstreamId} (citing ${value.dataSource})` : answer.provenance.upstreamId;

    const observations: z.infer<typeof Observation>[] = [];
    for (const label of ADDRESS_LABELS) {
      const reported = value[label.key] as Reported<boolean>;
      // Only a positive is an observation. A nought here is the absence of an
      // entry, and rendering it as "not sanctioned" would state a clearance no
      // source has given.
      if (reported.known && reported.value) {
        observations.push({ what: label.what, detail: label.detail, source, kind: 'FLAG' });
      }
    }

    const created = value.maliciousContractsCreated;
    if (created.known && created.value > 0) {
      observations.push({
        what: 'Malicious contracts deployed',
        detail: `${created.value} recorded.`,
        source,
        kind: 'FLAG',
      });
    }

    const limitations = [
      'This is a database of addresses somebody has reported, not an assessment of the address.',
      'An address can be used by more than one person, and an exchange address is shared by everybody who uses it.',
      'Nothing here is a judgement that an address is safe or unsafe.',
    ];
    if (!value.matched) limitations.unshift(NO_MATCH);

    return {
      chain: input.chain,
      address: input.address,
      matched: value.matched,
      observations,
      recordedBy: value.dataSource,
      isContract: value.isContract.known ? value.isContract.value : null,
      limitations,
    };
  },
});

export function registerTokenRiskCapabilities(): void {
  registerCapability(inspectRisk);
  registerCapability(addressRisk);
}
