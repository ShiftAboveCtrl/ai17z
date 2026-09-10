import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import {
  EVM_CHAINS,
  ask,
  familyHealth,
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

export function registerTokenRiskCapabilities(): void {
  registerCapability(inspectRisk);
}
