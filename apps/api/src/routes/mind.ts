import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { ATTENTION_STATES, AUTONOMY_LEVELS, GOAL_STATUSES } from '@xbam/shared/contracts';
import { wakeAgent } from '@xbam/runtime';
import { agents as agentsRepo, deliberation as mind, ops, type UserRow } from '@xbam/database';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * What an agent has been thinking about, and what an owner can do about it.
 *
 * Persistent autonomous deliberation cannot be an invisible box. An agent that
 * develops interests, sets itself goals and decides things are worth saying is
 * only acceptable if the owner can see every one of those and change it -- so
 * everything the loop writes is readable here, and everything it decides is
 * adjustable here.
 *
 * Three things this route is careful about:
 *
 * **It shows conclusions, never reasoning.** Nothing in the schema holds model
 * reasoning tokens and nothing here would have anywhere to put them. What an
 * owner reads is what the agent concluded, what it rests on, and how sure it is.
 *
 * **An owner's decision outranks the agent's.** A goal an owner pinned cannot be
 * abandoned by deliberation, and the autonomy ladder is owner-set only. Nothing
 * the agent does can raise its own permissions.
 *
 * **Reading is free, thinking is not.** The GET here is a database read. The one
 * route that makes the agent think is a POST, because it costs a model call.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

export async function mindRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything on one screen: what is on its mind, what it is trying to do,
   * what it has been doing, and how much it is allowed to do on its own.
   */
  app.get(
    '/api/agents/:id/mind',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);

      const [items, goals, reflections, wake] = await Promise.all([
        mind.onItsMind(agent.id, { limit: 40 }),
        mind.listGoals(agent.id, { limit: 40 }),
        mind.recentReflections(agent.id, 15),
        mind.getWake(agent.id),
      ]);

      return {
        // Null when deliberation has never been configured, which is the
        // default: an agent does not start thinking because it was created.
        wake,
        onItsMind: items.map((item) => ({
          id: item.id,
          kind: item.kind,
          summary: item.summary,
          detail: item.detail,
          salience: item.salience,
          confidence: Number(item.confidence),
          // The reasons, not just the number. A score nobody can argue with is
          // a score nobody can correct.
          factors: item.factors,
          evidence: item.evidence,
          reinforcements: item.reinforcements,
          firstObservedAt: item.firstObservedAt,
          lastReinforcedAt: item.lastReinforcedAt,
          origin: item.origin,
        })),
        goals: goals.map((goal) => ({
          id: goal.id,
          summary: goal.summary,
          reason: goal.reason,
          origin: goal.origin,
          pinned: goal.pinned,
          priority: goal.priority,
          status: goal.status,
          progress: goal.progress,
          evidence: goal.evidence,
          resolution: goal.resolution,
          createdAt: goal.createdAt,
          resolvedAt: goal.resolvedAt,
        })),
        reflections,
      };
    }),
  );

  /** How much the agent may do on its own, and how often it thinks. */
  app.put(
    '/api/agents/:id/mind/wake',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          enabled: z.boolean().optional(),
          autonomy: z.enum(AUTONOMY_LEVELS).optional(),
          intervalSeconds: z.number().int().min(300).max(86_400).optional(),
          deepIntervalSeconds: z.number().int().min(3_600).max(604_800).optional(),
        }),
        request,
      );

      const wake = await mind.setWake(agent.id, body);
      await ops.audit({
        actorUserId: user.id,
        action: 'mind.wake.set',
        entityType: 'agent',
        entityId: agent.id,
        // The whole settled state, not the patch: "what is this agent allowed
        // to do" is the question an audit row has to be able to answer on its
        // own, months later.
        data: { enabled: wake.enabled, autonomy: wake.autonomy, intervalSeconds: wake.intervalSeconds },
      });
      return { wake };
    }),
  );

  /**
   * Think now.
   *
   * The one route that costs something. An owner who has just changed what
   * their agent watches should not have to wait out an interval to see whether
   * it made any difference.
   */
  app.post(
    '/api/agents/:id/mind/wake',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const outcome = await wakeAgent(agent.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'mind.wake.now',
        entityType: 'agent',
        entityId: agent.id,
        data: { attended: outcome.attended, produced: outcome.produced, reason: outcome.reason },
      });
      return outcome;
    }),
  );

  /** A goal the owner set. Theirs, so the agent may not retire it. */
  app.post(
    '/api/agents/:id/mind/goals',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          summary: z.string().trim().min(6).max(300),
          reason: z.string().trim().max(1_000).optional(),
          priority: z.number().int().min(0).max(100).optional(),
        }),
        request,
      );

      const goal = await mind.addGoal({
        agentId: agent.id,
        summary: body.summary,
        reason: body.reason ?? '',
        // Set by a person, so pinned: deliberation may move it along and may
        // not decide it has stopped mattering.
        origin: 'OWNER',
        pinned: true,
        ...(body.priority === undefined ? {} : { priority: body.priority }),
      });
      await ops.audit({
        actorUserId: user.id,
        action: 'mind.goal.added',
        entityType: 'agent',
        entityId: agent.id,
        data: { summary: goal.summary },
      });
      return { goal };
    }),
  );

  app.patch(
    '/api/agents/:id/mind/goals/:goalId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          summary: z.string().trim().min(6).max(300).optional(),
          reason: z.string().trim().max(1_000).optional(),
          priority: z.number().int().min(0).max(100).optional(),
          status: z.enum(GOAL_STATUSES).optional(),
          pinned: z.boolean().optional(),
          resolution: z.string().trim().max(1_000).optional(),
        }),
        request,
      );

      const goal = await mind.updateGoal(params(request).goalId!, body);
      if (!goal || goal.agentId !== agent.id) throw new NotFoundError('Goal');
      return { goal };
    }),
  );

  app.delete(
    '/api/agents/:id/mind/goals/:goalId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const gone = await mind.deleteGoal(agent.id, params(request).goalId!);
      if (!gone) throw new NotFoundError('Goal');
      return { deleted: true };
    }),
  );

  /**
   * Take something off the agent's mind.
   *
   * Retired rather than deleted, like everything else here: what an agent used
   * to be interested in is a reasonable thing for an owner to be able to look
   * back at, and a row that vanishes cannot answer it.
   */
  app.delete(
    '/api/agents/:id/mind/items/:itemId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const item = await mind.getAttention(params(request).itemId!);
      if (!item || item.agentId !== agent.id) throw new NotFoundError('Item');
      await mind.settle(item.id, 'RETIRED', 'You took this off its mind.');
      await ops.audit({
        actorUserId: user.id,
        action: 'mind.item.retired',
        entityType: 'agent',
        entityId: agent.id,
        data: { summary: item.summary },
      });
      return { retired: true };
    }),
  );

  /** What it used to think, for an owner asking how it got here. */
  app.get(
    '/api/agents/:id/mind/history',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const query = z
        .object({ state: z.enum(ATTENTION_STATES).optional() })
        .parse(request.query ?? {});
      const items = await mind.onItsMind(agent.id, { limit: 60, state: query.state ?? 'RESOLVED' });
      return { items };
    }),
  );
}
