import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, ForbiddenError, NotFoundError } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  browserTasks as browserTasksRepo,
  jobs as jobsRepo,
  ops,
  type UserRow,
} from '@xbam/database';
import { explainRehearsal, rehearse } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * The Response Lab.
 *
 * Three routes and no cleverness: rehearse against something typed, rehearse
 * against a real post, and read back what fed the answer.
 *
 * The split between the first two is where the browser is. Something typed
 * needs nothing external, so the API can queue it directly. A real post has to
 * be read from X, and the API owns no browsers -- so it records the intent and
 * the worker does the reading, exactly as looking somebody up already does.
 *
 * ### Nothing here can publish
 *
 * Both paths end in `rehearse()`, which sets `dryRun` in one place and reads
 * the job row back to check it landed. There is no parameter on either route
 * that could turn a rehearsal into a real action, and that is deliberate: the
 * one time a dry-run flag was passed in and silently ignored, an autonomous
 * agent replied to a stranger.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

const Typed = z.object({
  text: z.string().trim().min(1).max(5_000),
  fromHandle: z.string().trim().max(80).optional(),
  /** What was said above it, when the owner is testing a reply in a thread. */
  parentText: z.string().trim().max(5_000).optional(),
});

const RealPost = z.object({
  /** A link to a post, or its numeric id. */
  post: z.string().trim().min(1).max(500),
});

export async function labRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Rehearse against something somebody typed.
   *
   * The mock channel, so no account is needed and nothing external is touched.
   * This is the fast path an owner uses while they are still editing a persona.
   */
  app.post(
    '/api/agents/:id/lab/typed',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(Typed, request);

      const run = await rehearse({
        agentId: agent.id,
        accountId: null,
        requestedBy: user.id,
        subject: {
          channel: 'mock',
          authorHandle: body.fromHandle?.replace(/^@+/, '') || 'someone',
          text: body.text,
          parentText: body.parentText ?? null,
        },
      });

      return { jobId: run.jobId, eventId: run.eventId, queued: true };
    }),
  );

  /**
   * Rehearse against a real post on X.
   *
   * Queued rather than answered, because the read happens in the worker. The
   * caller polls the task, and the task result carries the job id the
   * explanation is read from.
   */
  app.post(
    '/api/agents/:id/lab/post',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(RealPost, request);

      /*
        The account whose browser does the reading.

        Preferring one this agent is actually linked to, because reading a post
        as the agent's own signed-in session is what makes the rehearsal
        faithful: whether the author blocked it, whether it follows them, and
        what a protected account shows are all answers that depend on who is
        asking.
      */
      const owned = await accountsRepo.listAccounts(user.id);
      const linked = await accountsRepo.listAgentAccounts(agent.id);
      const linkedIds = new Set(linked.map((link) => link.accountId));
      const reader =
        owned.find((account) => account.channel === 'x' && account.enabled && linkedIds.has(account.id)) ??
        owned.find((account) => account.channel === 'x' && account.enabled) ??
        null;

      if (!reader) {
        throw new BadRequestError(
          'AI17Z reads X through a signed-in browser, so it needs one of your X accounts connected first. ' +
            'Connect an account, sign in to it, and try again. You can still rehearse against a message you type.',
        );
      }

      const task = await browserTasksRepo.enqueueBrowserTask({
        accountId: reader.id,
        kind: 'REHEARSE_X_POST',
        requestedBy: user.id,
        params: { postRef: body.post, agentId: agent.id, requestedBy: user.id },
      });

      await ops.audit({
        actorUserId: user.id,
        action: 'lab.rehearsal.requested',
        entityType: 'agent',
        entityId: agent.id,
        data: { post: body.post, accountId: reader.id },
      });

      return { queued: true, taskId: task.id, accountId: reader.id };
    }),
  );

  /**
   * What fed the answer, and what happened to it.
   *
   * Assembled from rows that already existed, so nothing is recorded during a
   * rehearsal that is not recorded during a real reply. An explanation produced
   * by a path of its own would be an explanation of that path.
   */
  app.get(
    '/api/agents/:id/lab/:jobId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const job = await jobsRepo.getJob(params(request).jobId!);
      if (!job) throw new NotFoundError('Job');
      if (job.agentId !== agent.id) throw new ForbiddenError('That job belongs to another agent.');
      return explainRehearsal(job.id);
    }),
  );
}
