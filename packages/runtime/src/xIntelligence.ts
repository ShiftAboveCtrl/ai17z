/**
 * Asking the provider to search, and refusing to overstate what came back.
 *
 * AI17Z already looks things up for itself -- the browser it has open, a market
 * API, a search engine. This adds the one source those cannot reach: X's own
 * index. A logged-out browser cannot search it, and a logged-in one can only
 * search as the agent's own account, slowly, through a UI that changes weekly.
 *
 * ## Everything here exists to keep one promise
 *
 * **An agent never says it searched X unless a search actually ran.**
 *
 * That promise is hard for an uncomfortable reason: a model asked to search
 * will write "posts on X suggest..." whether or not it searched. It is not a
 * reliable witness to its own tool use, and its prose is not evidence. The
 * provider does supply evidence -- `server_side_tool_usage` counts executions
 * that returned something, and is what it bills on -- so that count, and never
 * the answer, decides whether anything is passed on.
 *
 * A call that returns beautiful prose and a usage count of zero produces no
 * findings at all, and a recorded gap saying the search did not run. The model
 * writing the reply is then told it could not check, and says so.
 *
 * ## What comes back is evidence, not knowledge
 *
 * Same rule as every other lookup. Each finding keeps the name of its source
 * and the moment it was read, the prompt says it was looked up rather than
 * known, and a failure is reported rather than hidden. An agent that launders a
 * search result into its own voice states a wrong one exactly as confidently as
 * a right one.
 */
import { createLogger, errorMessage } from '@xbam/shared';
import { getAdapter } from '@xbam/models';
import type { ServerSideSearchResult, ServerSideToolSelection } from '@xbam/models';
import { providers as providersRepo } from '@xbam/database';
import type { Finding } from './research';

const log = createLogger('x-intelligence');

/** Named so a person reading a trace or a prompt knows exactly what ran. */
export const X_SEARCH_SOURCE = 'X search (xAI)';
export const WEB_SEARCH_SOURCE = 'Web search (xAI)';

/**
 * How long one provider-side search may take.
 *
 * Longer than a plain completion, because the provider is running searches
 * inside the call, and shorter than the whole research budget so a slow one
 * cannot eat the step by itself.
 */
export const X_INTELLIGENCE_TIMEOUT_MS = 45_000;

export interface XIntelligenceRequest {
  /** The credential to spend. Must belong to a provider that can do this. */
  credentialId: string;
  model: string;
  /** The question in the agent's own words -- the model derives its own queries. */
  question: string;
  tools: ServerSideToolSelection;
  timeoutMs?: number;
}

export interface XIntelligenceResult {
  findings: Finding[];
  /** Empty unless something stopped a search from happening. */
  failed: { query: string; reason: string }[];
  /** Successful executions, from the provider's own billing counter. */
  usage: { xSearch: number; webSearch: number };
  /** Said in words, for the trace. */
  note: string;
}

/**
 * Whether this credential and model can search on the provider's side.
 *
 * Deliberately not a table of model names. A list of "models that support
 * tools" is wrong within a month and fails closed in the worst way -- silently
 * dropping a capability somebody paid for. The adapter either implements the
 * capability or it does not, and whether a particular model honours it is
 * answered by calling it and reading the usage counter.
 */
export async function canSearchServerSide(credentialId: string): Promise<boolean> {
  const credential = await providersRepo.getProvider(credentialId);
  if (!credential) return false;
  return typeof getAdapter(credential.provider).searchWithServerSideTools === 'function';
}

/**
 * Turns citations into findings.
 *
 * The model's prose is the summary and the citations are where it came from --
 * which is the right way round. A citation on its own is a URL with no claim
 * attached, and a claim with no URL is an assertion.
 *
 * Every finding carries the same summary because that is honest: the provider
 * does not say which sentence came from which source, and splitting the text up
 * to make it look otherwise would be inventing attribution.
 */
export function findingsFrom(
  result: ServerSideSearchResult,
  question: string,
  source: string,
  retrievedAt = new Date().toISOString(),
): Finding[] {
  const summary = result.text.trim();
  if (!summary) return [];

  if (result.citations.length === 0) {
    // An answer with no sources. Kept, because the search did run and the
    // provider had something to say, but recorded as uncited so the prompt can
    // weigh it accordingly.
    return [
      {
        kind: 'search',
        query: question,
        source: `${source}, uncited`,
        title: question,
        summary,
        url: null,
        retrievedAt,
      },
    ];
  }

  return result.citations.slice(0, 6).map((citation) => ({
    kind: 'search' as const,
    query: question,
    source,
    // The domain, because that is the only honest name available: xAI's
    // annotation "title" is the citation's number, not a headline.
    title: citation.domain ?? citation.url,
    summary,
    url: citation.url,
    retrievedAt,
  }));
}

/**
 * Runs the search.
 *
 * Returns findings only when the provider says a search executed. Everything
 * else -- no capability, no key, an error, a confident answer with a usage
 * count of zero -- comes back as a recorded gap.
 */
export async function searchWithProvider(request: XIntelligenceRequest): Promise<XIntelligenceResult> {
  const credential = await providersRepo.getProvider(request.credentialId);
  if (!credential) {
    return gap(request.question, 'That provider credential no longer exists.');
  }

  const adapter = getAdapter(credential.provider);
  if (!adapter.searchWithServerSideTools) {
    return gap(request.question, `${credential.provider} cannot search on its own side.`);
  }

  const apiKey = await providersRepo.getDecryptedApiKey(request.credentialId);
  if (!apiKey) {
    return gap(request.question, 'That provider has no API key, so nothing could be searched.');
  }

  let result: ServerSideSearchResult;
  try {
    result = await adapter.searchWithServerSideTools({
      baseUrl: credential.baseUrl ?? null,
      apiKey,
      model: request.model,
      question: request.question,
      tools: request.tools,
      timeoutMs: request.timeoutMs ?? X_INTELLIGENCE_TIMEOUT_MS,
    });
  } catch (error) {
    // Reported, never swallowed. A lookup that failed is something the model
    // must be told about, so it says it could not check rather than answering
    // from a training set.
    const reason = errorMessage(error);
    log.warn('a provider-side search failed', { provider: credential.provider, message: reason });
    return gap(request.question, reason);
  }

  const searched = result.usage.xSearch + result.usage.webSearch;
  if (searched === 0) {
    // The case this whole module is shaped around. There is an answer, it reads
    // like research, and no search ran -- so it is thrown away rather than
    // passed on as something that was looked up.
    log.info('a provider-side search returned an answer without searching', {
      provider: credential.provider,
      model: request.model,
    });
    return gap(
      request.question,
      'The model answered without running a search, so nothing here was actually looked up.',
    );
  }

  const findings = [
    ...(result.usage.xSearch > 0 ? findingsFrom(result, request.question, X_SEARCH_SOURCE) : []),
  ];
  // Only one set of findings: the answer is one piece of prose whichever tools
  // produced it, and emitting it twice would double its apparent weight.
  if (findings.length === 0 && result.usage.webSearch > 0) {
    findings.push(...findingsFrom(result, request.question, WEB_SEARCH_SOURCE));
  }

  return {
    findings,
    failed: [],
    usage: result.usage,
    note: describeUsage(result.usage),
  };
}

function gap(question: string, reason: string): XIntelligenceResult {
  return {
    findings: [],
    failed: [{ query: question, reason }],
    usage: { xSearch: 0, webSearch: 0 },
    note: reason,
  };
}

/** The sentence a trace shows. Counts, because "searched X" without one is a claim. */
export function describeUsage(usage: { xSearch: number; webSearch: number }): string {
  const parts: string[] = [];
  if (usage.xSearch > 0) parts.push(`${usage.xSearch} X ${usage.xSearch === 1 ? 'search' : 'searches'}`);
  if (usage.webSearch > 0) parts.push(`${usage.webSearch} web ${usage.webSearch === 1 ? 'search' : 'searches'}`);
  if (parts.length === 0) return 'No search ran.';
  return `${parts.join(' and ')} ran on the provider's side.`;
}

/**
 * The credential and model an agent uses for this, or nothing.
 *
 * Read from the `research` model role, which has a row on the Intelligence
 * screen -- a role nothing can set is a capability the product does not have.
 * Returns null rather than falling back to the primary: sending this to a model
 * that cannot search gets a confident answer and no search, which is the exact
 * failure the whole module exists to prevent.
 */
export async function researchModelFor(
  agentId: string,
): Promise<{ credentialId: string; model: string } | null> {
  const configs = await providersRepo.listModelConfigs(agentId);
  const config = configs.find((c) => c.role === 'research');
  if (!config) return null;
  if (!(await canSearchServerSide(config.providerCredentialId))) return null;
  return { credentialId: config.providerCredentialId, model: config.model };
}

/** Why this agent cannot use it, in a sentence somebody can act on. */
export async function whyUnavailable(agentId: string): Promise<string | null> {
  const configs = await providersRepo.listModelConfigs(agentId);
  const config = configs.find((c) => c.role === 'research');
  if (!config) {
    return 'No research model is set. Choose one under Intelligence, on a provider that can search on its own side.';
  }
  if (!(await canSearchServerSide(config.providerCredentialId))) {
    const credential = await providersRepo.getProvider(config.providerCredentialId);
    return `The research model is on ${credential?.provider ?? 'a provider'}, which cannot search on its own side. xAI can.`;
  }
  return null;
}
