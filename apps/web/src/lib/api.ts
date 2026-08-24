import type { ApiResponse } from '@xbam/shared/contracts';

const BASE = (import.meta.env.VITE_XBAM_API_URL ?? '').replace(/\/+$/, '');
const TOKEN_KEY = 'xbam.session';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private-mode browsers block storage; the session simply will not persist.
  }
}

/** Structured failure so the UI can show the real reason, not "500". */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      'NETWORK',
      'Could not reach the XBAM API. Check that the api service is running.',
      0,
    );
  }

  if (response.status === 401) {
    setToken(null);
    throw new ApiError('UNAUTHORIZED', 'Your session expired. Sign in again.', 401);
  }

  const text = await response.text();
  let payload: ApiResponse<T> | null = null;
  try {
    payload = text ? (JSON.parse(text) as ApiResponse<T>) : null;
  } catch {
    throw new ApiError('INTERNAL', `The API returned an unreadable response (${response.status}).`, response.status);
  }
  if (!payload) throw new ApiError('INTERNAL', 'The API returned an empty response.', response.status);
  if (!payload.ok) {
    throw new ApiError(payload.error.code, payload.error.message, response.status, payload.error.details);
  }
  return payload.data;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** Artifact URLs need the token, so they are fetched as blobs rather than linked. */
export async function artifactObjectUrl(artifactId: string): Promise<string> {
  const token = getToken();
  const response = await fetch(`${BASE}/api/artifacts/${artifactId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new ApiError('NOT_FOUND', 'That screenshot is no longer available.', response.status);
  return URL.createObjectURL(await response.blob());
}
