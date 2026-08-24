import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateAccountInput } from '@xbam/shared/contracts';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { accounts as accountsRepo, ops, type UserRow } from '@xbam/database';
import { getChannelAdapter, isChannelImplemented, listChannelAdapters } from '@xbam/channels';
import { closeSession, defaultProfileDir } from '@xbam/browser';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAccount(accountId: string, user: UserRow) {
  const account = await accountsRepo.getAccount(accountId);
  if (!account) throw new NotFoundError('Account');
  if (account.ownerId !== user.id) throw new ForbiddenError('That account belongs to another owner.');
  return account;
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/channels',
    handler(async () => ({
      items: listChannelAdapters().map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        capabilities: adapter.capabilities,
        requiresBrowser: adapter.requiresBrowser,
      })),
    })),
  );

  app.get(
    '/api/accounts',
    handler(async (request) => {
      const user = await requireUser(request);
      const list = await accountsRepo.listAccounts(user.id);
      const withSessions = await Promise.all(
        list.map(async (account) => ({
          ...account,
          browserSession: await accountsRepo.getBrowserSession(account.id),
          implemented: isChannelImplemented(account.channel),
        })),
      );
      return { items: withSessions };
    }),
  );

  app.post(
    '/api/accounts',
    handler(async (request) => {
      const user = await requireUser(request);
      const input = parseBody(CreateAccountInput, request);
      const adapter = getChannelAdapter(input.channel);
      const account = await accountsRepo.createAccount({
        ownerId: user.id,
        channel: input.channel,
        handle: input.handle,
        displayName: input.displayName || input.handle,
        remoteAccountId: input.remoteAccountId,
        capabilities: [...adapter.capabilities],
        settings: input.settings,
      });
      // The profile directory is keyed by account id, which only exists after insert.
      if (adapter.requiresBrowser) {
        await accountsRepo.upsertBrowserSession({
          accountId: account.id,
          mode: input.browser?.mode ?? 'MANAGED',
          profileDir: defaultProfileDir(account.id),
          cdpUrl: input.browser?.cdpUrl || null,
        });
      }
      await ops.audit({ actorUserId: user.id, action: 'account.created', entityType: 'account', entityId: account.id });
      return account;
    }),
  );

  app.patch(
    '/api/accounts/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      const body = parseBody(
        z.object({
          displayName: z.string().max(200).optional(),
          enabled: z.boolean().optional(),
          settings: z.record(z.unknown()).optional(),
          browser: z.object({ mode: z.enum(['MANAGED', 'CDP']), cdpUrl: z.string().max(500).default('') }).optional(),
        }),
        request,
      );
      if (body.browser) {
        await accountsRepo.upsertBrowserSession({
          accountId: account.id,
          mode: body.browser.mode,
          profileDir: defaultProfileDir(account.id),
          cdpUrl: body.browser.cdpUrl || null,
        });
        // Configuration changed, so any live context is no longer valid.
        await closeSession(account.id).catch(() => undefined);
      }
      const updated = await accountsRepo.updateAccount(account.id, {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.settings !== undefined ? { settings: body.settings } : {}),
      });
      return { ...updated, browserSession: await accountsRepo.getBrowserSession(account.id) };
    }),
  );

  app.delete(
    '/api/accounts/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      await closeSession(account.id).catch(() => undefined);
      await accountsRepo.deleteAccount(account.id);
      return { deleted: true };
    }),
  );
}
