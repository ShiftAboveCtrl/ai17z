import { PipelineError } from '@xbam/shared';

export interface JsonRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  providerLabel: string;
}

/** Status codes worth retrying. Anything else is a configuration or content problem. */
export function classifyHttpStatus(status: number): 'RETRYABLE' | 'PERMANENT' {
  if (status === 408 || status === 409 || status === 425 || status === 429) return 'RETRYABLE';
  if (status >= 500) return 'RETRYABLE';
  return 'PERMANENT';
}

export async function postJson<T>(request: JsonRequest): Promise<{ data: T; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const onOuterAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onOuterAbort);

  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(request.headers ?? {}) },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      const errorClass = classifyHttpStatus(response.status);
      const snippet = text.slice(0, 800);
      throw new PipelineError(
        errorClass,
        `http_${response.status}`,
        `${request.providerLabel} returned ${response.status}: ${snippet}`,
        { status: response.status, provider: request.providerLabel },
      );
    }
    let data: T;
    try {
      data = text ? (JSON.parse(text) as T) : ({} as T);
    } catch (error) {
      throw PipelineError.retryable(
        'invalid_json',
        `${request.providerLabel} returned a response that is not valid JSON.`,
        { snippet: text.slice(0, 300) },
        error,
      );
    }
    return { data, headers: response.headers };
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    const message = (error as Error).message ?? String(error);
    if ((error as Error).name === 'AbortError') {
      throw PipelineError.retryable('timeout', `${request.providerLabel} timed out after ${request.timeoutMs}ms.`);
    }
    throw PipelineError.retryable('network', `${request.providerLabel} network error: ${message}`, {}, error);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onOuterAbort);
  }
}
