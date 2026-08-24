import type { ApiErrorCode } from './contracts/api';
import type { ErrorClass } from './contracts/enums';

/** Base class for everything XBAM throws deliberately. */
export class XbamError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, status = 500, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class BadRequestError extends XbamError {
  constructor(message: string, details?: unknown) {
    super('BAD_REQUEST', message, 400, details);
  }
}
export class ValidationError extends XbamError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', message, 422, details);
  }
}
export class UnauthorizedError extends XbamError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message, 401);
  }
}
export class ForbiddenError extends XbamError {
  constructor(message = 'Not permitted') {
    super('FORBIDDEN', message, 403);
  }
}
export class NotFoundError extends XbamError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`, 404);
  }
}
export class ConflictError extends XbamError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, 409, details);
  }
}
/** Thrown when the platform refuses to run because configuration is unsafe. */
export class UnsafeConfigurationError extends XbamError {
  constructor(message: string, details?: unknown) {
    super('UNSAFE_CONFIGURATION', message, 400, details);
  }
}
export class UpstreamError extends XbamError {
  constructor(message: string, details?: unknown) {
    super('UPSTREAM_FAILED', message, 502, details);
  }
}

/**
 * A failure that carries an explicit retry classification. The pipeline never
 * guesses whether something is worth retrying: every failure path either throws
 * one of these or is wrapped by the step runner with a documented default.
 */
export class PipelineError extends Error {
  readonly errorClass: ErrorClass;
  readonly reason: string;
  readonly data: Record<string, unknown>;

  constructor(
    errorClass: ErrorClass,
    reason: string,
    message: string,
    data: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = 'PipelineError';
    this.errorClass = errorClass;
    this.reason = reason;
    this.data = data;
  }

  static retryable(reason: string, message: string, data?: Record<string, unknown>, cause?: unknown) {
    return new PipelineError('RETRYABLE', reason, message, data, { cause });
  }
  static permanent(reason: string, message: string, data?: Record<string, unknown>, cause?: unknown) {
    return new PipelineError('PERMANENT', reason, message, data, { cause });
  }
  static review(reason: string, message: string, data?: Record<string, unknown>, cause?: unknown) {
    return new PipelineError('REVIEW_REQUIRED', reason, message, data, { cause });
  }
}

export function isPipelineError(e: unknown): e is PipelineError {
  return e instanceof PipelineError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
