import { createLogger, errorMessage } from '@xbam/shared';
import { accounts as accountsRepo, agents as agentsRepo, research as researchRepo } from '@xbam/database';
import {
  collectIndexedMirror,
  emptyTimelineDetail,
  emptyTimelineIsReal,
  MIRROR_PROFILE_URLS,
  observationFromSearchResult,
  observationFromXPost,
  observationsFromMirrorArticles,
  readMirrorPage,
  xAdapter,
  xIntelligence,
} from '@xbam/channels';
import type { ChannelContext } from '@xbam/channels';
import {
  advanceFoundryRun,
  buildChannelContext,
  checkReadCapacity,
  noteXRead,
  primaryAccountOf,
  type FabricSource,
  type FoundryDeps,
} from '@xbam/runtime';

const log = createLogger('foundry-worker');

/**
 * Agent Foundry, on the worker: the only process that owns a browser.
 *
 * Research runs are claimed under a lease like every other loop here and
 * advanced beside the sweep, one at a time, because a run reads X for
 * minutes and the sweep also delivers notifications.
 *
 * ## What it reads X with, and on whose budget
 *
 * Through the canonical reading layer, in the agent's own signed-in browser,
 * as BROAD work: the lowest class, which yields first to people who wrote in
 * and to accounts the owner watches. A run the budget will not allow yet is
 * deferred, never run without X.
 *
 * Search engines and mirrors are read on the RESEARCH tab, and a mirror that
 * answers with a bot check is left alone for a day. Nothing here types,
 * clicks or signs in to anything.
 */

const LEASE_MS = 10 * 60_000;

/**
 * What a timeline read that did not come back OK means for research.
 *
 * Exported and pure because it is the judgement that matters: an empty
 * account, a read that failed, X asking for less and X asking for a person
 * all look like "no posts", and each needs something different.
 */
export function xReadVerdict(
  outcome: string,
  detail: string,
  handle: string,
  postsOnProfile: number | null,
): { state: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE'; detail: string; retryAfterMs?: number; fatal?: string } {
  if (outcome === 'EMPTY') {
    return emptyTimelineIsReal(postsOnProfile)
      ? { state: 'AVAILABLE', detail: emptyTimelineDetail(handle, postsOnProfile) }
      : { state: 'UNAVAILABLE', detail: emptyTimelineDetail(handle, postsOnProfile), retryAfterMs: 15 * 60_000 };
  }
  if (outcome === 'RATE_LIMITED') return { state: 'DEGRADED', detail, retryAfterMs: 15 * 60_000 };
  if (outcome === 'NOT_FOUND' || outcome === 'PROTECTED') return { state: 'UNAVAILABLE', detail, fatal: detail };
  if (outcome === 'CHALLENGE' || outcome === 'NEEDS_SIGN_IN') {
    return { state: 'UNAVAILABLE', detail, fatal: `${detail} This needs you in the AI17Z browser window; nothing here answers it.` };
  }
  // SCHEMA_CHANGED, UNAVAILABLE: usually momentary. Come back, bounded.
  return { state: 'UNAVAILABLE', detail: detail || `X did not show @${handle}'s timeline.`, retryAfterMs: 10 * 60_000 };
}
/** Mirror pages opened per run: enough to corroborate a voice, few enough to be a reader rather than a crawler. */
const MIRROR_PAGES_PER_RUN = 8;
let running: string | null = null;

/** The account whose browser reads for this agent: its own, or any of the owner's that is signed in. */
async function readerFor(agentId: string, ownerId: string): Promise<ChannelContext | null> {
  const own = await primaryAccountOf(agentId);
  const candidates = [
    ...(own ? [await accountsRepo.getAccount(own)] : []),
    ...(await accountsRepo.listAccounts(ownerId)),
  ].filter((a): a is NonNullable<typeof a> => Boolean(a) && a!.channel === 'x' && a!.status === 'CONNECTED');
  const account = candidates[0];
  return account ? buildChannelContext(account, null) : null;
}

function depsFor(channel: ChannelContext | null, workerId: string): FoundryDeps {
  const accountId = channel?.account.id ?? null;

  const platform: FabricSource | null = channel
    ? {
        family: 'X',
        tier: 'PRIMARY_PLATFORM',
        label: 'X',
        roles: ['PERSONA_RESEARCH', 'SOCIAL_HISTORY'],
        optional: false,
        async collect(request) {
          if (!request.handle) return { state: 'NOT_CONFIGURED', detail: 'No account named.', observations: [], requests: 0 };
          const capacity = await checkReadCapacity(accountId!, 'BROAD').catch(() => null);
          if (capacity && !capacity.allowed) {
            return { state: 'DEGRADED', detail: capacity.message, observations: [], requests: 0, retryAfterMs: capacity.retryAfterMs ?? 10 * 60_000 };
          }
          const user = await xIntelligence.resolveUser(request.handle, { channel, freshness: 'ARCHIVAL' });
          await noteXRead(accountId!, 'BROAD');
          if (user.outcome !== 'OK' || !user.data) {
            return { state: 'UNAVAILABLE', detail: user.detail || `@${request.handle} could not be read on X.`, observations: [], requests: 1 };
          }
          const posts = await xIntelligence.getUserPosts(
            { userId: user.data.userId, handle: user.data.handle, limit: request.limit, includeReplies: true, includeReposts: false },
            { channel, freshness: 'ARCHIVAL' },
          );
          await noteXRead(accountId!, 'BROAD');
          const at = new Date().toISOString();
          const observations = posts.data.map((p) => observationFromXPost(p, at)).filter((o): o is NonNullable<typeof o> => o !== null);
          if (posts.outcome === 'OK') {
            return { state: 'AVAILABLE', detail: `Read ${observations.length} posts and replies by @${user.data.handle}.`, observations, requests: 2 };
          }
          return { ...xReadVerdict(posts.outcome, posts.detail, user.data.handle, user.data.posts), observations, requests: 2 };
        },
      }
    : null;

  const search = async (query: string) => {
    if (!channel || !xAdapter.lookUp) return [];
    return xAdapter.lookUp(channel, { query, kind: 'search' });
  };

  const searchIndex: FabricSource | null = channel
    ? {
        family: 'SEARCH_ENGINE',
        tier: 'SEARCH_INDEX',
        label: 'Search engines',
        roles: ['PERSONA_RESEARCH', 'WEB_RESEARCH'],
        optional: true,
        async collect(request) {
          if (!request.handle) return { state: 'NOT_CONFIGURED', detail: 'No account named.', observations: [], requests: 0 };
          const at = new Date().toISOString();
          const results = [...(await search(`site:x.com/${request.handle}`)), ...(await search(`"@${request.handle}" x.com status`))];
          // Only results that are this person's own posts. A snippet is kept as
          // a snippet, and the dedupe step reads the original where it can.
          const observations = results
            .map((r) => observationFromSearchResult(r, at, 'Web search'))
            .filter((o) => o.platform === 'x' && o.author?.toLowerCase() === request.handle!.toLowerCase());
          return { state: results.length > 0 ? 'AVAILABLE' : 'DEGRADED', detail: `${observations.length} of their posts found by search.`, observations, requests: 2 };
        },
      }
    : null;

  const mirror = (family: 'TWSTALKER' | 'SOTWE', label: string): FabricSource => ({
    family,
    tier: 'PUBLIC_MIRROR',
    label,
    roles: ['SOCIAL_HISTORY'],
    optional: true,
    async collect(request, remaining) {
      if (!channel || !request.handle) return { state: 'NOT_CONFIGURED', detail: 'Nothing to read it with.', observations: [], requests: 0 };
      // The search index first: it names exact posts, each checked against its author.
      const indexed = await collectIndexedMirror({
        family,
        label,
        handle: request.handle,
        search,
        read: (url) => readMirrorPage(channel, url, 20),
        maxFetches: Math.min(MIRROR_PAGES_PER_RUN, Math.max(0, remaining.requests - 2)),
      });
      if (indexed.challenged) {
        return { state: 'UNAVAILABLE', detail: indexed.detail, observations: indexed.observations, requests: indexed.requests, challenged: true };
      }
      if (indexed.indexed > 0) {
        return { state: indexed.read > 0 ? 'AVAILABLE' : 'DEGRADED', detail: indexed.detail, observations: indexed.observations, requests: indexed.requests };
      }
      const read = await readMirrorPage(channel, MIRROR_PROFILE_URLS[family](request.handle));
      if (read.challenge) return { state: 'UNAVAILABLE', detail: `${label} answered with a bot check, so it was left alone.`, observations: [], requests: 1, challenged: true };
      const observations = observationsFromMirrorArticles(read.articles, family, new Date().toISOString()).filter(
        (o) => !o.author || o.author.toLowerCase() === request.handle!.toLowerCase(),
      );
      return { state: observations.length > 0 ? 'AVAILABLE' : 'DEGRADED', detail: read.detail, observations, requests: indexed.requests + 1 };
    },
  });

  return {
    workerId,
    leaseMs: LEASE_MS,
    platform,
    searchIndex,
    mirrors: [mirror('TWSTALKER', 'TwStalker'), mirror('SOTWE', 'Sotwe')],
    async resolveProfile(handle) {
      if (!channel) return null;
      const user = await xIntelligence.resolveUser(handle, { channel, freshness: 'ARCHIVAL' });
      if (accountId) await noteXRead(accountId, 'BROAD');
      return user.outcome === 'OK' && user.data
        ? { handle: user.data.handle, displayName: user.data.displayName, bio: user.data.bio, website: user.data.website }
        : null;
    },
    search,
    async confirmPost(statusId) {
      if (!channel || !accountId) return null;
      const capacity = await checkReadCapacity(accountId, 'BROAD').catch(() => null);
      if (capacity && !capacity.allowed) return null;
      const post = await xIntelligence.getPost(statusId, { channel, freshness: 'ARCHIVAL' });
      await noteXRead(accountId, 'BROAD');
      return post.outcome === 'OK' && post.data ? observationFromXPost(post.data, new Date().toISOString()) : null;
    },
  };
}

/**
 * Takes one due Foundry run and advances it beside the sweep.
 *
 * One at a time per worker: a run reads X for minutes, and two at once would
 * spend the account's broad budget twice as fast for no gain.
 */
export async function sweepFoundry(workerId: string): Promise<void> {
  if (running) return;
  const run = await researchRepo.claimDueRun(workerId, LEASE_MS, ['FOUNDRY_SETUP', 'FOUNDRY_IMPROVE', 'PERSONA_REFRESH']);
  if (!run) return;
  running = run.id;
  void (async () => {
    try {
      const agent = run.agentId ? await agentsRepo.getAgent(run.agentId) : null;
      const channel = agent ? await readerFor(agent.id, run.ownerId).catch(() => null) : null;
      const outcome = await advanceFoundryRun(run, depsFor(channel, workerId));
      log.info('advanced a Foundry run', { runId: run.id, outcome });
    } catch (error) {
      log.warn('a Foundry run failed', { runId: run.id, message: errorMessage(error) });
      await researchRepo.deferRun(run.id, workerId, 5 * 60_000, errorMessage(error)).catch(() => undefined);
    } finally {
      running = null;
    }
  })();
}
