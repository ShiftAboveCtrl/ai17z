import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import {
  bridgesFor,
  contentSignalsFor,
  launchesFor,
  narrativesFor,
  opportunitiesFor,
} from '@xbam/runtime';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  postAnalytics as postAnalyticsRepo,
  type UserRow,
} from '@xbam/database';
import { handler, params, requireUser } from '../http';

/**
 * What an owner is shown about how their agent is doing.
 *
 * Every route here is derived. Nothing is stored and nothing is cached: these
 * are questions answered out of events the radar discovered, actions the agent
 * published and readings taken of them, all written by the pipeline. A growth
 * table would be a second record of what happened, and it would drift from the
 * one that is true.
 *
 * Each answer carries its reasons and its gaps. `docs/ENGINEERING.md` is clear
 * that a score without its reasons is not shippable, and these are the scores
 * most likely to change what somebody does -- an owner rewriting their agent's
 * voice on the strength of eleven posts is the failure worth preventing.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

/**
 * The account a growth question is about.
 *
 * Everything here is per account, because a narrative is what *this* account
 * saw and an opportunity is a post on *this* account's timelines. An agent with
 * nothing linked has no answer rather than an empty one, and the difference is
 * what the screen tells somebody to do next.
 */
async function linkedAccount(agentId: string) {
  const links = await accountsRepo.listAgentAccounts(agentId);
  return links[0]?.accountId ?? null;
}

const noAccount = {
  ok: false as const,
  reason: 'This agent has no connected account, so there is nothing for it to have seen.',
};

export async function growthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What has worked, from what was published and later measured.
   *
   * Refuses to answer from too few posts, and says so. That refusal is the
   * feature: six posts will produce a confident sentence about the ideal length
   * of a post, and somebody will act on it.
   */
  app.get(
    '/api/agents/:id/growth/content',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return contentSignalsFor(agent.id);
    }),
  );

  /** What a lot of accounts have started talking about, and how sure that is. */
  app.get(
    '/api/agents/:id/growth/narratives',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const accountId = await linkedAccount(agent.id);
      if (!accountId) return { ...noAccount, narratives: [], gaps: [noAccount.reason], considered: 0 };
      const query = z
        .object({ windowHours: z.coerce.number().int().min(1).max(72).optional() })
        .parse(request.query ?? {});
      return narrativesFor(accountId, query);
    }),
  );

  /**
   * Tickers and addresses being posted, with the posts they were seen in.
   *
   * States no price, no liquidity and no volume, and every address carries the
   * accounts that posted it. The one judgement is arithmetic: several different
   * addresses for one ticker means at most one of them is right.
   */
  app.get(
    '/api/agents/:id/growth/launches',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const accountId = await linkedAccount(agent.id);
      if (!accountId) return { ...noAccount, launches: [], gaps: [noAccount.reason] };
      return launchesFor(accountId);
    }),
  );

  /** Who leads somewhere the agent does not already reach, and why. */
  app.get(
    '/api/agents/:id/growth/bridges',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const accountId = await linkedAccount(agent.id);
      if (!accountId) return { ...noAccount, items: [] };
      return { ok: true, items: await bridgesFor(agent.id, accountId) };
    }),
  );

  /**
   * Which of the posts the agent has seen are worth speaking into.
   *
   * Usually none, and the declines are returned alongside so an owner can read
   * why. "We looked at forty posts and found nothing" is a useful answer; an
   * empty list on its own is not.
   */
  app.get(
    '/api/agents/:id/growth/opportunities',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const accountId = await linkedAccount(agent.id);
      if (!accountId) return { ...noAccount, opportunities: [], declined: [] };
      const account = await accountsRepo.getAccount(accountId);
      const persona = await agentsRepo.getActivePersona(agent.id);
      const topics = persona?.topics ?? [];
      const verdict = await opportunitiesFor({
        agentId: agent.id,
        accountId,
        selfHandles: account?.handle ? [account.handle] : [],
        topics,
      });
      return {
        ok: true,
        ...verdict,
        // Said explicitly, because an empty list under a screen called
        // Opportunities reads as a broken feature rather than as an answer.
        topics,
      };
    }),
  );

  /**
   * What this agent published, with the freshest reading of each.
   *
   * Anchored on what was published rather than on what was measured, so a post
   * nobody has looked at yet is present with its figures absent. A list built
   * the other way round turns "we have not looked" into "it got nothing".
   */
  app.get(
    '/api/agents/:id/growth/posts',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return { items: await postAnalyticsRepo.publishedWithReadings(agent.id, 60) };
    }),
  );

  /**
   * How the account itself has moved, oldest first.
   *
   * Nothing polls for these: `docs/architecture/CADENCE.md` allows one timing
   * engine and no second timer, so a reading is taken when something reads the
   * account's own profile. The count of readings travels with the series so a
   * screen can say the series is as dense as the looking rather than implying a
   * measurement nobody is taking.
   */
  app.get(
    '/api/agents/:id/growth/account',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const readings = await postAnalyticsRepo.accountHistory(agent.id);
      return { readings, scheduled: false };
    }),
  );

  /** Every reading taken of one post, oldest first, which is how it grew. */
  app.get(
    '/api/agents/:id/growth/posts/:postId',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedAgent(params(request).id!, user);
      const postId = params(request).postId!;
      return {
        readings: await postAnalyticsRepo.history(postId),
        growth: await postAnalyticsRepo.growth(postId),
      };
    }),
  );
}

/**
 * What this agent talks about comes from the persona it already has.
 *
 * `PersonaDraft.topics` is the same list that decides what the agent has
 * anything to say about, so an opportunity engine reading a second copy would
 * drift from the reply path the moment somebody edited one. An agent with no
 * topics declines everything, and the route says which list it used so that
 * reads as a setting rather than as a broken screen.
 */
