import type { FastifyInstance } from 'fastify';
import { BootstrapOwnerInput, LoginInput } from '@xbam/shared/contracts';
import { ConflictError, UnauthorizedError } from '@xbam/shared';
import { ops, users as usersRepo } from '@xbam/database';
import { handler, parseBody, requireUser } from '../http';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** First-run check. Safe to call unauthenticated: it reveals only whether setup is needed. */
  app.get(
    '/api/bootstrap/status',
    handler(async () => {
      const count = await usersRepo.countUsers();
      return { needsOwner: count === 0 };
    }),
  );

  app.post(
    '/api/bootstrap/owner',
    handler(async (request) => {
      const input = parseBody(BootstrapOwnerInput, request);
      if ((await usersRepo.countUsers()) > 0) {
        throw new ConflictError('An owner account already exists. Sign in instead.');
      }
      const user = await usersRepo.createOwner(input);
      const session = await usersRepo.createSession(user.id, 30, request.headers['user-agent']);
      await ops.audit({ actorUserId: user.id, action: 'owner.created', entityType: 'user', entityId: user.id });
      return { user, token: session.token, expiresAt: session.expiresAt };
    }),
  );

  app.post(
    '/api/auth/login',
    handler(async (request) => {
      const input = parseBody(LoginInput, request);
      const user = await usersRepo.authenticate(input.email, input.password);
      // One message for both cases: never reveal whether an address exists.
      if (!user) throw new UnauthorizedError('Incorrect email or password.');
      const session = await usersRepo.createSession(user.id, 30, request.headers['user-agent']);
      return { user, token: session.token, expiresAt: session.expiresAt };
    }),
  );

  app.post(
    '/api/auth/logout',
    handler(async (request) => {
      const header = request.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (header) await usersRepo.revokeSession(header);
      return { ok: true };
    }),
  );

  app.get(
    '/api/auth/me',
    handler(async (request) => ({ user: await requireUser(request) })),
  );
}
