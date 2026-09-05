/**
 * Searching that happens inside the model call.
 *
 * Most of what an agent looks up, AI17Z looks up itself: a browser it already
 * has open, a market API, a search engine. Some providers can do it on their
 * own side instead -- the model decides what to search for, runs it, and
 * answers with citations.
 *
 * That is a genuinely different capability rather than a faster version of the
 * same one. It reaches X's own index, which a logged-out browser cannot, and it
 * needs no session, no tab and no Chrome. What it costs is control: AI17Z does
 * not choose the query and cannot see the search that ran, only what came back.
 *
 * So it is modelled as an optional thing an adapter *may* be able to do, not as
 * a field on every request. An adapter that cannot do this simply does not
 * implement it, and the feature is reported unavailable rather than silently
 * degrading to an ordinary model call that invents an answer.
 */

/** Which of a provider's own tools to allow for one call. */
export interface ServerSideToolSelection {
  /** Search X's own index. */
  xSearch?: {
    /**
     * Up to twenty handles to search within. Mutually exclusive with
     * `excludeHandles` -- xAI rejects a request carrying both.
     */
    allowHandles?: string[];
    excludeHandles?: string[];
    /** ISO dates, YYYY-MM-DD. */
    fromDate?: string;
    toDate?: string;
    /** Costs more and is only worth it when the question is about a picture. */
    images?: boolean;
    video?: boolean;
  };
  /** Search the open web. */
  webSearch?: {
    /** Up to five domains. Mutually exclusive with `excludeDomains`. */
    allowDomains?: string[];
    excludeDomains?: string[];
    images?: boolean;
  };
}

export interface ServerSideSearchRequest {
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  /** The question, in the agent's own words. The model derives its own queries. */
  question: string;
  tools: ServerSideToolSelection;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One source the provider says it used. */
export interface ServerSideCitation {
  url: string;
  /** The host, which is the only honest title available -- see the note below. */
  domain: string | null;
}

export interface ServerSideSearchResult {
  /** What the model wrote, citations stripped out of the prose. */
  text: string;
  citations: ServerSideCitation[];
  /**
   * Successful tool executions, by tool.
   *
   * This is the whole point of the type. The provider's prose will happily say
   * "according to posts on X" whether or not a search ran, and the model is not
   * a reliable witness to its own tool use. `server_side_tool_usage` counts only
   * executions that returned something -- it is what the provider bills on --
   * so it is the one field that can answer "did this actually search X".
   *
   * Zero or missing means no search happened, and nothing downstream may claim
   * one did.
   */
  usage: { xSearch: number; webSearch: number };
  requestId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  raw: unknown;
}
