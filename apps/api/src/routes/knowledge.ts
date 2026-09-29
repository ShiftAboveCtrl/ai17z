import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { agents as agentsRepo, knowledge as knowledgeRepo, type UserRow } from '@xbam/database';
import { indexSource, allowedRoots, builtInSources } from '@xbam/runtime';
import {
  DocumentationSiteConfig,
  GithubRepositoryConfig,
  KnowledgeLabels,
  knowledgeFreshness,
} from '@xbam/shared/contracts';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

/**
 * A collection's config, checked against what its kind accepts.
 *
 * Refused with the contract's own sentence rather than stored and ignored: a
 * crawl limit above the ceiling is somebody expecting more than they will get.
 */
function validConfig(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'DOCUMENTATION_SITE') return DocumentationSiteConfig.parse(config);
  if (kind === 'GITHUB_REPOSITORY') return GithubRepositoryConfig.parse(config);
  return {};
}

async function ownedSource(sourceId: string, user: UserRow) {
  const source = await knowledgeRepo.getSource(sourceId);
  if (!source) throw new NotFoundError('Knowledge source');
  await ownedAgent(source.agentId, user);
  return source;
}

/** Read by the worker, because a crawl can outlast any request somebody waits on. */
const COLLECTIONS = new Set(['DOCUMENTATION_SITE', 'GITHUB_REPOSITORY']);

const CreateSource = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['PATH', 'TEXT', 'URL', 'DOCUMENTATION_SITE', 'GITHUB_REPOSITORY']),
  /**
   * A folder for PATH, the text itself for TEXT, one address for URL, the first
   * page for a documentation site, and owner/name or a GitHub address for a
   * repository.
   */
  location: z.string().max(200_000),
  /** Crawl bounds or repository paths, validated against the kind below. */
  config: z.record(z.string(), z.unknown()).default({}),
  labels: KnowledgeLabels.default({}),
  include: z.array(z.string().max(20)).max(20).default([]),
  /**
   * How often to read it again, in minutes. Null means only when asked.
   *
   * Fifteen minutes is the floor and there is no default: a source that
   * re-reads on its own is one nobody remembers agreeing to.
   */
  refreshIntervalMinutes: z.number().int().min(15).max(60 * 24 * 30).nullable().default(null),
});

const UpdateSource = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  location: z.string().max(200_000).optional(),
  include: z.array(z.string().max(20)).max(20).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  labels: KnowledgeLabels.optional(),
  refreshIntervalMinutes: z.number().int().min(15).max(60 * 24 * 30).nullable().optional(),
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
      const sources = await knowledgeRepo.listSources(agent.id);
      return {
        // With the verdict a screen shows, derived now rather than stored,
        // because "refresh due" happens by nothing happening.
        sources: sources.map((source) => ({ ...source, freshness: knowledgeFreshness(source) })),
        // So the interface can say "this installation can read here" before
        // somebody types a path it will refuse.
        roots: allowedRoots(),
        // Documentation shipped with this installation, offered as a source
        // somebody can attach in one step. An ordinary source once created.
        available: await builtInSources(),
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

      const config = validConfig(body.kind, body.config);
      const source = await knowledgeRepo.createSource({
        agentId: agent.id,
        name: body.name,
        kind: body.kind,
        location: body.location,
        include: body.include,
        refreshIntervalMinutes: body.refreshIntervalMinutes,
        config,
        labels: body.labels,
      });

      if (COLLECTIONS.has(source.kind)) {
        // Queued for the worker, which reads it on its next pass. The screen
        // shows it as waiting to be read, then refreshing, then what it found.
        await knowledgeRepo.updateSource(source.id, { nextRefreshAt: new Date().toISOString() });
        return { source: await knowledgeRepo.getSource(source.id), report: null, queued: true };
      }

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
      const updated = await knowledgeRepo.updateSource(source.id, {
        ...body,
        ...(body.config !== undefined ? { config: validConfig(source.kind, body.config) } : {}),
      });

      // A changed folder or filter is a different source, so re-read it rather
      // than leaving yesterday's chunks answering for today's configuration.
      const changedWhatItReads = body.location !== undefined || body.include !== undefined || body.config !== undefined;
      // Changing the schedule starts it from now rather than leaving a stamp
      // set under the old interval, which could be a month away.
      if (body.refreshIntervalMinutes !== undefined) {
        await knowledgeRepo.updateSource(source.id, {
          nextRefreshAt: body.refreshIntervalMinutes === null ? null : new Date().toISOString(),
        });
      }
      if (changedWhatItReads && updated.enabled && COLLECTIONS.has(updated.kind)) {
        await knowledgeRepo.updateSource(source.id, { nextRefreshAt: new Date().toISOString() });
        return { source: await knowledgeRepo.getSource(source.id), report: null, queued: true };
      }
      const report = changedWhatItReads && updated.enabled ? await indexSource(updated) : null;
      return { source: await knowledgeRepo.getSource(source.id), report };
    }),
  );

  app.post(
    '/api/knowledge/:id/refresh',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).id!, user);
      if (COLLECTIONS.has(source.kind)) {
        await knowledgeRepo.updateSource(source.id, { nextRefreshAt: new Date().toISOString() });
        return { source: await knowledgeRepo.getSource(source.id), report: null, queued: true };
      }
      const report = await indexSource(source);
      return { source: await knowledgeRepo.getSource(source.id), report };
    }),
  );

  app.get(
    '/api/knowledge/:id/documents',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).id!, user);
      // Every page or file a collection holds, with the revision it was read at.
      return { documents: await knowledgeRepo.listDocuments(source.id) };
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
