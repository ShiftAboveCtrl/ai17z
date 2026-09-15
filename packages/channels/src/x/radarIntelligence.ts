import type { RadarCandidate, RadarPollResult, RadarSourceKind } from '@xbam/shared/contracts';
import type { ChannelContext } from '../contract';
import { xIntelligence, STOP_ASKING, type XPostRecord, type XReadResult } from './intelligence';
import { normalizeHandle } from './targets';

/**
 * The radar, reading X through the one layer AI17Z reads X through.
 *
 * Four of the six monitors are searches or timeline walks, and until this
 * existed every one of them worked by scrolling a rendered page and scraping
 * the articles. That produced candidates with `authorId: null` and no
 * engagement counts, because a drawn article carries neither -- and those two
 * absences travelled all the way downstream:
 *
 * - **Identity.** `events.remote_author_id` was null for everything the radar
 *   found, so relationship memory could only ever key on a handle. Somebody who
 *   renames themselves became a second person, which is the exact
 *   discontinuity the relationships table exists to prevent.
 * - **Engagement.** `findOpportunities` has had `replyCount` factors written
 *   since it was first built -- "nobody has replied yet", "150 replies already,
 *   one more is unlikely to be seen" -- and nothing ever populated them,
 *   because nothing upstream could see a count.
 *
 * X's own search endpoint answers with all of it: immutable author ids, exact
 * counts, the real conversation id, and the id of the post being replied to.
 * So the radar asks for that first and keeps the page scrape underneath it.
 *
 * ## This is not a second reader
 *
 * Nothing here talks to X. It asks `xIntelligence`, which decides which backend
 * answers and says which one did. What this file owns is the translation --
 * a normalised `XPostRecord` into the `RadarCandidate` the reconciler already
 * takes -- and the decision about when an unanswered read should fall through
 * to the rendered page.
 *
 * ## When the page monitor still runs, and when it must not
 *
 * The contract already has the vocabulary for this and it is used verbatim
 * rather than re-derived:
 *
 * - `SCHEMA_CHANGED` / `UNAVAILABLE` -- the structured read could not run.
 *   Return nothing and let the page monitor do what it has always done.
 * - Anything in `STOP_ASKING` -- signed out, challenged, rate limited,
 *   protected, missing. **The page monitor must not run.** Loading the same
 *   page in a browser is how a rate limit becomes hammering and how a challenge
 *   becomes an argument with a security check. The source records the refusal
 *   instead.
 * - `EMPTY` -- a real answer. X's search index is the same index the rendered
 *   search page draws from, so scrolling it again to be told the same thing
 *   costs a page load to learn nothing.
 */

/** How much reading one radar poll may do. Small: this runs every minute. */
const RADAR_BUDGET = { maxMs: 45_000, maxPages: 3, maxQuietPages: 1 };

/**
 * What a monitor needs, minus the page.
 *
 * Deliberately the channel context rather than a `Page`: these reads happen
 * inside the intelligence layer, which takes its own session on the RESEARCH
 * tab. A monitor handed a page would be a monitor that had already decided
 * which tab the read happens on.
 */
export interface RadarReadContext {
  channel: ChannelContext;
  selfHandles: string[];
  limit: number;
  cursor: string | null;
  target: string | null;
}

/**
 * Ask the canonical layer for what this source watches.
 *
 * Returns `null` when the layer cannot serve this kind at all, which is the
 * caller's signal to run the page monitor instead.
 */
export async function pollViaIntelligence(
  kind: RadarSourceKind,
  ctx: RadarReadContext,
): Promise<RadarPollResult | null> {
  const me = ctx.selfHandles[0];

  switch (kind) {
    case 'mention_search':
      if (!me) return null;
      return search(ctx, `@${me} -from:${me}`, 'MENTION');

    case 'reply_search':
      if (!me) return null;
      return search(ctx, `to:${me} -from:${me}`, 'REPLY');

    case 'tracked_keyword':
      if (!ctx.target) return null;
      return search(ctx, ctx.target, 'POST');

    case 'tracked_account':
      if (!ctx.target) return null;
      return watchAccount(ctx, ctx.target);

    /*
      Both of these read a surface the structured layer has no operation for.
      Notifications is X's own notifications page, which is not a timeline
      query; own_threads walks the replies under one of our own posts and, while
      it is standing there, reads the counts on the post itself -- which is what
      makes measurement a by-product of work already being done rather than a
      second loop asking X how a post is doing. Leaving both to the page monitor
      is the honest answer until `getThread` exists on a backend.
    */
    case 'notifications':
    case 'own_threads':
      return null;

    default:
      return null;
  }
}

async function search(ctx: RadarReadContext, query: string, eventType: string): Promise<RadarPollResult | null> {
  const answer = await xIntelligence.searchPosts(
    { query, limit: Math.max(ctx.limit, 1), latest: true },
    { channel: ctx.channel, budget: RADAR_BUDGET },
  );
  return fromReadResult(answer, ctx, eventType, `search:${query}`);
}

/**
 * An account worth watching, read as its author timeline.
 *
 * Two reads, because identity comes first here exactly as it does everywhere
 * else: the owner typed a handle, the timeline is asked for by id. A handle
 * that resolves to no id -- which is what the rendered-page backend returns,
 * since a drawn profile does not carry one -- means the structured read cannot
 * proceed, and the page monitor is the right answer rather than a guess.
 */
async function watchAccount(ctx: RadarReadContext, target: string): Promise<RadarPollResult | null> {
  const handle = normalizeHandle(target) ?? target;
  const resolved = await xIntelligence.resolveUser(handle, { channel: ctx.channel, freshness: 'MODERATE' });

  if (resolved.outcome !== 'OK' || !resolved.data) {
    if (STOP_ASKING.includes(resolved.outcome)) {
      return { candidates: [], cursor: null, error: refusal(resolved.outcome, resolved.detail, `@${handle}`) };
    }
    return null;
  }
  // The rendered page can describe somebody without knowing who they are. A
  // timeline read needs the id, so this falls through rather than inventing one.
  if (!resolved.data.userId) return null;

  const timeline = await xIntelligence.getUserPosts(
    {
      userId: resolved.data.userId,
      handle: resolved.data.handle,
      limit: Math.max(ctx.limit, 1),
      sincePostId: ctx.cursor,
      includeReplies: true,
      includeReposts: false,
    },
    { channel: ctx.channel, budget: RADAR_BUDGET },
  );
  return fromReadResult(timeline, ctx, 'POST', `account:${handle}`);
}

/**
 * A read's answer, as the radar's own vocabulary.
 *
 * The three-way split is the whole of the fallback honesty rule: an answer
 * becomes candidates, a refusal becomes a recorded error, and a backend that
 * could not run becomes nothing at all so the page monitor can try.
 */
export function fromReadResult(
  answer: XReadResult<XPostRecord[]>,
  // Only what it actually reads. This decides what to do with an answer and
  // never needs a browser, which is what lets it be tested without one.
  ctx: Pick<RadarReadContext, 'selfHandles' | 'limit' | 'cursor'>,
  eventType: string,
  sourceLabel: string,
): RadarPollResult | null {
  if (answer.outcome === 'OK') {
    const candidates = toCandidates(answer.data, ctx, eventType, sourceLabel, answer.provenance.backend);
    return { candidates, cursor: candidates[0]?.remoteId ?? null, error: null };
  }

  // Nothing was there. A real answer, and a cheaper one than loading the page
  // to be told the same thing by the same index.
  if (answer.outcome === 'EMPTY') return { candidates: [], cursor: null, error: null };

  if (STOP_ASKING.includes(answer.outcome)) {
    return { candidates: [], cursor: null, error: refusal(answer.outcome, answer.detail, sourceLabel) };
  }

  // SCHEMA_CHANGED or UNAVAILABLE: the structured read could not run, and the
  // rendered page is exactly the fallback that exists for it.
  return null;
}

/** The refusal in words an owner reads on the source's row, never a code. */
function refusal(outcome: string, detail: string, what: string): string {
  if (detail) return detail;
  switch (outcome) {
    case 'NEEDS_SIGN_IN':
      return 'X asked for a sign-in, so nothing was read.';
    case 'CHALLENGE':
      return 'X is asking for a security check, which only you can answer.';
    case 'RATE_LIMITED':
      return 'X asked AI17Z to slow down, so this poll stopped.';
    case 'PROTECTED':
      return `${what} is not public.`;
    case 'NOT_FOUND':
      return `${what} could not be found.`;
    default:
      return `${what} could not be read.`;
  }
}

/**
 * Normalised posts as radar candidates.
 *
 * The filtering matches what the page monitor has always done -- our own posts
 * are never candidates, an empty post is not a candidate, and the cursor is the
 * last thing seen so everything below it is old news. What is new is what
 * survives the trip: the author's immutable id, the real conversation, the post
 * being replied to, and the counts.
 */
export function toCandidates(
  posts: XPostRecord[],
  ctx: Pick<RadarReadContext, 'selfHandles' | 'limit' | 'cursor'>,
  eventType: string,
  sourceLabel: string,
  backend: string,
): RadarCandidate[] {
  const selves = new Set(ctx.selfHandles.map((h) => h.replace(/^@+/, '').toLowerCase()));
  const candidates: RadarCandidate[] = [];
  const seen = new Set<string>();

  for (const post of posts) {
    if (candidates.length >= ctx.limit) break;
    if (!post.postId || seen.has(post.postId)) continue;
    seen.add(post.postId);

    // Everything below the last thing seen has already been through here.
    if (ctx.cursor && post.postId === ctx.cursor) break;

    /*
      A repost is not something its reposter said.

      X gives the wrapper its own id and the reposter as its author, while the
      text is the original truncated behind "RT @somebody:". Ingesting that
      records an event whose text belongs to one person and whose author is
      another -- and an agent watching an account would then be considering a
      reply to a post that account merely passed on. The persona collector drops
      reposts for a related reason: pressing repost is not writing.
    */
    if (post.repost) continue;
    if (!post.text.trim()) continue;
    if (post.authorHandle && selves.has(post.authorHandle.toLowerCase())) continue;

    candidates.push({
      remoteId: post.postId,
      remoteUrl: post.url,
      authorHandle: post.authorHandle || null,
      // The whole reason this path exists. A drawn article has no id in it.
      authorId: post.authorId,
      authorDisplayName: null,
      text: post.text,
      parentRemoteId: post.replyToPostId,
      conversationRemoteId: post.conversationId ?? post.postId,
      // What X says, not when we happened to look. An undated post is treated
      // as current rather than dropped, which is the same direction the page
      // monitor chose and for the same reason.
      occurredAt: post.createdAt ?? new Date().toISOString(),
      eventType,
      raw: {
        source: sourceLabel,
        backend,
        collectedAt: post.provenance.collectedAt,
        ...(post.quotedPostId ? { quotedPostId: post.quotedPostId } : {}),
        ...(post.lang ? { lang: post.lang } : {}),
        /*
          Carried on the event so the opportunity engine can weigh a crowded
          thread against an empty one. Recorded only when the reader actually
          saw them: the rendered page abbreviates counts to "1.2K", so a backend
          that cannot see an exact number reports none rather than a wrong one,
          and `metrics` being absent has to keep meaning "not seen" rather than
          quietly meaning zero.
        */
        ...(post.metrics ? { metrics: compactMetrics(post.metrics) } : {}),
      },
    });
  }
  return candidates;
}

/** The counts that were actually there. A null count was not observed. */
function compactMetrics(metrics: NonNullable<XPostRecord['metrics']>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(metrics)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
  }
  return out;
}
