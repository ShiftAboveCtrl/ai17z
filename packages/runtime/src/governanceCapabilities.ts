import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';
import { GOVERNANCE_FAMILY, ask, familyHealth, type GovernanceQuery, type GovernanceResult, type Provenance } from '@xbam/upstream';

/**
 * What an agent may ask about DAO governance.
 *
 * ### The sentence that belongs on every proposal
 *
 * **Snapshot is signalling, not execution.** A proposal that passed there has
 * not moved a token or changed a contract; it records what token holders said
 * when asked. Onchain governance is a separate thing, and the source that reads
 * it now wants a key. An agent that says "the DAO approved the treasury
 * transfer" on this evidence has stated something it cannot support -- so the
 * limitation is in the output, not left to the prompt.
 *
 * ### A space id is not a verified identity
 *
 * Anybody can create a Snapshot space and call it anything. There is no
 * registry saying which one is really a given project, so nothing here resolves
 * a name to a space: the exact id is required, and a space that does not exist
 * is reported as not existing rather than approximated to a similar one. This
 * is the same rule as a token contract address, for the same reason -- a
 * convincing lookalike is the whole attack.
 *
 * ### Voting power is not people
 *
 * "84% in favour" can mean four addresses. Both numbers travel together --
 * how much power voted and how many addresses cast it -- and the concentration
 * of the largest holders is reported as an observation, because it is the thing
 * that decides whether a result means what it appears to mean.
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
 * A space id, required exactly.
 *
 * Shaped like `ens.eth` or an address. Deliberately not a search: see the note
 * above about lookalikes.
 */
const SpaceId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    'A Snapshot space id looks like "ens.eth". This needs the exact id rather than a project name.',
  );

const ProposalId = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'A Snapshot proposal id is 0x followed by 64 hexadecimal characters.');

async function readGovernance(
  operation: GovernanceQuery['operation'],
  id = '',
  first = 10,
): Promise<{ value: unknown; provenance: z.infer<typeof ProvenanceOut> }> {
  const answer = await ask<GovernanceQuery, GovernanceResult>(GOVERNANCE_FAMILY, {
    operation,
    id,
    first,
    state: 'all',
  });
  return { value: answer.value.value, provenance: reported(answer.provenance) };
}

async function governanceReadable(): Promise<{ status: 'AVAILABLE' | 'UNAVAILABLE'; why?: string }> {
  const health = await familyHealth(GOVERNANCE_FAMILY);
  if (health.length === 0) return { status: 'UNAVAILABLE', why: 'No governance source is configured.' };
  if (health.some((entry) => entry.health.state === 'READY')) return { status: 'AVAILABLE' };
  return { status: 'UNAVAILABLE', why: 'The governance source is not answering.' };
}

/** The limitation that goes on everything here. */
const SIGNALLING_NOTE =
  'Snapshot records offchain signalling. A proposal passing here is what token holders said when asked; ' +
  'it is not by itself an onchain action, and nothing has necessarily been executed.';

const Outcome = z.object({
  choice: z.string(),
  /** Voting power, as the source reported it. */
  score: z.number(),
  share: z.string(),
});

/** Choices and scores are parallel arrays, and the pairing is the whole answer. */
function outcomes(choices: unknown, scores: unknown, total: unknown): z.infer<typeof Outcome>[] {
  if (!Array.isArray(choices) || !Array.isArray(scores)) return [];
  const sum = typeof total === 'number' && total > 0 ? total : 0;
  return choices.map((choice, index) => {
    const score = typeof scores[index] === 'number' ? (scores[index] as number) : 0;
    return {
      choice: typeof choice === 'string' ? choice : `Option ${index + 1}`,
      score,
      share: sum > 0 ? `${((score / sum) * 100).toFixed(2)}%` : 'unknown',
    };
  });
}

const health = defineCapability({
  id: 'governance.health',
  name: 'Say whether DAO governance can be read right now',
  description: 'Whether this installation can read DAO governance proposals, and which sources are answering.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({}),
  output: z.object({
    readable: z.boolean(),
    sources: z.array(z.object({ id: z.string(), host: z.string(), state: z.string(), why: z.string().nullable() })),
    covers: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  async run() {
    const entries = await familyHealth(GOVERNANCE_FAMILY);
    let readable = false;
    try {
      const probe = await readGovernance('space', 'ens.eth');
      readable = probe.value !== undefined;
    } catch {
      readable = false;
    }
    return {
      readable,
      sources: entries.map((entry) => ({
        id: entry.upstream.id,
        host: entry.upstream.origin,
        state: entry.health.state,
        why: entry.health.why || null,
      })),
      covers:
        'Offchain signalling votes only. Onchain governance — proposals that actually execute — is not readable ' +
        'here, because the sources for it now require an API key.',
    };
  },
});

const space = defineCapability({
  id: 'governance.read_space',
  name: 'Read a DAO’s governance space',
  description:
    'What a Snapshot space is: its name, network, how many follow it, how many proposals it has had, and how ' +
    'voting power is calculated. Needs the exact space id, like "ens.eth" — it will not search by project name.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ space: SpaceId }),
  output: z.object({
    id: z.string(),
    exists: z.boolean(),
    name: z.string().nullable(),
    about: z.string().nullable(),
    network: z.string().nullable(),
    symbol: z.string().nullable(),
    followers: z.number().nullable(),
    proposals: z.number().nullable(),
    admins: z.number().nullable(),
    /** How voting power is computed, which is what the votes actually mean. */
    strategies: z.array(z.string()),
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: () => governanceReadable(),
  async run(input) {
    const read = await readGovernance('space', input.space);
    const row = read.value as Record<string, unknown> | null;

    if (!row) {
      return {
        id: input.space,
        exists: false,
        name: null,
        about: null,
        network: null,
        symbol: null,
        followers: null,
        proposals: null,
        admins: null,
        strategies: [],
        caveats: [`There is no Snapshot space with the id "${input.space}".`],
        provenance: read.provenance,
      };
    }

    const strategies = Array.isArray(row.strategies)
      ? row.strategies
          .map((entry) => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : null))
          .filter((name): name is string => typeof name === 'string')
      : [];

    return {
      id: typeof row.id === 'string' ? row.id : input.space,
      exists: true,
      name: typeof row.name === 'string' ? row.name : null,
      about: typeof row.about === 'string' && row.about ? row.about : null,
      network: typeof row.network === 'string' ? row.network : null,
      symbol: typeof row.symbol === 'string' && row.symbol ? row.symbol : null,
      followers: typeof row.followersCount === 'number' ? row.followersCount : null,
      proposals: typeof row.proposalsCount === 'number' ? row.proposalsCount : null,
      admins: Array.isArray(row.admins) ? row.admins.length : null,
      strategies,
      caveats: [
        SIGNALLING_NOTE,
        'Anyone can create a Snapshot space with any name, and there is no registry saying which one really ' +
          'belongs to a project. This is the space with that exact id, which is not the same as saying it is official.',
      ],
      provenance: read.provenance,
    };
  },
});

const proposals = defineCapability({
  id: 'governance.list_proposals',
  name: 'List a DAO’s recent proposals',
  description:
    'The most recent governance proposals in one Snapshot space, newest first, with whether each is open, ' +
    'upcoming or finished. Needs the exact space id.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ space: SpaceId, limit: z.number().int().min(1).max(25).default(10) }),
  output: z.object({
    space: z.string(),
    proposals: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        state: z.string(),
        opensAt: z.string().nullable(),
        closesAt: z.string().nullable(),
        voters: z.number().nullable(),
        /** False while a vote is still running, so a running count is not a result. */
        resultIsFinal: z.boolean(),
        link: z.string().nullable(),
      }),
    ),
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => governanceReadable(),
  async run(input) {
    const read = await readGovernance('proposals', input.space, input.limit);
    const rows = Array.isArray(read.value) ? read.value : [];

    return {
      space: input.space,
      proposals: rows
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
        .map((row) => ({
          id: typeof row.id === 'string' ? row.id : '',
          title: typeof row.title === 'string' ? row.title : '(untitled)',
          state: typeof row.state === 'string' ? row.state : 'unknown',
          opensAt: typeof row.start === 'number' ? new Date(row.start * 1000).toISOString() : null,
          closesAt: typeof row.end === 'number' ? new Date(row.end * 1000).toISOString() : null,
          voters: typeof row.votes === 'number' ? row.votes : null,
          resultIsFinal: row.scores_state === 'final',
          link: typeof row.link === 'string' ? row.link : null,
        })),
      caveats: [SIGNALLING_NOTE],
      provenance: read.provenance,
    };
  },
});

const proposal = defineCapability({
  id: 'governance.read_proposal',
  name: 'Read one governance proposal',
  description:
    'One proposal in full: what it asked, how each option did, how much voting power took part, how many ' +
    'addresses cast it, and whether the result is final. Needs the exact proposal id.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ proposal: ProposalId }),
  output: z.object({
    id: z.string(),
    exists: z.boolean(),
    title: z.string().nullable(),
    space: z.string().nullable(),
    state: z.string().nullable(),
    opensAt: z.string().nullable(),
    closesAt: z.string().nullable(),
    /**
     * The block voting power was measured at.
     *
     * Not decoration. Snapshot weighs each voter by what they held at this
     * block, not by what they hold now -- so "these addresses control the
     * outcome" is a statement about that moment, and tokens bought or sold
     * since do not count. Reporting the result without it invites a reader to
     * check today's balances and find they disagree.
     */
    measuredAtBlock: z.number().nullable(),
    outcomes: z.array(Outcome),
    /** The option with the most power, which is not the same as "it passed". */
    leading: z.string().nullable(),
    totalVotingPower: z.number().nullable(),
    /** Addresses, as distinct from power. Both, always. */
    voters: z.number().nullable(),
    quorum: z.number().nullable(),
    quorumMet: z.boolean().nullable(),
    resultIsFinal: z.boolean(),
    link: z.string().nullable(),
    caveats: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => governanceReadable(),
  async run(input) {
    const read = await readGovernance('proposal', input.proposal);
    const row = read.value as Record<string, unknown> | null;

    if (!row) {
      return {
        id: input.proposal,
        exists: false,
        title: null,
        space: null,
        state: null,
        opensAt: null,
        closesAt: null,
        measuredAtBlock: null,
        outcomes: [],
        leading: null,
        totalVotingPower: null,
        voters: null,
        quorum: null,
        quorumMet: null,
        resultIsFinal: false,
        link: null,
        caveats: ['There is no proposal with that id.'],
        provenance: read.provenance,
      };
    }

    const total = typeof row.scores_total === 'number' ? row.scores_total : null;
    const ranked = outcomes(row.choices, row.scores, total);
    const quorum = typeof row.quorum === 'number' ? row.quorum : null;
    const final = row.scores_state === 'final';
    const voters = typeof row.votes === 'number' ? row.votes : null;

    const caveats = [SIGNALLING_NOTE];
    if (!final) {
      caveats.push('Voting is still in progress, so these numbers are a running count rather than a result.');
    }
    if (voters !== null && voters > 0) {
      caveats.push(
        `The totals are voting power, not headcount: ${voters} address${voters === 1 ? '' : 'es'} took part. ` +
          'Ask governance.read_votes to see how concentrated it was.',
      );
    }
    if (row.snapshot) {
      caveats.push(
        `Voting power was measured at block ${String(row.snapshot)}, so it reflects holdings at that moment ` +
          'rather than now.',
      );
    }
    // A quorum of zero is Snapshot's way of saying none was set, which is not
    // the same as one that was met.
    if (quorum === 0) {
      caveats.push('This space sets no quorum, so "quorum met" does not apply to it.');
    }

    return {
      id: typeof row.id === 'string' ? row.id : input.proposal,
      exists: true,
      title: typeof row.title === 'string' ? row.title : null,
      space:
        row.space && typeof row.space === 'object' && typeof (row.space as { id?: unknown }).id === 'string'
          ? ((row.space as { id: string }).id)
          : null,
      state: typeof row.state === 'string' ? row.state : null,
      opensAt: typeof row.start === 'number' ? new Date(row.start * 1000).toISOString() : null,
      closesAt: typeof row.end === 'number' ? new Date(row.end * 1000).toISOString() : null,
      measuredAtBlock: typeof row.snapshot === 'number' ? row.snapshot : Number(row.snapshot) || null,
      outcomes: ranked,
      leading: ranked.length > 0 ? [...ranked].sort((a, b) => b.score - a.score)[0]!.choice : null,
      totalVotingPower: total,
      voters,
      quorum,
      quorumMet: quorum === null || quorum === 0 || total === null ? null : total >= quorum,
      resultIsFinal: final,
      link: typeof row.link === 'string' ? row.link : null,
      caveats,
      provenance: read.provenance,
    };
  },
});

const votes = defineCapability({
  id: 'governance.read_votes',
  name: 'See who decided a governance vote',
  description:
    'The largest voters on one proposal and what each of them chose, with how concentrated the voting power ' +
    'was. Use it to tell a broad result from one a few large holders decided.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: z.object({ proposal: ProposalId, limit: z.number().int().min(1).max(25).default(10) }),
  output: z.object({
    proposal: z.string(),
    votes: z.array(
      z.object({
        voter: z.string(),
        votingPower: z.number(),
        choice: z.string(),
        at: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
    /** The observation this capability exists for. */
    concentration: z.array(z.string()),
    provenance: ProvenanceOut,
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: () => governanceReadable(),
  async run(input) {
    // The choices live on the proposal, and a vote's `choice` is an index into
    // them. Reading the votes without them would report a number nobody can
    // interpret -- and getting the offset wrong would name the wrong option.
    const [proposalRead, votesRead] = await Promise.all([
      readGovernance('proposal', input.proposal),
      readGovernance('votes', input.proposal, input.limit),
    ]);

    const proposalRow = proposalRead.value as Record<string, unknown> | null;
    const choices = Array.isArray(proposalRow?.choices) ? proposalRow.choices : [];
    const total = typeof proposalRow?.scores_total === 'number' ? proposalRow.scores_total : null;
    const voterCount = typeof proposalRow?.votes === 'number' ? proposalRow.votes : null;

    const rows = Array.isArray(votesRead.value) ? votesRead.value : [];
    const votes = rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map((row) => {
        // Snapshot numbers the choices from one, so the index is one less.
        // Off by one here names the wrong option on somebody's vote.
        const index = typeof row.choice === 'number' ? row.choice - 1 : -1;
        const choice = index >= 0 && index < choices.length ? choices[index] : null;
        return {
          voter: typeof row.voter === 'string' ? row.voter : '',
          votingPower: typeof row.vp === 'number' ? row.vp : 0,
          choice: typeof choice === 'string' ? choice : 'an option this proposal does not list',
          at: typeof row.created === 'number' ? new Date(row.created * 1000).toISOString() : null,
          reason: typeof row.reason === 'string' && row.reason.trim() ? row.reason : null,
        };
      });

    const concentration: string[] = [];
    if (total !== null && total > 0 && votes.length > 0) {
      const top = votes[0]!;
      const shown = votes.reduce((sum, vote) => sum + vote.votingPower, 0);
      concentration.push(
        `The largest single voter cast ${((top.votingPower / total) * 100).toFixed(1)}% of all voting power.`,
      );
      concentration.push(
        `These ${votes.length} address${votes.length === 1 ? '' : 'es'} account for ` +
          `${((shown / total) * 100).toFixed(1)}% of it` +
          (voterCount !== null ? `, out of ${voterCount} that voted.` : '.'),
      );
    } else {
      concentration.push('There is not enough information to say how concentrated this vote was.');
    }

    return { proposal: input.proposal, votes, concentration, provenance: votesRead.provenance };
  },
});

export function registerGovernanceCapabilities(): void {
  registerCapability(health);
  registerCapability(space);
  registerCapability(proposals);
  registerCapability(proposal);
  registerCapability(votes);
}
