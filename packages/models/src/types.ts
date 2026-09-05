import type { ProviderVerdict } from './providerState';
import type { ServerSideSearchRequest, ServerSideSearchResult } from './serverSideTools';
import type { ChatMessage, ModelParameters, ProviderKind } from '@xbam/shared/contracts';

export interface ProviderRequest {
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  messages: ChatMessage[];
  parameters: ModelParameters;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  requestId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Provider-specific response body, kept only for the trace. */
  raw: unknown;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
  models?: string[];
  /**
   * What specifically happened, when the adapter can tell.
   *
   * Optional so an adapter that has nothing more to say than yes or no stays
   * valid; the gateway falls back to deriving one.
   */
  verdict?: ProviderVerdict;
}

/**
 * One normalised interface for every model provider. Agents are configured with
 * a provider credential plus a model name; nothing above this layer knows which
 * vendor is answering.
 */
export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly defaultBaseUrl: string;
  /** Whether a credential is mandatory. Ollama and mock run without one. */
  readonly requiresApiKey: boolean;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  health(request: Omit<ProviderRequest, 'messages' | 'parameters' | 'model'> & { model?: string }): Promise<ProviderHealth>;
  /**
   * Search run by the provider during the call, answering with citations.
   *
   * Optional, and absent on every adapter that cannot do it -- which is the
   * point. A provider without this offers no degraded version: asking an
   * ordinary model to "search X" gets a confident answer and no search, so the
   * capability is either present or the feature is reported unavailable.
   */
  searchWithServerSideTools?(request: ServerSideSearchRequest): Promise<ServerSideSearchResult>;
}
