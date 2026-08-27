export interface CorpusFetchOptions {
  handle: string;
  /** How far back to go. */
  limit: number;
  /** Newest remote id already ingested, for incremental sync. */
  since?: string | null;
  includeReplies?: boolean;
  includeQuotes?: boolean;
  signal?: AbortSignal;
}

export interface RawCorpusItem {
  remoteId: string;
  text: string;
  url: string | null;
  itemKind: 'post' | 'reply' | 'quote' | 'unknown';
  createdAt: string | null;
  /** Whatever the source returned, kept as provenance. */
  raw: Record<string, unknown>;
}

export interface SourceAvailability {
  available: boolean;
  detail: string;
  /** What the owner would have to install or configure to make it work. */
  requirement: string | null;
}

/**
 * Where a persona corpus comes from.
 *
 * Deliberately narrow, and deliberately not the runtime's reply path. The live
 * X channel is driven by Playwright; this is a separate, optional way to learn
 * an identity from public material. If one implementation stops working, another
 * can replace it without touching persona logic.
 */
export interface PersonaSourceAdapter {
  readonly kind: 'x_public' | 'manual';
  readonly displayName: string;
  /** Whether this source can run here, right now. */
  availability(): Promise<SourceAvailability>;
  fetch(options: CorpusFetchOptions): Promise<RawCorpusItem[]>;
}
