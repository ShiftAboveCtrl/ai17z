import type { ContextPost, ConversationContext, QuotedPost } from '@xbam/shared/contracts';
import { normalizeHandle } from './targets';

/**
 * Turning a rendered X status page into a conversation branch.
 *
 * This file is pure on purpose. Every DOM read happens in `index.ts`, producing
 * `ArticleSnapshot[]`; the reasoning about which post addressed the agent, what
 * it was replying to, and which posts belong to a different branch happens
 * here, where it can be pinned down by fixtures instead of by a live browser.
 *
 * Two rules carried over from AI4CZ, both of which it earned the hard way:
 *
 *  1. The focal post is found by its own status id, never by position. AI4CZ
 *     scanned for an article containing a link to `/status/<id>` and refused to
 *     continue when it found none. Guessing "the second article" is what makes
 *     an automation reply to a stranger.
 *
 *  2. Target identity and semantic context are different problems. The status
 *     id decides where the reply goes; the surrounding posts decide what it
 *     says. Nothing in the branch may ever change the target.
 *
 * What AI4CZ did not do, and this does: walk the whole ancestor chain. The old
 * extractor took `articles[focalIndex - 1]` and stopped, so a mention three
 * levels deep reached the model with one line of context. See
 * docs/legacy-nested-mentions.md.
 */

/** One article as read off a status page, before any meaning is assigned. */
export interface ArticleSnapshot {
  /** Position in DOM order on the status page. */
  index: number;
  statusId: string | null;
  authorHandle: string | null;
  authorDisplayName: string | null;
  text: string;
  url: string | null;
  createdAt: string | null;
  /**
   * Handles from the "Replying to @a @b" line X renders above a reply. X
   * truncates this list, so its absence proves nothing; its presence is a
   * cross-check on the parent chosen from render order.
   */
  replyingTo: string[];
}

export interface BranchInput {
  articles: ArticleSnapshot[];
  /** The status id of the post that addressed the agent. */
  focalStatusId: string;
  /** Handles belonging to this account. */
  selfHandles: string[];
  quote?: QuotedPost | null;
  /** How many ancestors nearest the focal to keep. The root is always kept. */
  maxAncestors?: number;
}

export type BranchOutcome =
  | { ok: true; conversation: ConversationContext }
  | { ok: false; reason: 'focal_article_not_found' | 'no_articles'; detail: string };

/**
 * How much of a thread is worth carrying.
 *
 * Ten posts is roughly where a branch stops adding information and starts
 * crowding out memory and persona in the prompt. The root is exempt because it
 * is usually what the whole conversation is about.
 */
export const DEFAULT_MAX_ANCESTORS = 10;

function toPost(article: ArticleSnapshot, selfHandles: string[]): ContextPost {
  return {
    remoteId: article.statusId,
    remoteUrl: article.url,
    authorHandle: article.authorHandle,
    authorDisplayName: article.authorDisplayName,
    text: article.text,
    createdAt: article.createdAt,
    isSelf: Boolean(article.authorHandle && selfHandles.includes(article.authorHandle)),
  };
}

/**
 * Drops articles that cannot take part in a conversation.
 *
 * A status page renders more than posts: promoted content, "discover more"
 * cards, and empty placeholders all come back as `article` elements. Anything
 * without a status id is one of those. Duplicates happen because X's
 * virtualised list re-renders, and because a quoted post nested inside an
 * article can surface as its own entry.
 */
function usable(articles: ArticleSnapshot[]): ArticleSnapshot[] {
  const seen = new Set<string>();
  const kept: ArticleSnapshot[] = [];
  for (const article of articles) {
    if (!article.statusId) continue;
    if (seen.has(article.statusId)) continue;
    seen.add(article.statusId);
    kept.push(article);
  }
  return kept;
}

/**
 * Resolves the branch that leads to the focal post.
 *
 * The one structural fact this rests on: when X renders `/user/status/<id>`, it
 * has already resolved the reply chain server-side and renders exactly the path
 * from the root down to that post, in order, above it. Everything below is a
 * different branch — replies to the focal, or siblings of it. So the ancestors
 * are "the articles before the focal", and the exclusion of unrelated branches
 * is structural rather than a filter applied afterwards.
 */
export function resolveBranch(input: BranchInput): BranchOutcome {
  const selfHandles = input.selfHandles.map((h) => normalizeHandle(h)).filter((h): h is string => Boolean(h));
  const articles = usable(input.articles);
  if (articles.length === 0) {
    return { ok: false, reason: 'no_articles', detail: 'The status page rendered no posts at all.' };
  }

  const focalIndex = articles.findIndex((a) => a.statusId === input.focalStatusId);
  if (focalIndex === -1) {
    // AI4CZ's `focal_article_not_found`. Refusing here is the whole point: the
    // alternative is picking a neighbour and replying to the wrong person.
    return {
      ok: false,
      reason: 'focal_article_not_found',
      detail: `No article on the page carries status ${input.focalStatusId}, so the exact post could not be identified.`,
    };
  }

  const focal = articles[focalIndex]!;
  const before = articles.slice(0, focalIndex);
  const excludedCount = articles.length - before.length - 1;

  // X occasionally renders the focal post a second time above itself, and a
  // retweet can duplicate text without duplicating the status id. AI4CZ guarded
  // against exactly this with `if (parentText === mentionText) parentText = ""`.
  const chain = before.filter((a) => a.text.trim() !== focal.text.trim() || !focal.text.trim());

  const max = input.maxAncestors ?? DEFAULT_MAX_ANCESTORS;
  let ancestors = chain;
  let trimmed = 0;
  if (chain.length > max) {
    // Keep the root and the posts nearest the focal. The middle of a long
    // thread is the least useful part: the root says what it is about and the
    // last few say what is being argued now.
    const root = chain[0]!;
    ancestors = [root, ...chain.slice(chain.length - (max - 1))];
    trimmed = chain.length - ancestors.length;
  }

  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : null;
  const root = ancestors.length > 0 ? ancestors[0]! : null;

  // Cross-check the parent against X's own "Replying to" line. When the focal
  // names a handle and it is not the parent's, the branch is still reported —
  // render order is the stronger signal — but flagged as unconfirmed so the
  // debug view can show it and a person can see why a reply read oddly.
  const claimed = focal.replyingTo.map((h) => normalizeHandle(h)).filter((h): h is string => Boolean(h));
  const branchConfirmed =
    parent === null
      ? claimed.length === 0
      : Boolean(parent.authorHandle && claimed.includes(parent.authorHandle));

  const participants: string[] = [];
  for (const article of [...ancestors, focal]) {
    if (article.authorHandle && !participants.includes(article.authorHandle)) {
      participants.push(article.authorHandle);
    }
  }

  const notes: string[] = [];
  notes.push(
    parent
      ? `Anchored to ${input.focalStatusId}; ${ancestors.length} post${ancestors.length === 1 ? '' : 's'} above it form the branch.`
      : `Anchored to ${input.focalStatusId}; it is the root of its own thread.`,
  );
  if (trimmed > 0) notes.push(`${trimmed} middle post${trimmed === 1 ? '' : 's'} left out to bound the context.`);
  if (excludedCount > 0) {
    notes.push(`${excludedCount} post${excludedCount === 1 ? '' : 's'} below it belong to other branches and were excluded.`);
  }
  if (parent && !branchConfirmed) {
    notes.push(
      claimed.length > 0
        ? `X says it is replying to @${claimed.join(', @')}, which does not include the parent chosen from render order.`
        : 'X rendered no "replying to" line, so the parent rests on render order alone.',
    );
  }

  return {
    ok: true,
    conversation: {
      incoming: toPost(focal, selfHandles),
      parent: parent ? toPost(parent, selfHandles) : null,
      ancestors: ancestors.map((a) => toPost(a, selfHandles)),
      root: root ? toPost(root, selfHandles) : null,
      quote: input.quote ?? null,
      participants,
      excludedCount,
      method: 'STATUS_ANCHORED',
      branchConfirmed,
      note: notes.join(' ').slice(0, 500),
    },
  };
}

/**
 * The branch when the page could not be read at all.
 *
 * Used when an event arrives with text but no rendered page behind it — a
 * reconciled candidate acted on without a fresh load. The incoming post is
 * still the action target; there is simply no context around it, and saying so
 * is better than presenting an empty branch as a resolved one.
 */
export function branchFromEventOnly(post: ContextPost, quote?: QuotedPost | null): ConversationContext {
  return {
    incoming: post,
    parent: null,
    ancestors: [],
    root: null,
    quote: quote ?? null,
    participants: post.authorHandle ? [post.authorHandle] : [],
    excludedCount: 0,
    method: 'EVENT_ONLY',
    branchConfirmed: false,
    note: 'No status page was read, so only the incoming post itself is known.',
  };
}

/**
 * The one-parent string AI4CZ passed to its model, rebuilt from the branch.
 *
 * Kept because prompts, memory extraction, and the legacy action ledger all
 * still read `parentText`, and because it is genuinely the highest-value single
 * line of context. It is now derived from a resolved parent rather than from
 * whichever article happened to render above.
 */
export function parentTextOf(conversation: ConversationContext): string | null {
  const text = conversation.parent?.text?.trim();
  return text ? text : null;
}
