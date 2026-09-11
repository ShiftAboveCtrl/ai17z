import { z } from 'zod';
import { defineUpstream, type Upstream } from '../contract';
import { perMinute, perSecond } from '../quota';
import { registerUpstream } from '../registry';
import { safeFetch } from '../http';
import { UpstreamFailure, classifyStatus, classifyThrown } from '../failures';
import { parseExactJson } from '../exactNumbers';

/**
 * Reading DAO governance, which mostly means reading Snapshot.
 *
 * ### What was available, and what wants a key now
 *
 * Probed September 2026:
 *
 *   `hub.snapshot.org/graphql` -- answers without a key, and **publishes its
 *     limit in response headers**: `ratelimit-policy: 100;w=60`. A hundred a
 *     minute, stated by the operator, so the window below is marked PUBLISHED
 *     rather than guessed.
 *   `api.tally.xyz` -- 401, "api key required". Onchain governance, and the
 *     thing Snapshot is not, so its absence is a real gap rather than a
 *     preference. Deferred rather than guessed at.
 *   `api.boardroom.info` -- 401.
 *
 * So one member, and the capabilities say what that means rather than implying
 * a second opinion exists.
 *
 * ### The query is built with variables, never by pasting
 *
 * A space id reaches this layer from a model, which got it from a person or
 * from something it read. Interpolating that into a GraphQL document is the
 * same mistake as building SQL by concatenation, and the fix is the same one:
 * the document is a constant and the value is a variable.
 */

export const GOVERNANCE_FAMILY = 'governance';

export const GOVERNANCE_OPERATIONS = ['space', 'proposals', 'proposal', 'votes'] as const;
export type GovernanceOperation = (typeof GOVERNANCE_OPERATIONS)[number];

export const GovernanceQuery = z.object({
  operation: z.enum(GOVERNANCE_OPERATIONS),
  /** A space id like `ens.eth`, or a proposal id. Never a name to search by. */
  id: z.string().max(200).default(''),
  first: z.number().int().min(1).max(50).default(10),
  state: z.enum(['all', 'active', 'pending', 'closed']).default('all'),
});
export type GovernanceQuery = z.infer<typeof GovernanceQuery>;

/**
 * The documents, as constants.
 *
 * Fields were read back from the live schema rather than copied from
 * documentation -- `scores_state` in particular, which is what tells a final
 * result from a running count.
 */
const DOCUMENTS: Record<GovernanceOperation, string> = {
  space: `query Space($id: String!) {
    space(id: $id) {
      id name about network symbol followersCount proposalsCount admins
      voting { delay period quorum type }
      strategies { name }
    }
  }`,
  proposals: `query Proposals($space: String!, $first: Int!) {
    proposals(first: $first, where: { space_in: [$space] }, orderBy: "created", orderDirection: desc) {
      id title state start end choices scores scores_total scores_state votes quorum type author link
    }
  }`,
  proposal: `query Proposal($id: String!) {
    proposal(id: $id) {
      id title body state start end choices scores scores_total scores_state votes quorum type author link snapshot
      space { id name }
    }
  }`,
  votes: `query Votes($id: String!, $first: Int!) {
    votes(first: $first, where: { proposal: $id }, orderBy: "vp", orderDirection: desc) {
      voter vp choice created reason
    }
  }`,
};

function variablesFor(query: GovernanceQuery): Record<string, unknown> {
  switch (query.operation) {
    case 'space':
      return { id: query.id };
    case 'proposals':
      return { space: query.id, first: query.first };
    case 'proposal':
      return { id: query.id };
    case 'votes':
      return { id: query.id, first: query.first };
  }
}

export interface GovernanceResult {
  value: unknown;
}

function snapshot(): Upstream<GovernanceQuery, GovernanceResult> {
  return defineUpstream<GovernanceQuery, GovernanceResult>({
    id: `${GOVERNANCE_FAMILY}.snapshot`,
    family: GOVERNANCE_FAMILY,
    name: 'snapshot',
    description: 'Offchain governance proposals and votes, from Snapshot.',
    origin: 'hub.snapshot.org',
    limit: {
      concurrentPerProcess: 3,
      // The minute window is theirs, read from `ratelimit-policy: 100;w=60`.
      // The per-second one is ours: a hundred a minute permits a burst that
      // would be rude, and pacing is the point of this layer.
      windows: [
        perSecond(3, { scope: 'MACHINE' }),
        perMinute(60, { scope: 'MACHINE', source: 'PUBLISHED' }),
      ],
    },
    timeoutMs: 20_000,
    // A vote runs for days and scores move as votes arrive. A minute is current
    // enough for a question about a proposal and cheap for several agents.
    freshMs: 60_000,
    rank: 1,
    cacheKey: (query) => `${query.operation}:${query.id}:${query.first}:${query.state}`,
    async fetch(query, ctx) {
      if (!(GOVERNANCE_OPERATIONS as readonly string[]).includes(query.operation)) {
        throw new UpstreamFailure('UNSUPPORTED', `${query.operation} is not something this reads.`);
      }

      try {
        const response = await safeFetch('https://hub.snapshot.org/graphql', {
          signal: ctx.signal,
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ query: DOCUMENTS[query.operation], variables: variablesFor(query) }),
          maxBytes: 2_000_000,
        });

        const status = classifyStatus(response.status, response.headers);
        if (status) throw status;

        const body = parseExactJson(response.text, 'the governance answer') as {
          data?: Record<string, unknown>;
          errors?: { message?: string }[];
        };

        // GraphQL answers 200 with an errors array, so a failure here looks
        // exactly like a success to anything checking the status code.
        if (Array.isArray(body.errors) && body.errors.length > 0) {
          throw new UpstreamFailure('BAD_RESPONSE', `It refused the query: ${body.errors[0]?.message ?? 'unknown'}.`);
        }
        if (!body.data) throw new UpstreamFailure('BAD_RESPONSE', 'It answered with neither data nor an error.');

        // A space or proposal that does not exist comes back as null, which is
        // an answer rather than a fault and is passed through as one.
        return { value: body.data[query.operation === 'proposals' ? 'proposals' : query.operation] ?? null };
      } catch (error) {
        throw classifyThrown(error);
      }
    },
  });
}

export function registerGovernanceUpstreams(): void {
  registerUpstream(snapshot());
}
