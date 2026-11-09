import { PipelineError } from '@xbam/shared';
import { safeFetch } from '@xbam/upstream';
import type { ChannelContext } from '../contract';

/**
 * Talking to a Bluesky server over the AT Protocol's HTTP API (XRPC).
 *
 * Everything here is plain HTTPS to the account's own server (its PDS), which
 * proxies the `app.bsky.*` reads to the AppView on its behalf. There is no
 * browser anywhere in this channel.
 *
 * ### Secrets, and where each one lives
 *
 * The **app password** is sealed in `account_credentials` and arrives here only
 * through `ctx.credentials()`, for the length of one `createSession` call. It is
 * never kept, never put in an error, and the request body that carries it is
 * never echoed into one.
 *
 * The **session tokens** it buys (`accessJwt`, `refreshJwt`) are kept in this
 * process's memory and nowhere else. They are not written to the database: a
 * restart costs one `createSession`, and that is far cheaper than a bearer
 * token sitting in a table. Bluesky limits `createSession` to a few dozen a
 * day per account, so the cache is also what keeps a busy agent under it.
 *
 * ### What counts as a challenge
 *
 * `AuthFactorTokenRequired` is the server asking for a code it emailed. AI17Z
 * never answers one, here exactly as on X: the call stops, says so, and the
 * account waits for a person. App passwords skip that step, which is the reason
 * the account is linked with one.
 */

export const DEFAULT_SERVICE_URL = 'https://bsky.social';

/**
 * The one origin a development server may be reached on over plain http.
 *
 * The same arrangement as `AI17Z_STUDIO_UNSAFE_DEV_ORIGIN`: an exact origin,
 * named by the person running the process, and the only way to reach a server
 * that is not https on the public internet. Used by the tests, which talk to a
 * fixture server on loopback and never to the real network.
 */
export const UNSAFE_DEV_ORIGIN_ENV = 'AI17Z_BLUESKY_UNSAFE_DEV_ORIGIN';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_500_000;

export interface ServiceTarget {
  origin: string;
  /** True only for the development origin; lets the fetch reach loopback. */
  allowPrivate: boolean;
}

/**
 * Which server an account lives on.
 *
 * `settings.bluesky.serviceUrl` for an account on its own server, otherwise
 * bsky.social. Only an origin is kept: a path on a PDS URL means nothing, and
 * one with credentials in it is refused rather than stripped.
 */
export function serviceTargetFor(
  settings: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceTarget {
  const bluesky = (settings?.bluesky ?? null) as { serviceUrl?: unknown } | null;
  const raw = typeof bluesky?.serviceUrl === 'string' && bluesky.serviceUrl.trim() ? bluesky.serviceUrl.trim() : DEFAULT_SERVICE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw PipelineError.permanent('bluesky_service_url', `"${raw.slice(0, 80)}" is not a server address.`);
  }
  if (url.username || url.password) {
    throw PipelineError.permanent('bluesky_service_url', 'A server address must not carry a name or password.');
  }

  const dev = env[UNSAFE_DEV_ORIGIN_ENV]?.trim();
  if (dev) {
    try {
      if (new URL(dev).origin === url.origin) return { origin: url.origin, allowPrivate: true };
    } catch {
      // A malformed development origin is ignored rather than guessed at.
    }
  }
  if (url.protocol !== 'https:') {
    throw PipelineError.permanent('bluesky_service_url', 'A Bluesky server is reached over https only.');
  }
  return { origin: url.origin, allowPrivate: false };
}

/** What a server said when it refused, never what was sent to it. */
export class BlueskyApiError extends Error {
  readonly status: number;
  /** The protocol's own name for it: `ExpiredToken`, `RecordNotFound`, and so on. */
  readonly code: string | null;
  readonly retryAfterMs: number | null;

  constructor(status: number, code: string | null, message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'BlueskyApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The request never produced an answer: the outcome of a write is not known. */
export class BlueskyTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BlueskyTransportError';
  }
}

export interface XrpcOptions {
  method?: 'GET' | 'POST';
  /** Query parameters. An array repeats the key, which is how `uris` is sent. */
  params?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  bearer?: string;
}

function retryAfterOf(headers: Headers, now = Date.now()): number | null {
  const reset = Number(headers.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1_000 - now;
    if (ms > 0) return Math.min(ms, 60 * 60_000);
  }
  const after = Number(headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1_000, 60 * 60_000);
  return null;
}

/** One XRPC call. Throws `BlueskyApiError` for a refusal, `BlueskyTransportError` for silence. */
export async function xrpc<T>(target: ServiceTarget, nsid: string, options: XrpcOptions = {}): Promise<T> {
  const url = new URL(`/xrpc/${nsid}`, target.origin);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;

  let response;
  try {
    response = await safeFetch(url.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      allowPrivate: target.allowPrivate,
      // The request carries a bearer token meant for this server. A redirect
      // would carry it wherever the redirect pointed.
      noRedirects: true,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    // The message of a transport failure names the host and the reason, never
    // the body, so the app password in a createSession call cannot leak here.
    throw new BlueskyTransportError(
      `Bluesky did not answer ${nsid}: ${error instanceof Error ? error.message : 'the request failed'}.`,
      error,
    );
  }

  let parsed: unknown = null;
  if (response.text) {
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = null;
    }
  }

  if (response.status >= 200 && response.status < 300) return (parsed ?? {}) as T;

  const body = (parsed ?? {}) as { error?: unknown; message?: unknown };
  throw new BlueskyApiError(
    response.status,
    typeof body.error === 'string' ? body.error : null,
    typeof body.message === 'string' && body.message ? body.message.slice(0, 300) : `HTTP ${response.status}`,
    retryAfterOf(response.headers),
  );
}

// -- Sessions ---------------------------------------------------------------

export interface BlueskySession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
  /** `takendown`, `suspended` or `deactivated` when the account is not usable. */
  status: string | null;
}

/** In memory only, keyed by account. See the note at the top of this file. */
const sessions = new Map<string, BlueskySession>();
/** One sign-in in flight per account, so two callers arriving together make one. */
const signingIn = new Map<string, Promise<BlueskySession>>();

export function forgetBlueskySession(accountId: string): void {
  sessions.delete(accountId);
  signingIn.delete(accountId);
}

/** Tests only: a fresh process has no sessions. */
export function resetBlueskySessionsForTest(): void {
  sessions.clear();
  signingIn.clear();
}

export function cachedSessionFor(accountId: string): BlueskySession | null {
  return sessions.get(accountId) ?? null;
}

interface SessionResponse {
  accessJwt?: unknown;
  refreshJwt?: unknown;
  did?: unknown;
  handle?: unknown;
  status?: unknown;
  active?: unknown;
}

function sessionFrom(body: SessionResponse): BlueskySession {
  if (
    typeof body.accessJwt !== 'string' ||
    typeof body.refreshJwt !== 'string' ||
    typeof body.did !== 'string' ||
    typeof body.handle !== 'string'
  ) {
    throw PipelineError.retryable('bluesky_bad_session', 'Bluesky answered a sign-in with something that was not a session.');
  }
  return {
    accessJwt: body.accessJwt,
    refreshJwt: body.refreshJwt,
    did: body.did,
    handle: body.handle,
    status: typeof body.status === 'string' ? body.status : body.active === false ? 'deactivated' : null,
  };
}

/**
 * Turns what a server or the network said into a classified failure.
 *
 * Failures are classified, never guessed: a refusal that retrying cannot fix is
 * permanent, a limit is retryable with the stated wait, and silence is retryable
 * for a read and handled by the caller for a write.
 */
export function classifyBlueskyError(error: unknown, what: string): PipelineError {
  if (error instanceof PipelineError) return error;
  if (error instanceof BlueskyApiError) {
    if (error.status === 429) {
      // The words "rate limited" and "429" are what the capacity breaker
      // recognises as pushback; keep both in the sentence.
      return PipelineError.retryable(
        'bluesky_rate_limited',
        `Bluesky rate limited (429) ${what}. It will be asked again after the wait it stated.`,
        error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs },
      );
    }
    if (error.status >= 500) {
      return PipelineError.retryable('bluesky_unavailable', `Bluesky had a problem (${error.status}) ${what}.`);
    }
    if (error.code === 'RecordNotFound' || error.code === 'NotFound' || error.status === 404) {
      return PipelineError.permanent('bluesky_not_found', `${what}: Bluesky has no such record.`);
    }
    if (error.code === 'ExpiredToken' || error.code === 'InvalidToken' || error.status === 401) {
      return PipelineError.permanent('bluesky_auth_failed', `Bluesky no longer accepts this account's session (${what}).`);
    }
    return PipelineError.permanent('bluesky_refused', `Bluesky refused ${what}: ${error.message}`);
  }
  if (error instanceof BlueskyTransportError) {
    return PipelineError.retryable('bluesky_unreachable', error.message, {}, error);
  }
  return PipelineError.retryable(
    'bluesky_unexpected',
    `Something unexpected stopped ${what}: ${error instanceof Error ? error.message : String(error)}`,
    {},
    error,
  );
}

/**
 * Signs in with the stored app password. Always asks the server, so connecting
 * with new details is a real test of them; the cached path is `ensureSession`.
 */
export async function createSession(ctx: ChannelContext, target: ServiceTarget): Promise<BlueskySession> {
  const accountId = ctx.account.id;
  const existing = signingIn.get(accountId);
  if (existing) return existing;

  const attempt = (async () => {
    const credentials = ctx.credentials ? await ctx.credentials() : null;
    if (!credentials) {
      throw PipelineError.permanent(
        'bluesky_no_credentials',
        'No app password is stored for this Bluesky account. Add one in the account settings.',
      );
    }
    try {
      const body = await xrpc<SessionResponse>(target, 'com.atproto.server.createSession', {
        method: 'POST',
        body: { identifier: credentials.loginUsername, password: credentials.loginPassword },
      });
      const session = sessionFrom(body);
      sessions.set(accountId, session);
      return session;
    } catch (error) {
      sessions.delete(accountId);
      if (error instanceof BlueskyApiError) {
        if (error.code === 'AuthFactorTokenRequired') {
          throw PipelineError.permanent(
            'bluesky_auth_challenge',
            'Bluesky is asking for a sign-in code it emailed. AI17Z never answers a security challenge; link the account with an app password instead.',
            { challengeKind: 'EMAIL_CODE' },
          );
        }
        if (error.code === 'AccountTakedown' || error.code === 'AccountDeactivated') {
          throw PipelineError.permanent('bluesky_account_unavailable', `Bluesky says this account is not available (${error.code}).`);
        }
        if (error.status === 400 || error.status === 401) {
          throw PipelineError.permanent(
            'bluesky_auth_failed',
            'Bluesky did not accept the handle and app password stored for this account. Create a new app password and store it again.',
          );
        }
      }
      throw classifyBlueskyError(error, 'signing in');
    }
  })();

  signingIn.set(accountId, attempt);
  try {
    return await attempt;
  } finally {
    signingIn.delete(accountId);
  }
}

export async function ensureSession(ctx: ChannelContext, target: ServiceTarget): Promise<BlueskySession> {
  return cachedSessionFor(ctx.account.id) ?? createSession(ctx, target);
}

async function refreshSession(ctx: ChannelContext, target: ServiceTarget, session: BlueskySession): Promise<BlueskySession> {
  const body = await xrpc<SessionResponse>(target, 'com.atproto.server.refreshSession', {
    method: 'POST',
    bearer: session.refreshJwt,
  });
  const next = sessionFrom(body);
  sessions.set(ctx.account.id, next);
  return next;
}

function tokenWasRefused(error: unknown): boolean {
  return (
    error instanceof BlueskyApiError &&
    (error.code === 'ExpiredToken' || error.code === 'InvalidToken' || error.status === 401)
  );
}

/**
 * An authenticated call, renewing the session once if the server says it ended.
 *
 * A write is safe to repeat after a renewal: the server turned the request away
 * for its token before doing anything, so nothing happened the first time.
 */
export async function authed<T>(
  ctx: ChannelContext,
  target: ServiceTarget,
  nsid: string,
  options: Omit<XrpcOptions, 'bearer'> = {},
): Promise<T> {
  let session = await ensureSession(ctx, target);
  try {
    return await xrpc<T>(target, nsid, { ...options, bearer: session.accessJwt });
  } catch (error) {
    if (!tokenWasRefused(error)) throw error;
  }

  try {
    session = await refreshSession(ctx, target, session);
  } catch (error) {
    // The refresh token is gone too. Signing in again is the only way back, and
    // it is allowed exactly once per call.
    if (!tokenWasRefused(error) && !(error instanceof PipelineError)) throw error;
    forgetBlueskySession(ctx.account.id);
    session = await createSession(ctx, target);
  }
  return xrpc<T>(target, nsid, { ...options, bearer: session.accessJwt });
}

/** Ends the session on the server, so a disconnected account leaves no live token behind. */
export async function endSession(ctx: ChannelContext, target: ServiceTarget): Promise<void> {
  const session = cachedSessionFor(ctx.account.id);
  forgetBlueskySession(ctx.account.id);
  if (!session) return;
  await xrpc(target, 'com.atproto.server.deleteSession', { method: 'POST', bearer: session.refreshJwt }).catch(() => undefined);
}
