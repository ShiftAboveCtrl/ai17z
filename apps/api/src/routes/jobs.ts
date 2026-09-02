import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApproveJobInput, InjectMockEventInput, JobStatus } from '@xbam/shared/contracts';
import { BadRequestError, ForbiddenError, NotFoundError, newId } from '@xbam/shared';
import {
  actions as actionsRepo,
  agents as agentsRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  memories as memoriesRepo,
  mentions as mentionsRepo,
  observability,
  ops,
  type UserRow,
} from '@xbam/database';
import { approveJob, cancelJob, ingestNormalizedEvent, rejectJob, retryJob } from '@xbam/runtime';
import { Pagination, handler, params, parseBody, parseQuery, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

const JobFilters = Pagination.extend({
  agentId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  status: z.string().optional(),
  dryRun: z.enum(['true', 'false']).optional(),
});

const MentionFilters = Pagination.extend({
  agentId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  state: z
    .enum(['REPLIED', 'WORKING', 'NEEDS_REVIEW', 'DECLINED', 'FAILED', 'DRY_RUN', 'NOT_ACTIONED'])
    .optional(),
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/jobs',
    handler(async (request) => {
      await requireUser(request);
      const query = parseQuery(JobFilters, request);
      const statuses = query.status ? query.status.split(',').map((s) => JobStatus.parse(s.trim())) : undefined;
      const result = await jobsRepo.listJobs({
        agentId: query.agentId,
        accountId: query.accountId,
        statuses,
        dryRun: query.dryRun === undefined ? undefined : query.dryRun === 'true',
        limit: query.limit,
        offset: query.offset,
      });
      return { ...result, limit: query.limit, offset: query.offset };
    }),
  );

  /**
   * Everything the radar found, and what became of it.
   *
   * A jobs list answers "what did the agent do". This answers the question an
   * owner actually asks about a social account: of everyone who said something
   * to me, who got an answer, who did not, and which of these people we are
   * already in the middle of a conversation with.
   *
   * It is a read over the existing tables -- events, discoveries, jobs, actions,
   * conversations -- and not a store, because the reconciler merging several
   * monitors onto one status id only works while there is one copy of the truth.
   */
  app.get(
    '/api/mentions',
    handler(async (request) => {
      const user = await requireUser(request);
      const query = parseQuery(MentionFilters, request);
      if (query.agentId) await ownedAgent(query.agentId, user);

      const [items, counts] = await Promise.all([
        mentionsRepo.listMentions({
          agentId: query.agentId ?? null,
          accountId: query.accountId ?? null,
          state: query.state ?? null,
          limit: query.limit,
        }),
        mentionsRepo.countMentionStates({ agentId: query.agentId ?? null, accountId: query.accountId ?? null }),
      ]);
      return { items, counts };
    }),
  );

  app.get(
    '/api/jobs/counts',
    handler(async (request) => {
      await requireUser(request);
      const query = parseQuery(z.object({ agentId: z.string().uuid().optional() }), request);
      return { counts: await jobsRepo.countJobsByStatus(query.agentId) };
    }),
  );

  /** The full generation trace for one job. */
  app.get(
    '/api/jobs/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const job = await jobsRepo.getJob(params(request).id!);
      if (!job) throw new NotFoundError('Job');
      await ownedAgent(job.agentId, user);
      const [event, trace, modelCalls, retrievals, actions, approval, attempts, diagnostics] = await Promise.all([
        eventsRepo.getEvent(job.eventId),
        observability.listTrace(job.id),
        observability.listModelCalls(job.id),
        memoriesRepo.listRetrievals(job.id),
        actionsRepo.listJobActions(job.id),
        actionsRepo.getApproval(job.id),
        jobsRepo.listJobAttempts(job.id),
        ops.listDiagnostics({ jobId: job.id, limit: 20 }),
      ]);
      return { job, event, trace, modelCalls, retrievals, actions, approval, attempts, diagnostics };
    }),
  );

  app.post(
    '/api/jobs/:id/approve',
    handler(async (request) => {
      const user = await requireUser(request);
      const job = await jobsRepo.requireJob(params(request).id!);
      await ownedAgent(job.agentId, user);
      const body = parseBody(ApproveJobInput, request);
      await approveJob({ jobId: job.id, decidedBy: user.id, ...body });
      return jobsRepo.getJob(job.id);
    }),
  );

  app.post(
    '/api/jobs/:id/reject',
    handler(async (request) => {
      const user = await requireUser(request);
      const job = await jobsRepo.requireJob(params(request).id!);
      await ownedAgent(job.agentId, user);
      const body = parseBody(z.object({ note: z.string().max(1_000).optional() }), request);
      await rejectJob({ jobId: job.id, decidedBy: user.id, note: body.note });
      return jobsRepo.getJob(job.id);
    }),
  );

  app.post(
    '/api/jobs/:id/retry',
    handler(async (request) => {
      const user = await requireUser(request);
      const job = await jobsRepo.requireJob(params(request).id!);
      await ownedAgent(job.agentId, user);
      await retryJob(job.id);
      return jobsRepo.getJob(job.id);
    }),
  );

  /**
   * Stop everything that has not finished.
   *
   * The single-job route below is the precise one. This is the one somebody
   * wants when a queue has run away from them and they need it to stop now,
   * rather than pressing cancel forty times while more arrive.
   *
   * Only work that has not finished: an executed job is history and a cancelled
   * one is already stopped.
   */
  app.post(
    '/api/jobs/cancel-all',
    handler(async (request) => {
      const user = await requireUser(request);
      const query = parseQuery(z.object({ agentId: z.string().uuid().optional() }), request);
      if (query.agentId) await ownedAgent(query.agentId, user);

      const owned = new Set((await agentsRepo.listAgents(user.id)).map((a) => a.id));
      const running = await jobsRepo.listJobs({ agentId: query.agentId, limit: 500 });
      const stoppable = running.items.filter(
        (job) =>
          owned.has(job.agentId) &&
          !['EXECUTED', 'DRY_RUN_COMPLETED', 'CANCELLED', 'PERMANENT_FAILURE'].includes(job.status),
      );

      let stopped = 0;
      for (const job of stoppable) {
        // One failure must not strand the rest: this is the button somebody
        // presses when things are already going wrong.
        await cancelJob(job.id).then(() => { stopped += 1; }).catch(() => undefined);
      }
      await ops.audit({ actorUserId: user.id, action: 'jobs.cancelled_all', entityType: 'agent', entityId: query.agentId ?? null });
      return { stopped, considered: stoppable.length };
    }),
  );

  app.post(
    '/api/jobs/:id/cancel',
    handler(async (request) => {
      const user = await requireUser(request);
      const job = await jobsRepo.requireJob(params(request).id!);
      await ownedAgent(job.agentId, user);
      await cancelJob(job.id);
      return jobsRepo.getJob(job.id);
    }),
  );
}
