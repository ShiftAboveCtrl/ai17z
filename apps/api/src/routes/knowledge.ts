import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { agents as agentsRepo, knowledge as knowledgeRepo, type UserRow } from '@xbam/database';
import { indexSource, allowedRoots } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

async function ownedSource(sourceId: string, user: UserRow) {
  const source = await knowledgeRepo.getSource(sourceId);
  if (!source) throw new NotFoundError('Knowledge source');
  await ownedAgent(source.agentId, user);
  return source;
}

const CreateSource = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['PATH', 'TEXT']),
  /** A folder for PATH, the text itself for TEXT. */
  location: z.string().max(200_000),
  include: z.array(z.string().max(20)).max(20).default([]),
});

const UpdateSource = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  location: z.string().max(200_000).optional(),
  include: z.array(z.string().max(20)).max(20).optional(),
  enabled: z.boolean().optional(),
});

/**
 * The documents an agent has been taught from.
 *
 * Indexing runs here rather than being queued because reading a folder is fast
 * and the owner is watching: a source that takes four seconds to read should
 * report what it found, not report that it will report later. What it cannot do
 * is read a folder this process cannot see, which is why the response says which
 * roots are permitted -- a containerised API and a folder on somebody's desktop
 * are a common and otherwise baffling combination.
 */
export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/knowledge',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      return {
        sources: await knowledgeRepo.listSources(agent.id),
        // So the interface can say "this installation can read here" before
        // somebody types a path it will refuse.
        roots: allowedRoots(),
      };
    }),
  );

  app.post(
    '/api/agents/:id/knowledge',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(CreateSource, request);

      const existing = await knowledgeRepo.listSources(agent.id);
      if (existing.some((s) => s.name.toLowerCase() === body.name.toLowerCase())) {
        throw new ConflictError(`This agent already has a knowledge source called "${body.name}".`);
      }

      const source = await knowledgeRepo.createSource({
        agentId: agent.id,
        name: body.name,
        kind: body.kind,
        location: body.location,
        include: body.include,
      });

      // Read it immediately. A source that exists but has never been read is a
      // row that looks like knowledge and answers nothing.
      const report = await indexSource(source);
      return { source: await knowledgeRepo.getSource(source.id), report };
    }),
  );

  app.patch(
    '/api/knowledge/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).id!, user);
      const body = parseBody(UpdateSource, request);
      const updated = await knowledgeRepo.updateSource(source.id, body);

      // A changed folder or filter is a different source, so re-read it rather
      // than leaving yesterday's chunks answering for today's configuration.
      const changedWhatItReads = body.location !== undefined || body.include !== undefined;
      const report = changedWhatItReads && updated.enabled ? await indexSource(updated) : null;
      return { source: await knowledgeRepo.getSource(source.id), report };
    }),
  );

  app.post(
    '/api/knowledge/:id/refresh',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).id!, user);
      const report = await indexSource(source);
      return { source: await knowledgeRepo.getSource(source.id), report };
    }),
  );

  app.get(
    '/api/knowledge/:id/chunks',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).id!, user);
      // What was actually indexed, because visibility is the real safeguard
      // against a source having quietly swallowed something it should not have.
      return { chunks: await knowledgeRepo.listChunks(source.id) };
    }),
  );

  app.delete(
    '/api/knowledge/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).id!, user);
      // Chunks go with it, by foreign key. An agent that goes on citing
      // documents its owner withdrew is worse than one that knows nothing.
      const taught = await knowledgeRepo.countChunks(source.id);
      await knowledgeRepo.deleteSource(source.id);
      // Every route here answers 200 with an { ok, data } envelope, which is
      // the convention across this API; `ok` sets the status itself, so a
      // reply.code() above it is silently ignored.
      return { removed: { name: source.name, chunks: taught } };
    }),
  );
}
