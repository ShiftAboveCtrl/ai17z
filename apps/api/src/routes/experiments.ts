import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { experimentsFor } from '@xbam/runtime';
import { agents as agentsRepo, experiments as experimentsRepo, ops, type UserRow } from '@xbam/database';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Starting, stopping and reading one experiment at a time.
 *
 * The floor on how soon a verdict is possible is not here and cannot be
 * lowered from here: `readExperiment` decides it, and every route below reads
 * its answer. A screen that could set its own threshold would be a second
 * opinion about the only thing this feature exists to be careful about.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

const Variant = z.object({
  key: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(80),
  /**
   * One instruction, and a short one.
   *
   * Long enough for "keep this under 120 characters" and not for a second
   * persona. An arm that changes five things at once produces a result nobody
   * can act on, because nothing says which of the five did it.
   */
  instruction: z.string().trim().max(240).default(''),
});

const StartExperiment = z.object({
  hypothesis: z.string().trim().min(4).max(300),
  variantA: Variant,
  variantB: Variant,
});

export async function experimentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/growth/experiments',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return { items: await experimentsFor(agent.id) };
    }),
  );

  app.post(
    '/api/agents/:id/growth/experiments',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(StartExperiment, request);
      if (body.variantA.key === body.variantB.key) {
        throw new BadRequestError('The two arms need different keys, or nothing can tell them apart.');
      }
      if (!body.variantA.instruction && !body.variantB.instruction) {
        // Two arms with no instruction between them are the same arm twice, and
        // the result would be a measurement of noise presented as a finding.
        throw new BadRequestError('One of the two arms has to change something, or there is nothing to compare.');
      }
      if (await experimentsRepo.running(agent.id)) {
        throw new ConflictError(
          'This agent is already running an experiment. Two at once are one experiment with four arms and no way to tell which did anything.',
        );
      }

      const experiment = await experimentsRepo.start({
        agentId: agent.id,
        hypothesis: body.hypothesis,
        variantA: body.variantA,
        variantB: body.variantB,
      });
      await ops.audit({
        actorUserId: user.id,
        action: 'experiment.started',
        entityType: 'agent',
        entityId: agent.id,
        data: { experimentId: experiment.id, hypothesis: experiment.hypothesis },
      });
      return experiment;
    }),
  );

  app.post(
    '/api/agents/:id/growth/experiments/:experimentId/stop',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const experiment = await experimentsRepo.get(params(request).experimentId!);
      // Rows from this repository are the database's own shape, so this is
      // `agent_id` rather than `agentId`.
      if (!experiment || experiment.agent_id !== agent.id) throw new NotFoundError('Experiment');
      // Stopped, never deleted: the result is the point, and a null result that
      // disappears is a thing somebody tries again next month.
      const stopped = await experimentsRepo.stop(experiment.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'experiment.stopped',
        entityType: 'agent',
        entityId: agent.id,
        data: { experimentId: experiment.id },
      });
      return stopped;
    }),
  );
}
