import { accounts as accountsRepo, agents as agentsRepo, deliberation as mind, type AttentionRow } from '@xbam/database';
import { createLogger, errorMessage } from '@xbam/shared';
import { getChannelAdapter } from '@xbam/channels';
import { buildChannelContext } from './channelContext';
import { research, whatToResearch, type Finding, type Lookup, type SearchFn } from './research';

const log = createLogger('curiosity');

/**
 * Going and finding out.
 *
 * The one place deliberation does something rather than only think about it.
 * An agent that keeps a list of things it does not understand and never looks
 * any of them up is not curious, it is merely uncertain -- and uncertainty that
 * never resolves is the state an agent is already in without any of this.
 *
 * ## It is the existing research step, not a second one
 *
 * `research.ts` already knows how to look something up: the open web through
 * the browser that is already running, DexScreener for a contract address or a
 * ticker, a budget, a source-by-source switch the owner controls, and a failed
 * lookup reported as a gap rather than swallowed. None of that is rebuilt here.
 * This decides *what* to look up and *what to do with the answer*, which are the
 * only two questions the reply path was answering differently.
 *
 * ## What comes back is evidence, never an answer
 *
 * A finding is attached to the item as evidence and the item is left open.
 * **Nothing here marks a question answered.** An agent that decides its own
 * question is settled because a search engine returned something is doing
 * exactly the laundering `research.ts` exists to prevent -- and a wrong result
 * reads identically to a right one. Reflection, which is a model looking at the
 * item and its evidence together, is what may later decide it is resolved.
 *
 * ## Bounded by the clock that already exists
 *
 * One lookup per wake at most, and an item that has just been looked into has
 * its review time pushed forward -- so the same question is not sent to a search
 * engine every quarter of an hour for ever. That is `review_at`, which the
 * working set already carries. No second timer.
 *
 * ## It needs a browser, so it belongs to the worker
 *
 * The API owns no browsers. An owner pressing "think now" gets everything else
 * and not this, which is the same division `browser_tasks` exists for, and the
 * outcome says so rather than quietly doing less than it claims.
 */

/** Strong enough to be worth a lookup. Below this it is not a real question yet. */
const WORTH_LOOKING_UP = 40;

/** How long before the same question may be looked up again. */
const LOOK_AGAIN_AFTER_HOURS = 24;

/**
 * Shorter than a reply's budget, and for the opposite reason.
 *
 * A reply is somebody waiting. This is not -- but it holds the RESEARCH tab,
 * which the reply path also needs, so a slow search here is a reply that queues
 * behind an agent's idle curiosity. Whatever does not finish is a gap, and the
 * question stays open, which is the correct outcome anyway.
 */
const CURIOSITY_BUDGET_MS = 45_000;

export interface LookedInto {
  itemId: string;
  question: string;
  findings: number;
  /** Lookups that were attempted and did not come back, so a gap is visible. */
  failed: number;
  note: string;
}

/**
 * What this agent would most like to find out, if anything.
 *
 * Only the kinds that are actually questions. An INTEREST is a subject, not a
 * thing anybody can look up, and sending one to a search engine returns
 * whatever is being said about it today, which is how a working set fills with
 * the news.
 */
export function questionWorthLookingUp(
  items: readonly AttentionRow[],
  now: Date = new Date(),
): AttentionRow | null {
  for (const item of items) {
    if (item.kind !== 'CURIOSITY' && item.kind !== 'QUESTION') continue;
    if (item.salience < WORTH_LOOKING_UP) continue;
    // Looked into recently. The review clock is the only thing standing between
    // a curious agent and a search engine it asks the same question every
    // quarter of an hour, so it is checked before anything reaches the network.
    if (item.reviewAt && new Date(item.reviewAt).getTime() > now.getTime()) continue;
    return item;
  }
  return null;
}

async function nextQuestion(agentId: string, now: Date): Promise<AttentionRow | null> {
  const items = await mind.onItsMind(agentId, { kinds: ['CURIOSITY', 'QUESTION'], limit: 10 });
  return questionWorthLookingUp(items, now);
}

/**
 * What to actually ask.
 *
 * `whatToResearch` first, because it already routes a contract address or a
 * ticker to market data rather than to a search engine, and getting that wrong
 * is how "$DOG" becomes three articles about dogs. It is built for a
 * conversation though, and decides among other things *whether* anything needs
 * looking up -- a decision already made here, by the agent, when it wrote the
 * question down. So a subject it declines falls back to one plain search.
 */
export function whatToAsk(item: AttentionRow): Lookup[] {
  const question = item.summary.trim();
  const routed = whatToResearch({ incoming: question }, 1);
  if (routed.length > 0) return routed;
  return [
    {
      kind: 'search',
      query: question.slice(0, 200),
      reason: 'Something this agent wrote down that it wanted to understand better.',
    },
  ];
}

/** A finding, in the shape the working set keeps evidence in. */
function asEvidence(finding: Finding): { kind: string; ref: string; note: string; at: string } {
  return {
    kind: 'RESEARCH',
    // The URL where there is one, and the source's name where there is not --
    // a reference nobody can follow is not evidence.
    ref: (finding.url ?? finding.source).slice(0, 400),
    note: `${finding.source}: ${finding.title}`.slice(0, 400),
    at: finding.retrievedAt,
  };
}

/**
 * Look one thing up, if this agent is wondering about anything worth the trip.
 *
 * Returns null when it did not look, which is most of the time and is not a
 * failure. Never throws: an agent that cannot think because a search engine was
 * slow is worse than one that did not look this time.
 */
export async function lookIntoSomething(
  agentId: string,
  options: {
    now?: Date;
    /**
     * How to search, where the caller has its own.
     *
     * The same seam `research` itself takes, and for the same reason: what does
     * the searching is not this module's decision. Absent, the channel's own
     * browser is used, which is what the worker wants and what nothing else
     * has.
     */
     search?: SearchFn;
  } = {},
): Promise<LookedInto | null> {
  const now = options.now ?? new Date();

  try {
    const item = await nextQuestion(agentId, now);
    if (!item) return null;

    const policy = await agentsRepo.getActivePolicy(agentId);
    const sources = policy?.config.tools.research;
    // Both off is an owner who said no. Said rather than attempted: a gap
    // somebody created on purpose is still a gap, and it stays on the item as
    // an open question.
    if (sources && !sources.web && !sources.market) return null;

    const links = await accountsRepo.listAgentAccounts(agentId);
    const accountId = links[0]?.accountId;
    if (!accountId) return null;
    const account = await accountsRepo.getAccount(accountId);
    if (!account) return null;

    const adapter = getChannelAdapter(account.channel);
    // Searching needs a browser, which the channel owns. A channel without one
    // cannot, and neither can the API, which owns no browsers at all.
    if (!options.search && !adapter.lookUp) return null;

    const lookups = whatToAsk(item);
    const context = options.search ? null : await buildChannelContext(account, null);
    const throughTheBrowser = async (query: string): Promise<Finding[]> => {
      const kind = lookups.find((each) => each.query === query)?.kind === 'link' ? 'link' : 'search';
      const found = await adapter.lookUp!(context!, { query, kind });
      return found.map((entry) => ({
        kind: kind as 'search' | 'link',
        query,
        source: kind === 'link' ? 'The page they linked' : 'Web search',
        title: entry.title,
        summary: entry.snippet,
        url: entry.url,
        retrievedAt: new Date().toISOString(),
      }));
    };

    const result = await research(lookups, {
      search: options.search ?? throughTheBrowser,
      budgetMs: CURIOSITY_BUDGET_MS,
      ...(sources ? { sources: { web: sources.web, market: sources.market } } : {}),
    });

    /*
      Pushed forward whatever came back.

      A question nothing could answer is not a question to ask again in fifteen
      minutes -- that is the loop that turns curiosity into a search engine
      hammering itself. The item stays open either way.
    */
    const reviewAt = new Date(now.getTime() + LOOK_AGAIN_AFTER_HOURS * 3600_000).toISOString();

    if (result.findings.length === 0) {
      await mind.noteReviewed(item.id, reviewAt);
      log.debug('looked and found nothing', { agentId, itemId: item.id, note: result.note });
      return { itemId: item.id, question: item.summary, findings: 0, failed: result.failed.length, note: result.note };
    }

    /*
      Back onto the same item, by fingerprint.

      `remember` upserts, so this appends the evidence, counts as a
      reinforcement and refreshes the clock on an item the agent has now
      actually done something about. It does **not** rewrite the summary -- the
      question is still the question, and a search result is not a better
      wording of it.

      Confidence moves a little rather than a lot. Having found something
      relevant is not the same as having understood it, and the model that
      reads this item next is the thing entitled to decide that.
    */
    await mind.remember({
      agentId,
      kind: item.kind,
      summary: item.summary,
      detail: item.detail,
      salience: item.salience,
      factors: item.factors,
      confidence: Math.min(0.75, item.confidence + 0.1),
      evidence: result.findings.map(asEvidence),
      origin: 'RESEARCH',
      fingerprint: item.fingerprint,
      reviewAt,
    });

    log.info('an agent looked something up', {
      agentId,
      itemId: item.id,
      findings: result.findings.length,
      failed: result.failed.length,
    });
    return {
      itemId: item.id,
      question: item.summary,
      findings: result.findings.length,
      failed: result.failed.length,
      note: result.note,
    };
  } catch (error) {
    // A wake that cannot look something up is still a wake. This is the one
    // part of deliberation that reaches the network, so it is also the one part
    // that must not be able to stop the rest.
    log.debug('a lookup did not happen', { agentId, message: errorMessage(error) });
    return null;
  }
}
