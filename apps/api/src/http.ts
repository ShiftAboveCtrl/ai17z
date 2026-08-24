import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { UnauthorizedError, XbamError, createLogger } from '@xbam/shared';
import type { ApiResponse } from '@xbam/shared/contracts';
import { users as usersRepo, type UserRow } from '@xbam/database';

const log = createLogger('api');

export function ok<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  const body: ApiResponse<T> = { ok: true, data };
  return reply.status(status).send(body);
}

/** Single place that turns a thrown error into the API error envelope. */
export function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof XbamError) {
    return reply.status(error.status).send({
      ok: false,
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request body did not match the expected shape.',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error('unhandled api error', { message });
  return reply.status(500).send({
    ok: false,
    error: { code: 'INTERNAL', message: 'Something went wrong handling this request.' },
  });
}

/** Wraps a handler so every route shares the same error envelope. */
export function handler<T>(fn: (request: FastifyRequest, reply: FastifyReply) => Promise<T>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    try {
      const data = await fn(request, reply);
      if (reply.sent) return reply;
      return ok(reply, data);
    } catch (error) {
      return fail(reply, error);
    }
  };
}

export function parseBody<S extends ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> {
  return schema.parse(request.body ?? {});
}

export function parseQuery<S extends ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> {
  return schema.parse(request.query ?? {});
}

export function params(request: FastifyRequest): Record<string, string> {
  return (request.params ?? {}) as Record<string, string>;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/** Resolves the caller, or throws. Every route except auth/health uses this. */
export async function requireUser(request: FastifyRequest): Promise<UserRow> {
  const token = bearerToken(request);
  if (!token) throw new UnauthorizedError();
  const user = await usersRepo.resolveSession(token);
  if (!user) throw new UnauthorizedError('Session expired or invalid.');
  return user;
}

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
