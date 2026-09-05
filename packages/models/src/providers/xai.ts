/**
 * xAI.
 *
 * Ordinary generation is the OpenAI chat-completions shape, so that half is the
 * shared adapter and there is nothing to say about it. What is here is the half
 * that is not shared: xAI's Responses API can run its own search tools during a
 * call -- X's index and the open web -- and answer with citations.
 *
 * ## Why this is worth a separate path
 *
 * AI17Z already looks things up: a browser it has open, DexScreener, a search
 * engine. That covers the open web. It does **not** cover X's own index, which
 * a logged-out browser cannot search and a logged-in one can only search as the
 * agent's own account, slowly, through a UI that changes.
 *
 * ## The one thing that must not be got wrong
 *
 * A model asked to search X will write "posts on X suggest..." whether or not a
 * search ran. It is not a reliable witness to its own tool use, and prose is
 * not evidence of a lookup. `server_side_tool_usage` is: xAI counts only
 * executions that returned something, and bills on that count. So it is the
 * only field this adapter trusts to answer "did a search actually happen", and
 * everything downstream keys off the number rather than the answer.
 *
 * ## Shapes that differ between the two tools
 *
 * `x_search` takes its handle filters at the top level of the tool object.
 * `web_search` nests its domain filters under `filters`. Both reject a request
 * carrying an allow list and an exclude list at once. Read off the API docs
 * rather than assumed symmetric, because they are not.
 */
import { PipelineError } from '@xbam/shared';
import { postJson } from '../http';
import { createOpenAiCompatibleAdapter } from './openaiCompatible';
import type { ProviderAdapter } from '../types';
import type {
  ServerSideCitation,
  ServerSideSearchRequest,
  ServerSideSearchResult,
  ServerSideToolSelection,
} from '../serverSideTools';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

/** Exactly the keys xAI reports, so a rename upstream fails loudly rather than reading as zero. */
const USAGE_X_SEARCH = 'SERVER_SIDE_TOOL_X_SEARCH';
const USAGE_WEB_SEARCH = 'SERVER_SIDE_TOOL_WEB_SEARCH';

interface ResponsesApiReply {
  id?: string;
  /** Every source touched during the search, whether or not it was cited inline. */
  citations?: string[];
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
  server_side_tool_usage?: Record<string, number>;
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Builds the `tools` array, leaving out anything not asked for. */
export function buildTools(selection: ServerSideToolSelection): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [];

  if (selection.xSearch) {
    const x = selection.xSearch;
    const tool: Record<string, unknown> = { type: 'x_search' };
    // An allow list and an exclude list together is a 400 from xAI. The allow
    // list wins because it is the more specific instruction: somebody who named
    // the accounts to read meant those accounts.
    if (x.allowHandles?.length) tool.allowed_x_handles = x.allowHandles.slice(0, 20);
    else if (x.excludeHandles?.length) tool.excluded_x_handles = x.excludeHandles.slice(0, 20);
    if (x.fromDate) tool.from_date = x.fromDate;
    if (x.toDate) tool.to_date = x.toDate;
    // Off unless asked. Both cost more, and most questions are about words.
    if (x.images) tool.enable_image_understanding = true;
    if (x.video) tool.enable_video_understanding = true;
    tools.push(tool);
  }

  if (selection.webSearch) {
    const web = selection.webSearch;
    const tool: Record<string, unknown> = { type: 'web_search' };
    // Nested under `filters` here, unlike x_search. Not a symmetry mistake.
    const filters: Record<string, unknown> = {};
    if (web.allowDomains?.length) filters.allowed_domains = web.allowDomains.slice(0, 5);
    else if (web.excludeDomains?.length) filters.excluded_domains = web.excludeDomains.slice(0, 5);
    if (Object.keys(filters).length > 0) tool.filters = filters;
    if (web.images) tool.enable_image_understanding = true;
    tools.push(tool);
  }

  return tools;
}

/**
 * Strips the inline citation markers out of the model's prose.
 *
 * xAI writes sources into the text as `[[1]](https://...)`. Left in, they reach
 * the agent's reply and get posted to X, where they are meaningless. The URLs
 * are kept separately as citations, which is where they belong.
 */
export function stripInlineCitations(text: string): string {
  return text
    .replace(/\[\[\d+\]\]\([^)]*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Collects the sources.
 *
 * Both places xAI puts them: the top-level list of everything it touched, and
 * the inline annotations. Deduplicated by URL, order preserved.
 *
 * Note what is *not* taken from an annotation: its `title`. That field is the
 * citation's number -- "1", "2" -- not a headline, and using it would label
 * every source with a digit. The host is the only honest name available here.
 */
export function collectCitations(reply: ResponsesApiReply): ServerSideCitation[] {
  const urls: string[] = [...(reply.citations ?? [])];
  for (const item of reply.output ?? []) {
    for (const block of item.content ?? []) {
      for (const annotation of block.annotations ?? []) {
        if (annotation.type === 'url_citation' && annotation.url) urls.push(annotation.url);
      }
    }
  }

  const seen = new Set<string>();
  const citations: ServerSideCitation[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, domain: domainOf(url) });
  }
  return citations;
}

/** The visible answer, with every text block joined. */
export function collectText(reply: ResponsesApiReply): string {
  const parts: string[] = [];
  for (const item of reply.output ?? []) {
    if (item.type && item.type !== 'message') continue;
    for (const block of item.content ?? []) {
      if (block.type === 'output_text' && block.text) parts.push(block.text);
    }
  }
  return stripInlineCitations(parts.join('\n').trim());
}

export function readUsage(reply: ResponsesApiReply): { xSearch: number; webSearch: number } {
  const usage = reply.server_side_tool_usage ?? {};
  return {
    xSearch: Number(usage[USAGE_X_SEARCH] ?? 0) || 0,
    webSearch: Number(usage[USAGE_WEB_SEARCH] ?? 0) || 0,
  };
}

export async function searchWithServerSideTools(
  request: ServerSideSearchRequest,
): Promise<ServerSideSearchResult> {
  const tools = buildTools(request.tools);
  if (tools.length === 0) {
    // Calling with no tools would be an ordinary generation wearing this
    // function's name, and would report "nothing was searched" as if a search
    // had been attempted and found nothing.
    throw PipelineError.permanent('no_server_side_tools', 'No server-side search tools were selected.');
  }
  if (!request.apiKey) {
    throw PipelineError.permanent('no_api_key', 'xAI needs an API key to search.');
  }

  const base = (request.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const { data } = await postJson<ResponsesApiReply>({
    url: `${base}/responses`,
    headers: { authorization: `Bearer ${request.apiKey}` },
    body: {
      model: request.model,
      input: [{ role: 'user', content: request.question }],
      tools,
    },
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    providerLabel: 'xAI',
  });

  if (data.error?.message) {
    throw PipelineError.permanent('xai_error', `xAI refused the search: ${data.error.message}`);
  }

  return {
    text: collectText(data),
    citations: collectCitations(data),
    usage: readUsage(data),
    requestId: data.id ?? null,
    promptTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? null,
    completionTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? null,
    raw: data,
  };
}

/**
 * The adapter.
 *
 * Generation and health are the OpenAI-compatible implementation, unchanged --
 * xAI speaks that shape and there is nothing to gain from a second copy. The
 * search capability is added on top, so an adapter without it is simply an
 * adapter that cannot do this, and the runtime reports the feature unavailable
 * rather than falling back to a model call that would invent the answer.
 */
const base = createOpenAiCompatibleAdapter('xai', DEFAULT_BASE_URL, 'xAI');

export const xaiAdapter: ProviderAdapter = {
  ...base,
  searchWithServerSideTools,
};
