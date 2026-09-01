import { z } from 'zod';

/** Every API response uses this envelope. No bare payloads, no bare errors. */
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'UNSAFE_CONFIGURATION',
  'UPSTREAM_FAILED',
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int(), limit: z.number().int(), offset: z.number().int() });

export type Page<T> = { items: T[]; total: number; limit: number; offset: number };

export const LoginInput = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const BootstrapOwnerInput = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8, 'at least 8 characters').max(200),
  displayName: z.string().trim().min(1).max(120),
});
export type BootstrapOwnerInput = z.infer<typeof BootstrapOwnerInput>;

export const InjectMockEventInput = z.object({
  agentId: z.string().uuid(),
  accountId: z.string().uuid().optional(),
  authorHandle: z.string().trim().min(1).max(120).default('test_user'),
  text: z.string().trim().min(1).max(10_000),
  parentText: z.string().max(10_000).default(''),
  conversationRef: z.string().max(200).default(''),
  remoteEventId: z.string().max(200).optional(),
  dryRun: z.boolean().optional(),
});
export type InjectMockEventInput = z.infer<typeof InjectMockEventInput>;

export const ApproveJobInput = z.object({
  editedOutput: z.string().max(20_000).optional(),
  note: z.string().max(1_000).optional(),
});
export type ApproveJobInput = z.infer<typeof ApproveJobInput>;

export const HealthComponent = z.object({
  name: z.string(),
  status: z.enum(['healthy', 'degraded', 'offline', 'unknown']),
  detail: z.string().nullable(),
  optional: z.boolean(),
  /**
   * What sort of thing this is.
   *
   * `optional` says whether a fault here makes the platform unhealthy. It does
   * not say what the component is, and reading it as though it did produced a
   * false pass on the one screen a newcomer relies on: with nothing configured
   * at all, the doctor counted the single optional component -- the browser --
   * and reported "AI providers: 1 configured". A fresh installation was told it
   * had a model when it had none, which points somebody away from the first
   * thing they have to do.
   */
  kind: z.enum(['core', 'provider', 'account', 'browser']).default('core'),
  checkedAt: z.string(),
});
export type HealthComponent = z.infer<typeof HealthComponent>;

export const HealthReport = z.object({
  status: z.enum(['healthy', 'degraded', 'offline']),
  components: z.array(HealthComponent),
  checkedAt: z.string(),
});
export type HealthReport = z.infer<typeof HealthReport>;
