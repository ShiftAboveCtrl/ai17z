import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMORY_SCOPES, MEMORY_TYPES } from '@xbam/shared/contracts';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { agents as agentsRepo, memories as memoriesRepo, ops, type UserRow } from '@xbam/database';
import { Pagination, handler, params, parseBody, parseQuery, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

const SearchQuery = Pagination.extend({
  scopes: z.string().optional(),
  handle: z.string().max(120).optional(),
  conversationId: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  pinned: z.enum(['true', 'false']).optional(),
});

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/memories',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const query = parseQuery(SearchQuery, request);
      const result = await memoriesRepo.searchMemories({
        agentId: agent.id,
        scopes: query.scopes ? query.scopes.split(',').map((s) => z.enum(MEMORY_SCOPES).parse(s.trim())) : undefined,
        handle: query.handle,
        conversationId: query.conversationId,
        search: query.search,
        pinnedOnly: query.pinned === 'true',
        limit: query.limit,
        offset: query.offset,
      });
      return {
        ...result,
        limit: query.limit,
        offset: query.offset,
        counts: await agentsRepo.countMemoriesByScope(agent.id),
      };
    }),
  );

  /** Manual memory. The operator can teach an agent something directly. */
  app.post(
    '/api/agents/:id/memories',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          scope: z.enum(MEMORY_SCOPES),
          memoryType: z.enum(MEMORY_TYPES).default('FACT'),
          content: z.string().trim().min(1).max(20_000),
          summary: z.string().max(500).optional(),
          remoteHandle: z.string().max(120).optional(),
          importance: z.number().min(0).max(1).default(0.7),
          pinned: z.boolean().default(false),
        }),
        request,
      );
      const result = await memoriesRepo.writeMemory({
        agentId: agent.id,
        scope: body.scope,
        memoryType: body.memoryType,
        content: body.content,
        summary: body.summary ?? null,
        remoteHandle: body.remoteHandle ?? null,
        importance: body.importance,
        pinned: body.pinned,
      });
      await ops.audit({
        actorUserId: user.id,
        action: 'memory.created',
        entityType: 'memory',
        entityId: result.memory.id,
        data: { scope: body.scope, created: result.created },
      });
      return result;
    }),
  );

  app.patch(
    '/api/agents/:id/memories/:memoryId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const memory = await memoriesRepo.getMemory(params(request).memoryId!);
      if (!memory || memory.agentId !== agent.id) throw new NotFoundError('Memory');
      const body = parseBody(
        z.object({
          content: z.string().trim().min(1).max(20_000).optional(),
          summary: z.string().max(500).nullable().optional(),
          importance: z.number().min(0).max(1).optional(),
          pinned: z.boolean().optional(),
          expiresAt: z.string().datetime().nullable().optional(),
        }),
        request,
      );
      return memoriesRepo.updateMemory(memory.id, body);
    }),
  );

  app.delete(
    '/api/agents/:id/memories/:memoryId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const memory = await memoriesRepo.getMemory(params(request).memoryId!);
      if (!memory || memory.agentId !== agent.id) throw new NotFoundError('Memory');
      await memoriesRepo.deleteMemory(memory.id);
      await ops.audit({ actorUserId: user.id, action: 'memory.deleted', entityType: 'memory', entityId: memory.id });
      return { deleted: true };
    }),
  );
}
