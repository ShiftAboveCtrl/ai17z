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
