import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { PipelineError, UnauthorizedError, XbamError, createLogger } from '@xbam/shared';
import type { ApiResponse } from '@xbam/shared/contracts';
import { users as usersRepo, type UserRow } from '@xbam/database';

const log = createLogger('api');

/** A field name a person would recognise, from a Zod path. */
function fieldLabel(path: (string | number)[]): string {
  const name = path.filter((p) => typeof p === 'string').join(' ') || 'A field';
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * One sentence a person can act on, from whatever Zod complained about.
 *
 * Length is spelled out because it is the common case and the one nobody can
 * diagnose by eye: the difference between 2,000 and 2,341 characters is not
 * something anybody can see in a text box.
 */
function describeIssues(issues: z.ZodIssue[]): string {
  const first = issues[0];
  if (!first) return 'That could not be saved.';

  if (first.code === 'too_big' && typeof first.maximum === 'number' && first.type === 'string') {
    const received = (first as { received?: unknown }).received;
    const actual = typeof received === 'number' ? received : null;
    const over = actual !== null ? actual - first.maximum : null;
    return (
      `${fieldLabel(first.path)} is too long. ` +
      (actual !== null ? `It is ${actual.toLocaleString()} characters and the most allowed is ${first.maximum.toLocaleString()}. ` : `The most allowed is ${first.maximum.toLocaleString()}. `) +
      (over !== null && over > 0 ? `Remove at least ${over.toLocaleString()}.` : '')
    ).trim();
  }

  if (first.code === 'too_small' && first.minimum === 1) {
    return `${fieldLabel(first.path)} cannot be empty.`;
  }

  const rest = issues.length > 1 ? ` (and ${issues.length - 1} other problem${issues.length === 2 ? '' : 's'})` : '';
  return `${fieldLabel(first.path)}: ${first.message}${rest}`;
}

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
  // A pipeline error already carries a class and a sentence written for a
  // person -- "this agent has no usable model configured, add a provider and
  // set a primary model" -- and turning that into "something went wrong" throws
  // away the only useful part. Which is what happened the first time anything
  // in the runtime was called straight from a route.
  //
  // PERMANENT is the caller's problem to fix, so 409. RETRYABLE and
  // REVIEW_REQUIRED are the system's, so 503: try again, nothing is wrong with
  // what you asked.
  if (error instanceof PipelineError) {
    const status = error.errorClass === 'PERMANENT' ? 409 : 503;
    return reply.status(status).send({
      ok: false,
      error: { code: error.reason.toUpperCase(), message: error.message },
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        // Name the field and the overage. "The request body did not match the
        // expected shape" is true and useless: somebody who wrote a long
        // personality and pressed save learns nothing from it, and has no way
        // to find out which of eleven fields was too long or by how much.
        message: describeIssues(error.issues),
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
  const input = request.body ?? {};
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  // Zod says what the maximum was but not what was sent, and "too long" without
  // a number is not something anybody can act on. The value is right here, so
  // the actual length is measured and carried on the issue.
  throw withActualSizes(result.error, input);
}

/** Records how long each offending string actually was. */
function withActualSizes(error: z.ZodError, input: unknown): z.ZodError {
  for (const issue of error.issues) {
    if (issue.code !== 'too_big') continue;
    const value = valueAt(input, issue.path);
    if (typeof value === 'string') (issue as { received?: number }).received = value.length;
  }
  return error;
}

function valueAt(input: unknown, path: (string | number)[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
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
