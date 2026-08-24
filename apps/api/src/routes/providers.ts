import type { FastifyInstance } from 'fastify';
import { CreateProviderInput } from '@xbam/shared/contracts';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { ops, providers as providersRepo } from '@xbam/database';
import { listAdapters, testProviderConnection } from '@xbam/models';
import { handler, params, parseBody, requireUser } from '../http';

const UpdateProviderBody = CreateProviderInput.partial();

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  /** Catalogue of provider kinds, so the UI does not hard-code the list. */
  app.get(
    '/api/provider-kinds',
    handler(async () => ({
      items: listAdapters().map((adapter) => ({
        kind: adapter.kind,
        defaultBaseUrl: adapter.defaultBaseUrl,
        requiresApiKey: adapter.requiresApiKey,
      })),
    })),
  );

  app.get(
    '/api/providers',
    handler(async (request) => {
      const user = await requireUser(request);
      return { items: await providersRepo.listProviders(user.id) };
    }),
  );

  app.post(
    '/api/providers',
    handler(async (request) => {
      const user = await requireUser(request);
      const input = parseBody(CreateProviderInput, request);
      const created = await providersRepo.createProvider({ ownerId: user.id, ...input });
      await ops.audit({
        actorUserId: user.id,
        action: 'provider.created',
        entityType: 'provider',
        entityId: created.id,
        // The key itself is never audited, only whether one was supplied.
        data: { provider: created.provider, hasKey: created.hasKey },
      });
      return created;
    }),
  );

  app.patch(
    '/api/providers/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const existing = await providersRepo.getProvider(params(request).id!);
      if (!existing) throw new NotFoundError('Provider');
      if (existing.ownerId !== user.id) throw new ForbiddenError('That provider belongs to another owner.');
      const patch = parseBody(UpdateProviderBody, request);
      const updated = await providersRepo.updateProvider(existing.id, patch);
      await ops.audit({
        actorUserId: user.id,
        action: 'provider.updated',
        entityType: 'provider',
        entityId: existing.id,
        data: { fields: Object.keys(patch).filter((k) => k !== 'apiKey') },
      });
      return updated;
    }),
  );

  app.delete(
    '/api/providers/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const existing = await providersRepo.getProvider(params(request).id!);
      if (!existing) throw new NotFoundError('Provider');
      if (existing.ownerId !== user.id) throw new ForbiddenError('That provider belongs to another owner.');
      await providersRepo.deleteProvider(existing.id);
      return { deleted: true };
    }),
  );

  app.post(
    '/api/providers/:id/test',
    handler(async (request) => {
      const user = await requireUser(request);
      const existing = await providersRepo.getProvider(params(request).id!);
      if (!existing) throw new NotFoundError('Provider');
      if (existing.ownerId !== user.id) throw new ForbiddenError('That provider belongs to another owner.');
      const result = await testProviderConnection(existing.id);
      return { ...result, provider: await providersRepo.getProvider(existing.id) };
    }),
  );
}
