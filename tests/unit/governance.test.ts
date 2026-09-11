import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading governance, and the four ways this could overstate what happened.
 *
 * **By calling signalling an action.** A Snapshot proposal that passed has not
 * moved a token or changed a contract. "The DAO approved the transfer" is a
 * claim this evidence cannot support.
 *
 * **By treating a running count as a result.** `scores_state` says whether
 * voting has finished. Reporting a live tally as an outcome is wrong in the
 * direction somebody acts on.
 *
 * **By reporting power as if it were people.** "84% in favour" can be four
 * addresses.
 *
 * **By naming the wrong option.** A vote's `choice` is a one-based index into
 * the proposal's choices. Off by one puts somebody on the opposite side.
 */

let reply: { status?: number; body: string } = { body: '{}' };
let sent: { query: string; variables: Record<string, unknown> }[] = [];

vi.mock('undici', () => ({
  Agent: class {
    async close() {}
  },
  async fetch(_input: unknown, init: { body?: string }) {
    sent.push(JSON.parse(init.body ?? '{}'));
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  },
}));

const { registerGovernanceUpstreams, resetBreakerForTest, resetCacheForTest, resetLimiterForTest, resetUpstreamsForTest } =
  await import('@xbam/upstream');
const { registerGovernanceCapabilities } = await import('@xbam/runtime');
const { getCapability, resetCapabilitiesForTest } = await import('@xbam/tools');

const PROPOSAL = '0x943e585d1a4996525c5c7d229401d604ea56fe08c2c9c615c44f048ba42487b7';

function context() {
  return {
    agentId: 'agent-1',
    jobId: null,
    accountId: null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => context().logger } as never,
    signal: new AbortController().signal,
  };
}

async function run<T>(id: string, input: unknown): Promise<T> {
  const capability = getCapability(id)!;
  return capability.run(capability.input.parse(input) as never, context()) as Promise<T>;
}

/** Answers whichever operation the document asks for. */
function answering(data: Record<string, unknown>) {
  return { body: JSON.stringify({ data }) };
}

beforeEach(() => {
  resetUpstreamsForTest();
  resetBreakerForTest();
  resetCacheForTest();
  resetLimiterForTest();
  resetCapabilitiesForTest();
  registerGovernanceUpstreams();
  registerGovernanceCapabilities();
  sent = [];
  reply = { body: '{}' };
});
afterEach(() => {
  resetUpstreamsForTest();
  resetCapabilitiesForTest();
});

describe('the query is built with variables', () => {
  it('never pastes the id into the document', async () => {
    reply = answering({ space: { id: 'ens.eth', name: 'ENS', strategies: [] } });
    // A value shaped like an attempt to break out of the document.
    await run('governance.read_space', { space: 'ens.eth' }).catch(() => null);

    const document = sent[0]!.query;
    expect(document).toContain('$id');
    expect(document).not.toContain('ens.eth');
    expect(sent[0]!.variables).toMatchObject({ id: 'ens.eth' });
  });

  it('refuses a space id that is a project name or contains quotes', () => {
    const capability = getCapability('governance.read_space')!;
    expect(capability.input.safeParse({ space: 'ens.eth' }).success).toBe(true);
    expect(capability.input.safeParse({ space: '"] } } #' }).success).toBe(false);
    expect(capability.input.safeParse({ space: 'Uniswap DAO' }).success).toBe(false);
  });
});

describe('a space that does not exist', () => {
  it('is reported as missing rather than approximated to a similar one', async () => {
    reply = answering({ space: null });
    const answer = await run<{ exists: boolean; caveats: string[] }>('governance.read_space', {
      space: 'not-a-real-space.eth',
    });
    expect(answer.exists).toBe(false);
    expect(answer.caveats.join(' ')).toMatch(/no Snapshot space with the id/i);
  });

  it('says a space id is not proof of who runs it', async () => {
    reply = answering({ space: { id: 'ens.eth', name: 'ENS', strategies: [{ name: 'erc20-votes' }] } });
    const answer = await run<{ caveats: string[]; strategies: string[] }>('governance.read_space', {
      space: 'ens.eth',
    });
    expect(answer.caveats.join(' ')).toMatch(/anyone can create a Snapshot space/i);
    expect(answer.strategies).toEqual(['erc20-votes']);
  });
});

describe('a proposal', () => {
  const closed = {
    id: PROPOSAL,
    title: '[7.1] [Social] SPP3: Marketplace RFP',
    state: 'closed',
    start: 1783988115,
    end: 1784420115,
    choices: ['For', 'Against', 'Abstain'],
    scores: [1191365.5341689042, 156420.0868523988, 66836.54296485189],
    scores_total: 1414622.1639861548,
    scores_state: 'final',
    votes: 67,
    quorum: 0,
    space: { id: 'ens.eth', name: 'ENS' },
  };

  it('pairs each choice with its own score', async () => {
    reply = answering({ proposal: closed });
    const answer = await run<{ outcomes: { choice: string; share: string }[]; leading: string | null }>(
      'governance.read_proposal',
      { proposal: PROPOSAL },
    );
    expect(answer.outcomes.map((o) => o.choice)).toEqual(['For', 'Against', 'Abstain']);
    expect(answer.outcomes[0]!.share).toBe('84.22%');
    expect(answer.leading).toBe('For');
  });

  it('says signalling is not execution, every time', async () => {
    reply = answering({ proposal: closed });
    const answer = await run<{ caveats: string[] }>('governance.read_proposal', { proposal: PROPOSAL });
    expect(answer.caveats.join(' ')).toMatch(/not by itself an onchain action/i);
  });

  it('says which block the voting power was measured at', async () => {
    // Snapshot weighs each voter by what they held at this block, not now. A
    // result reported without it invites a reader to check today's balances,
    // find they disagree, and conclude the numbers are wrong.
    reply = answering({ proposal: { ...closed, snapshot: 25527225 } });
    const answer = await run<{ measuredAtBlock: number | null; caveats: string[] }>('governance.read_proposal', {
      proposal: PROPOSAL,
    });
    expect(answer.measuredAtBlock).toBe(25527225);
    expect(answer.caveats.join(' ')).toMatch(/measured at block 25527225/i);
    expect(answer.caveats.join(' ')).toMatch(/rather than now/i);
  });

  it('says power is not headcount, and gives both', async () => {
    reply = answering({ proposal: closed });
    const answer = await run<{ totalVotingPower: number | null; voters: number | null; caveats: string[] }>(
      'governance.read_proposal',
      { proposal: PROPOSAL },
    );
    expect(answer.voters).toBe(67);
    expect(answer.totalVotingPower).toBeCloseTo(1414622.16, 1);
    expect(answer.caveats.join(' ')).toMatch(/voting power, not headcount/i);
  });

  it('will not present a running count as a result', async () => {
    reply = answering({ proposal: { ...closed, state: 'active', scores_state: 'pending' } });
    const answer = await run<{ resultIsFinal: boolean; caveats: string[] }>('governance.read_proposal', {
      proposal: PROPOSAL,
    });
    expect(answer.resultIsFinal).toBe(false);
    expect(answer.caveats.join(' ')).toMatch(/running count rather than a result/i);
  });

  it('does not claim a quorum was met when none was set', async () => {
    reply = answering({ proposal: closed });
    const answer = await run<{ quorum: number | null; quorumMet: boolean | null; caveats: string[] }>(
      'governance.read_proposal',
      { proposal: PROPOSAL },
    );
    // quorum 0 means none, which is not the same as one that was cleared.
    expect(answer.quorum).toBe(0);
    expect(answer.quorumMet).toBeNull();
    expect(answer.caveats.join(' ')).toMatch(/sets no quorum/i);
  });

  it('reports quorum when there is one', async () => {
    reply = answering({ proposal: { ...closed, quorum: 1000000 } });
    const answer = await run<{ quorumMet: boolean | null }>('governance.read_proposal', { proposal: PROPOSAL });
    expect(answer.quorumMet).toBe(true);

    resetCacheForTest();
    reply = answering({ proposal: { ...closed, quorum: 99000000 } });
    const short = await run<{ quorumMet: boolean | null }>('governance.read_proposal', { proposal: PROPOSAL });
    expect(short.quorumMet).toBe(false);
  });

  it('refuses something that is not a proposal id', () => {
    const capability = getCapability('governance.read_proposal')!;
    expect(capability.input.safeParse({ proposal: 'the marketplace one' }).success).toBe(false);
    expect(capability.input.safeParse({ proposal: PROPOSAL }).success).toBe(true);
  });
});

describe('who decided it', () => {
  it('names the option each voter chose, counting from one', async () => {
    // Snapshot numbers choices from 1. Reading `choice` as a zero-based index
    // puts every voter on the wrong side.
    reply = {
      body: JSON.stringify({
        data: {
          proposal: { choices: ['For', 'Against', 'Abstain'], scores_total: 1000, votes: 3 },
          votes: [
            { voter: '0xaaa', vp: 600, choice: 1, created: 1784182264, reason: '' },
            { voter: '0xbbb', vp: 300, choice: 2, created: 1784182264, reason: 'Fire Eyes has voted against.' },
          ],
        },
      }),
    };
    const answer = await run<{ votes: { voter: string; choice: string; reason: string | null }[] }>(
      'governance.read_votes',
      { proposal: PROPOSAL },
    );
    expect(answer.votes[0]!.choice).toBe('For');
    expect(answer.votes[1]!.choice).toBe('Against');
    expect(answer.votes[1]!.reason).toBe('Fire Eyes has voted against.');
  });

  it('says how concentrated the power was, which is the point of it', async () => {
    reply = {
      body: JSON.stringify({
        data: {
          proposal: { choices: ['For', 'Against'], scores_total: 1000, votes: 67 },
          votes: [
            { voter: '0xaaa', vp: 600, choice: 1, created: 1, reason: '' },
            { voter: '0xbbb', vp: 250, choice: 1, created: 1, reason: '' },
          ],
        },
      }),
    };
    const answer = await run<{ concentration: string[] }>('governance.read_votes', { proposal: PROPOSAL });
    expect(answer.concentration.join(' ')).toMatch(/largest single voter cast 60\.0%/i);
    expect(answer.concentration.join(' ')).toMatch(/85\.0%/);
    expect(answer.concentration.join(' ')).toMatch(/out of 67 that voted/i);
  });

  it('does not invent an option a proposal does not have', async () => {
    reply = {
      body: JSON.stringify({
        data: {
          proposal: { choices: ['For', 'Against'], scores_total: 100, votes: 1 },
          votes: [{ voter: '0xaaa', vp: 100, choice: 9, created: 1, reason: '' }],
        },
      }),
    };
    const answer = await run<{ votes: { choice: string }[] }>('governance.read_votes', { proposal: PROPOSAL });
    expect(answer.votes[0]!.choice).toMatch(/does not list/i);
  });
});

describe('when the source misbehaves', () => {
  it('treats a GraphQL error as a failure even though the status is 200', async () => {
    // The trap: GraphQL answers 200 with an errors array, so anything checking
    // only the status code reads a failure as a success.
    reply = { status: 200, body: JSON.stringify({ errors: [{ message: 'Cannot query field' }], data: null }) };
    await expect(run('governance.read_space', { space: 'ens.eth' })).rejects.toThrow();
  });

  it('refuses a partial answer, which is the case that would otherwise be believed', async () => {
    // `data` present *and* `errors` present is what a partial GraphQL failure
    // looks like, and it is the dangerous one: with the errors ignored this
    // returns "there is no such space" -- a confident wrong answer rather than
    // a failure. The previous test alone did not catch that, because a null
    // `data` trips the next guard anyway.
    reply = {
      status: 200,
      body: JSON.stringify({ data: { space: null }, errors: [{ message: 'upstream timeout resolving space' }] }),
    };
    await expect(run('governance.read_space', { space: 'ens.eth' })).rejects.toThrow(/upstream timeout/i);
  });

  it('reports a 429', async () => {
    reply = { status: 429, body: 'slow down' };
    await expect(run('governance.read_space', { space: 'ens.eth' })).rejects.toThrow();
  });

  it('reports a body that is not JSON', async () => {
    reply = { body: '<html>gateway</html>' };
    await expect(run('governance.read_space', { space: 'ens.eth' })).rejects.toThrow();
  });
});

describe('what it will not do', () => {
  it('has no capability that casts or delegates a vote', async () => {
    const { listCapabilities } = await import('@xbam/tools');
    const governance = listCapabilities().filter((capability) => capability.id.startsWith('governance.'));
    expect(governance.length).toBeGreaterThan(0);
    for (const capability of governance) expect(capability.effect).toBe('READ');
    expect(JSON.stringify(governance.map((c) => [c.id, c.name, c.description]))).not.toMatch(
      /cast a vote|delegate|sign/i,
    );
  });

  it('says plainly that onchain governance is not covered', async () => {
    reply = answering({ space: { id: 'ens.eth', name: 'ENS', strategies: [] } });
    const answer = await run<{ covers: string }>('governance.health', {});
    expect(answer.covers).toMatch(/onchain governance/i);
    expect(answer.covers).toMatch(/api key/i);
  });
});
