import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { accounts as accountsRepo, browserTasks, ops, workers as workersRepo, type UserRow } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAccount(accountId: string, user: UserRow) {
  const account = await accountsRepo.getAccount(accountId);
  if (!account) throw new NotFoundError('Account');
  if (account.ownerId !== user.id) throw new ForbiddenError('That account belongs to another owner.');
  return account;
}

const TASK_KINDS = [
  'CONNECT',
  'HEALTH_CHECK',
  'OPEN_AUTH',
  'SCREENSHOT',
  'CLEAR',
  'DISCONNECT',
  'INGEST',
  'CANCEL_AUTH',
] as const;

/**
 * Session management is expressed as intents, not direct browser calls.
 *
 * The API never opens a browser: a Chromium profile can only be held by one
 * process, so the worker owns them all and the API records what should happen.
 * The UI polls the returned task for its result.
 */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/accounts/:id/session',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      return {
        account,
        session: await accountsRepo.getBrowserSession(account.id),
        recentTasks: await browserTasks.listBrowserTasks(account.id, 10),
        diagnostics: await ops.listDiagnostics({ accountId: account.id, limit: 10 }),
      };
    }),
  );

  app.post(
    '/api/accounts/:id/session/tasks',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      const body = parseBody(z.object({ kind: z.enum(TASK_KINDS) }), request);

      const adapter = getChannelAdapter(account.channel);
      if (!adapter.requiresBrowser && body.kind !== 'HEALTH_CHECK') {
        throw new BadRequestError(`The ${adapter.displayName} channel does not use a browser session.`);
      }

      // Say so now rather than queueing into the void. A task with nothing able
      // to run it used to sit PENDING forever and block every later attempt.
      if (adapter.requiresBrowser && !(await workersRepo.browserWorkerPresent())) {
        throw new ConflictError(
          'No worker that can open a browser is running, so this would wait forever. Start one on the machine that has the browser: run start-ai17z.ps1, or npm run dev:worker with AI17Z_WORKER_ROLE=browser.',
        );
      }

      const task = await browserTasks.enqueueBrowserTask({
        accountId: account.id,
        kind: body.kind,
        requestedBy: user.id,
      });
      await ops.audit({
        actorUserId: user.id,
        action: `session.${body.kind.toLowerCase()}`,
        entityType: 'account',
        entityId: account.id,
      });
      return task;
    }),
  );

  /**
   * Machine-level browser diagnostic. Answers whether this installation can
   * drive a browser at all, before an owner discovers it cannot mid-connection.
   */
  app.post(
    '/api/browser/preflight',
    handler(async (request) => {
      const user = await requireUser(request);
      return browserTasks.enqueueBrowserTask({ accountId: null, kind: 'PREFLIGHT', requestedBy: user.id });
    }),
  );

  // Giving up on a browser action. Closing the browser window tells AI17Z
  // nothing, so there has to be a way to say it here.
  app.delete(
    '/api/accounts/:id/session/tasks',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      const cancelled = await browserTasks.cancelAccountTasks(account.id, 'Cancelled by the account owner.');
      await ops.audit({
        actorUserId: user.id,
        action: 'session.tasks.cancelled',
        entityType: 'account',
        entityId: account.id,
        data: { cancelled },
      });
      return { cancelled };
    }),
  );

  // Whether anything can do browser work at all, so the UI can explain a wait
  // rather than showing a spinner that will never resolve.
  app.get(
    '/api/browser-workers',
    handler(async (request) => {
      await requireUser(request);
      const present = await workersRepo.present();
      return {
        browserWorkerPresent: present.some((w) => w.browserCapable),
        workers: present.map((w) => ({
          id: w.id,
          role: w.role,
          browserCapable: w.browserCapable,
          hostname: w.hostname,
          lastSeenAt: w.lastSeenAt,
        })),
      };
    }),
  );


  app.get(
    '/api/browser-tasks/:taskId',
    handler(async (request) => {
      const user = await requireUser(request);
      const task = await browserTasks.getBrowserTask(params(request).taskId!);
      if (!task) throw new NotFoundError('Browser task');
      // System tasks belong to the installation, not to an account.
      if (task.accountId !== null) await ownedAccount(task.accountId, user);
      return task;
    }),
  );
}
