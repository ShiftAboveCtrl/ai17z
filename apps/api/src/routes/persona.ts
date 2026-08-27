import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PersonaDraft } from '@xbam/shared/contracts';
import { BadRequestError, ForbiddenError, NotFoundError, createLogger, errorMessage } from '@xbam/shared';
import { agents as agentsRepo, personaSources, type UserRow } from '@xbam/database';
import {
  getPersonaSourceAdapter,
  listPersonaSourceAdapters,
  personaDraftFromTraits,
  syncPersonaSource,
} from '@xbam/persona';
import { handler, params, parseBody, parseQuery, requireUser } from '../http';

const log = createLogger('persona-api');

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

async function ownedSource(sourceId: string, user: UserRow) {
  const source = await personaSources.getSource(sourceId);
  if (!source) throw new NotFoundError('Persona source');
  await ownedAgent(source.agentId, user);
  return source;
}

export async function personaRoutes(app: FastifyInstance): Promise<void> {
  /** Which corpus sources exist, and whether each can actually run here. */
  app.get(
    '/api/persona-source-kinds',
    handler(async (request) => {
      await requireUser(request);
      const items = await Promise.all(
        listPersonaSourceAdapters().map(async (adapter) => ({
          kind: adapter.kind,
          displayName: adapter.displayName,
          ...(await adapter.availability()),
        })),
      );
      return { items };
    }),
  );

  app.get(
    '/api/agents/:id/persona-sources',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const sources = await personaSources.listSources(agent.id);
      const items = await Promise.all(
        sources.map(async (source) => ({ ...source, stats: await personaSources.sourceStats(source.id) })),
      );
      return { items, traits: await personaSources.listTraits(agent.id) };
    }),
  );

  app.post(
    '/api/agents/:id/persona-sources',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(
        z.object({
          kind: z.enum(['x_public', 'manual']),
          handle: z.string().trim().max(120).nullable().default(null),
          label: z.string().max(200).default(''),
          includeReplies: z.boolean().default(true),
          includeQuotes: z.boolean().default(true),
        }),
        request,
      );
      if (body.kind === 'x_public' && !body.handle) {
        throw new BadRequestError('An X source needs the handle to learn from.');
      }
      return personaSources.upsertSource({
        agentId: agent.id,
        kind: body.kind,
        handle: body.handle ? body.handle.replace(/^@+/, '') : null,
        label: body.label,
        config: { includeReplies: body.includeReplies, includeQuotes: body.includeQuotes },
      });
    }),
  );

  /**
   * Starts a sync and returns immediately. Ingesting a few thousand posts is far
   * too long for a request, so the source status is what the UI follows.
   */
  app.post(
    '/api/persona-sources/:sourceId/sync',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).sourceId!, user);
      const body = parseBody(
        z.object({
          text: z.string().max(2_000_000).optional(),
          limit: z.number().int().min(1).max(20_000).default(2000),
          incremental: z.boolean().default(true),
        }),
        request,
      );
      if (source.kind === 'manual' && !body.text?.trim()) {
        throw new BadRequestError('Paste some text for this source to learn from.');
      }
      if (source.status === 'SYNCING') {
        throw new BadRequestError('This source is already syncing. Wait for it to finish.');
      }

      // Detached on purpose: the request returns, the status field carries the
      // outcome, and a long scrape never holds an HTTP connection open.
      void syncPersonaSource({
        sourceId: source.id,
        text: body.text,
        limit: body.limit,
        incremental: body.incremental,
      }).catch((error) => log.error('persona sync failed', { sourceId: source.id, message: errorMessage(error) }));

      return { started: true, sourceId: source.id };
    }),
  );

  app.get(
    '/api/persona-sources/:sourceId/items',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).sourceId!, user);
      const query = parseQuery(
        z.object({
          view: z.enum(['useful', 'excluded', 'all']).default('useful'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        request,
      );
      const page = await personaSources.listItems({ sourceId: source.id, ...query });
      return { ...page, ...query, stats: await personaSources.sourceStats(source.id) };
    }),
  );

  /** The owner overrules the machine. Null returns the item to the automatic decision. */
  app.put(
    '/api/persona-sources/:sourceId/items/:itemId',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedSource(params(request).sourceId!, user);
      const body = parseBody(z.object({ include: z.boolean().nullable() }), request);
      await personaSources.setOwnerOverride(params(request).itemId!, body.include);
      return { stats: await personaSources.sourceStats(params(request).sourceId!) };
    }),
  );

  app.delete(
    '/api/persona-sources/:sourceId',
    handler(async (request) => {
      const user = await requireUser(request);
      const source = await ownedSource(params(request).sourceId!, user);
      await personaSources.deleteSource(source.id);
      return { deleted: true };
    }),
  );

  /**
   * Writes what was learned into a new persona version. The derived profile never
   * outranks the owner: this produces an editable draft, reviewable afterwards.
   */
  app.post(
    '/api/agents/:id/persona-sources/apply',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const traits = await personaSources.listTraits(agent.id);
      if (traits.length === 0) throw new BadRequestError('Nothing has been learned yet. Sync a source first.');

      const current = await agentsRepo.getActivePersona(agent.id);
      const learned = personaDraftFromTraits(traits);
      const body = parseBody(z.object({ replaceExamples: z.boolean().default(true) }), request);

      const draft = PersonaDraft.parse({
        ...(current ?? {}),
        displayName: current?.displayName ?? agent.name,
        personality: learned.personality || current?.personality || '',
        styleGuidelines: learned.styleGuidelines || current?.styleGuidelines || '',
        topics: learned.topics.length > 0 ? learned.topics : (current?.topics ?? []),
        styleExamples: body.replaceExamples
          ? learned.styleExamples
          : [...(current?.styleExamples ?? []), ...learned.styleExamples].slice(0, 60),
        changeNote: `learned from ${traits.length} derived traits`,
      });
      return agentsRepo.savePersonaVersion(agent.id, draft, user.id);
    }),
  );
}
