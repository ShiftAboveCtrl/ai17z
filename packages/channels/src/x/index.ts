import type { NormalizedEvent, RadarPollResult, ResolvedContext } from '@xbam/shared/contracts';
import { PipelineError, errorMessage, textStandsAlone } from '@xbam/shared';
import {
  captureScreenshot,
  safeUrl,
  type TabRole,
} from '@xbam/browser';
import type {
  ActionRequest,
  ActionResult,
  AuthObservation,
  ChannelAdapter,
  CredentialSignInResult,
  LoginCredentials,
  RadarPollRequest,
  ChannelContext,
  ConnectionResult,
  DiagnosticCapture,
  HealthResult,
  IngestOptions,
  LookedUp,
  VerificationResult,
} from '../contract';
import { SEL, X_URLS, articleForStatus } from './selectors';
import { observeAuthPage } from './auth';
import { signInWithStoredCredentials } from './credentialSignIn';
import { X_MONITORS } from './monitors';
import { readMediaInventory } from './media';
import { readPage, webSearch } from './websearch';
import { type ArticleSnapshot, parentTextOf, resolveBranch } from './conversation';
import { buildStatusUrl, extractStatusId, looksUnavailable, normalizeHandle, normalizeTargetId } from './targets';
import {
  MAX_ARTICLES_READ,
  MAX_SCROLL_PASSES,
  goto,
  isAuthenticated,
  readArticle,
  readText,
  selfHandles,
  settle,
  withSession,
} from './page';
// Still exported from here: it is part of the package's public surface and
// moving a file is not a reason to move an import somebody else writes.
export { replyingToHandles } from './page';
import { engagePost } from './engagement';
import {
  findOwnReply,
  postOwn,
  replyOnPage,
} from './composer';
/*
  Still exported from here. These are part of the package's public surface
  and the tests that pin the composer's discipline import them by name; a
  file move is not a reason to change an import somebody else wrote.
*/
export { ensureEngaged } from './engagement';
export type { EngagementOutcome } from './engagement';
export { fingerprint, fillComposer, readyForTyping, submitComposer } from './composer';

/**
 * Which tab a radar source belongs on.
 *
 * Notifications and mention search are separate sources precisely because
 * either can miss things the other catches; running them on one tab would make
 * them take turns and reintroduce the single point of failure they exist to
 * remove.
 */
function monitorRole(kind: string): TabRole {
  return kind === 'notifications' ? 'NOTIFICATIONS' : 'MENTIONS';
}

export const xAdapter: ChannelAdapter = {
  id: 'x',
  displayName: 'X',
  capabilities: ['REPLY', 'POST', 'LIKE', 'REPOST'],
  requiresBrowser: true,

  async connect(ctx: ChannelContext): Promise<ConnectionResult> {
    return withSession(ctx, 'ACTION', async ({ page }) => {
      await goto(page, X_URLS.home);
      if (!(await isAuthenticated(page))) {
        return {
          status: 'NEEDS_AUTH',
          detail: 'Not signed in. Open the authentication browser and log in to X, then test the session again.',
        };
      }
      // The account switcher label is the most reliable place to read the handle.
      const label = await page
        .locator(SEL.loggedIn)
        .first()
        .getAttribute('aria-label')
        .catch(() => null);
      const handle = normalizeHandle(label?.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? null);
      return {
        status: 'CONNECTED',
        detail: handle ? `Signed in as @${handle}` : 'Signed in.',
        handle: handle ?? ctx.account.handle,
      };
    });
  },

  async disconnect(ctx: ChannelContext): Promise<void> {
    const { closeSession } = await import('@xbam/browser');
    await closeSession(ctx.account.id);
  },

  async healthCheck(ctx: ChannelContext): Promise<HealthResult> {
    try {
      return await withSession(ctx, 'ACTION', async ({ page }) => {
        await goto(page, X_URLS.home);
        const authed = await isAuthenticated(page);
        if (!authed) {
          return {
            status: 'degraded' as const,
            detail: 'Browser reachable but the X session is signed out.',
            authenticated: false,
          };
        }
        // Which account, not just whether. Reading it costs one attribute and
        // it is the difference between a health check that proves the agent can
        // work and one that proves a browser is open.
        const handle = await observeAuthPage(page).then((o) => o.handle ?? null).catch(() => null);
        return {
          status: 'healthy' as const,
          detail: handle ? `Signed in as @${handle}.` : 'Session is signed in.',
          authenticated: true,
          handle,
        };
      });
    } catch (error) {
      return { status: 'offline', detail: errorMessage(error), authenticated: false };
    }
  },

  /**
   * Reports what the open sign-in window shows, without touching it. The worker
   * polls this while a person signs in; every X-specific notion of what a
   * challenge looks like stays behind this call.
   */
  radarSourceKinds: [
    'notifications',
    'mention_search',
    'reply_search',
    'own_threads',
    'tracked_account',
    'tracked_keyword',
  ] as const,

  /**
   * Polls one radar source. Each is an independent, imperfect view; the
   * reconciler upstream merges them on the status id.
   */
  async pollRadarSource(ctx: ChannelContext, request: RadarPollRequest): Promise<RadarPollResult> {
    const monitor = X_MONITORS[request.kind];
    if (!monitor) {
      return { candidates: [], cursor: null, error: `X has no ${request.kind} monitor.` };
    }
    try {
      return await withSession(ctx, monitorRole(request.kind), async ({ page }) =>
        monitor({
          page,
          selfHandles: selfHandles(ctx),
          limit: request.limit,
          cursor: request.cursor,
          target: request.target,
        }),
      );
    } catch (error) {
      // A session that will not open is a source failure, not a job failure:
      // the radar records it and the other sources keep working.
      return { candidates: [], cursor: null, error: errorMessage(error) };
    }
  },

  /**
   * Looks something up, on the tab kept for exactly that.
   *
   * The browser is already open and signed in, so this costs nothing extra and
   * needs no search API key. It runs on RESEARCH so a lookup cannot disturb a
   * monitor mid-scroll or a reply mid-compose.
   */
  async lookUp(ctx: ChannelContext, request: { query: string; kind: 'search' | 'link' }): Promise<LookedUp[]> {
    return withSession(ctx, 'RESEARCH', async ({ page }) => {
      if (request.kind === 'link') {
        const read = await readPage(page, request.query);
        return read ? [read] : [];
      }
      return webSearch(page, request.query);
    });
  },

  async observeAuth(ctx: ChannelContext): Promise<AuthObservation> {
    try {
      return await withSession(ctx, 'ACTION', async ({ page }) => observeAuthPage(page));
    } catch (error) {
      return { state: 'UNREACHABLE', detail: errorMessage(error) };
    }
  },

  /**
   * Types the owner's stored sign-in details into X's login form.
   *
   * Opt-in and separate from `observeAuth`, which still only looks. The
   * navigation happens inside the same lease as the typing, because the action
   * tab is shared and a form filled on whatever page happened to be loaded is
   * a form filled somewhere nobody chose.
   *
   * The challenge boundary is not re-implemented here or in the worker: the
   * loop this delegates to reads the page through `observeAuthPage`, which
   * ranks a challenge above a login form, and returns the moment it sees one.
   */
  async signInWithCredentials(ctx: ChannelContext, credentials: LoginCredentials): Promise<CredentialSignInResult> {
    try {
      return await withSession(ctx, 'ACTION', async ({ page }) => {
        await goto(page, X_URLS.login);
        return signInWithStoredCredentials(page, credentials);
      });
    } catch (error) {
      return { observation: { state: 'UNREACHABLE', detail: errorMessage(error) }, filled: [] };
    }
  },

  async captureDiagnostics(ctx: ChannelContext, reason: string): Promise<DiagnosticCapture | null> {
    try {
      return await withSession(ctx, 'ACTION', async ({ page }) => {
        const shot = await captureScreenshot(page, ctx.storageDir, reason);
        return {
          kind: 'x_browser_failure',
          message: reason,
          url: safeUrl(page),
          screenshotRelPath: shot?.relPath ?? null,
          meta: { accountHandle: ctx.account.handle, bytes: shot?.bytes ?? 0 },
        };
      });
    } catch (error) {
      ctx.logger.warn('diagnostic capture failed', { message: errorMessage(error) });
      return null;
    }
  },
  async ingestEvents(ctx: ChannelContext, options: IngestOptions): Promise<NormalizedEvent[]> {
    return withSession(ctx, 'MENTIONS', async ({ page }) => {
      await goto(page, X_URLS.mentions);
      if (!(await isAuthenticated(page))) {
        throw PipelineError.permanent(
          'x_signed_out',
          'The X session is signed out. Reconnect the account before ingesting mentions.',
        );
      }
      await settle(1_200, 2_400);

      const me = selfHandles(ctx);
      const articles = page.locator(SEL.tweetArticle);

      // Scroll until there is enough to read, or the page stops growing.
      //
      // X renders a viewport's worth and loads the rest as you scroll, so
      // reading only what was there on arrival sees perhaps five mentions. That
      // is fine on a quiet account and wrong on a busy one: a burst larger than
      // the first screen leaves the older half unseen until it happens to drift
      // back up, which for the oldest of them is never.
      //
      // Bounded three ways -- enough articles, no new ones after a scroll, or a
      // hard cap -- because "scroll to the end" on an infinite feed is not a
      // thing that finishes.
      const wanted = Math.max(options.limit, 1) * 3;
      for (let pass = 0; pass < MAX_SCROLL_PASSES; pass += 1) {
        const before = await articles.count().catch(() => 0);
        if (before >= wanted) break;
        await page.mouse.wheel(0, 2_000).catch(() => undefined);
        await settle(600, 1_100);
        const after = await articles.count().catch(() => before);
        // Nothing new arrived: this is the end of what X will give us.
        if (after <= before) break;
      }

      const count = Math.min(await articles.count(), wanted);
      const events: NormalizedEvent[] = [];
      const seen = new Set<string>();

      for (let index = 0; index < count && events.length < options.limit; index += 1) {
        const snapshot = await readArticle(page, `${SEL.tweetArticle} >> nth=${index}`);
        if (!snapshot.statusId || seen.has(snapshot.statusId)) continue;
        seen.add(snapshot.statusId);
        // Never act on our own posts: this is what stops an agent replying to itself.
        if (snapshot.authorHandle && me.includes(snapshot.authorHandle)) continue;
        if (!snapshot.text) continue;

        events.push({
          channel: 'x',
          type: 'MENTION',
          remoteEventId: snapshot.statusId,
          remoteMessageId: snapshot.statusId,
          remoteAuthorId: null,
          remoteAuthorHandle: snapshot.authorHandle,
          remoteAuthorDisplayName: null,
          remoteConversationId: snapshot.statusId,
          parentRemoteMessageId: null,
          remoteUrl: snapshot.url,
          text: snapshot.text,
          occurredAt: new Date().toISOString(),
          raw: { source: 'notifications/mentions', index },
        });
      }
      ctx.logger.info('x mentions scraped', { found: events.length, scanned: count });
      return events;
    });
  },

  async resolveContext(ctx: ChannelContext, event: NormalizedEvent): Promise<ResolvedContext> {
    const targetRef = normalizeTargetId(event.remoteUrl ?? event.remoteMessageId ?? event.remoteEventId);
    const statusId = extractStatusId(targetRef ?? event.remoteEventId);
    if (!targetRef || !statusId) {
      throw PipelineError.permanent(
        'unresolvable_target',
        `Could not derive a canonical X status from "${event.remoteEventId}".`,
      );
    }

    return withSession(ctx, 'ACTION', async ({ page }) => {
      const url = buildStatusUrl(targetRef)!;
      await goto(page, url);

      const bodyText = await readText(page);
      if (looksUnavailable(bodyText)) {
        throw PipelineError.permanent('source_deleted', 'The source post no longer exists on X.', { url });
      }

      const anchor = articleForStatus(statusId);
      const found = await page
        .locator(anchor)
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!found) {
        throw PipelineError.retryable('article_not_rendered', `Status ${statusId} did not render on ${url}.`, { url });
      }

      const target = await readArticle(page, anchor);
      const me = selfHandles(ctx);

      // What is attached to the post. Read here rather than at ingest, because
      // the status page is where the media actually renders, and this is the one
      // place the page is already open.
      const inventory = await readMediaInventory(page, anchor, target.text || event.text).catch((error) => {
        ctx.logger.warn('media inventory failed', { message: errorMessage(error) });
        return { media: [], quoted: null, links: [] };
      });

      // Read every article on the page in order, then reason about them off the
      // page. Which of them is the mention, which are its ancestors, and which
      // belong to a different branch is decided in `resolveBranch`, where it is
      // covered by fixtures rather than by whatever X rendered today.
      const all = page.locator(SEL.tweetArticle);
      const count = await all.count();

      // Where the focal post actually sits, because the window has to include
      // it. The anchor above proved the status is somewhere in the DOM, not
      // that it is in the first twenty articles -- and on a busy page it is
      // not. That combination reported `focal_article_not_found` for a post the
      // page was plainly rendering, and retried it five times before giving up.
      const focalIndex = await all
        .evaluateAll(
          (nodes, id) => nodes.findIndex((node) => node.querySelector(`a[href*="/status/${id}"]`)),
          statusId,
        )
        .catch(() => -1);

      // The cap still holds for the ordinary case; it stretches only as far as
      // it must to take in the post being replied to.
      const total = focalIndex >= 0 ? Math.min(count, Math.max(MAX_ARTICLES_READ, focalIndex + 1)) : Math.min(count, MAX_ARTICLES_READ);
      const snapshots: ArticleSnapshot[] = [];
      for (let index = 0; index < total; index += 1) {
        snapshots.push(await readArticle(page, `${SEL.tweetArticle} >> nth=${index}`, index));
      }

      const outcome = resolveBranch({
        articles: snapshots,
        focalStatusId: statusId,
        selfHandles: me,
        quote: inventory.quoted,
      });

      // The anchor above already proved this status is on the page, so a failure
      // here means the page changed underneath us between the two reads.
      if (!outcome.ok) {
        throw PipelineError.retryable('branch_not_resolved', outcome.detail, { url, statusId, reason: outcome.reason });
      }
      const conversation = outcome.conversation;

      // What the parent post is carrying, when the mention leans on it.
      //
      // "@agent thoughts?" under a chart is a question about the chart. Reading
      // the parent's attachments costs one extra DOM pass, so it is only done
      // when the mention says little on its own and carries nothing itself —
      // which is exactly the case where answering without it means guessing.
      let parentInventory = null;
      const leansOnParent =
        conversation.parent?.remoteId &&
        inventory.media.length === 0 &&
        !inventory.quoted &&
        !textStandsAlone(conversation.incoming.text);
      if (leansOnParent) {
        parentInventory = await readMediaInventory(
          page,
          articleForStatus(conversation.parent!.remoteId!),
          conversation.parent!.text,
        ).catch(() => null);
      }

      // The invariant the whole design rests on: the action target is the post
      // that addressed the agent, never an ancestor. Everything else here is
      // context. If these ever disagree the reply is about to go to the wrong
      // person, so it stops rather than guessing.
      if (conversation.incoming.remoteId !== statusId) {
        throw PipelineError.permanent(
          'target_context_mismatch',
          `Resolved branch reports incoming post ${conversation.incoming.remoteId ?? 'unknown'} but the action target is ${statusId}.`,
        );
      }

      const thread: ResolvedContext['thread'] = conversation.ancestors.map((post) => ({
        role: post.isSelf ? ('OUTBOUND' as const) : ('INBOUND' as const),
        remoteMessageId: post.remoteId,
        authorHandle: post.authorHandle,
        text: post.text,
        createdAt: post.createdAt,
      }));

      return {
        targetRef,
        targetUrl: url,
        targetAuthorHandle: target.authorHandle ?? event.remoteAuthorHandle,
        conversationRef: conversation.root?.remoteId ?? statusId,
        incomingText: conversation.incoming.text || target.text || event.text,
        parentText: parentTextOf(conversation),
        thread,
        conversation,
        meta: {
          statusId,
          threadDepth: thread.length,
          articlesOnPage: snapshots.length,
          branchConfirmed: conversation.branchConfirmed,
          excludedFromOtherBranches: conversation.excludedCount,
          // Exposed rather than merged: this media belongs to the parent post,
          // not to the incoming one, and conflating them would tell the model
          // the wrong person attached it.
          parentInventory,
          resolvedAt: new Date().toISOString(),
          // Carried in meta so nothing downstream of the adapter has to know
          // what an X media container looks like.
          inventory,
        },
      };
    });
  },

  async verifyAction(ctx: ChannelContext, request: ActionRequest): Promise<VerificationResult> {
    // A post of the agent's own has no target. There is nothing to anchor to and
    // nothing to get wrong, so verification is about the session rather than a
    // status: is this account signed in and is it the account we think it is.
    if (request.type === 'POST') {
      return withSession(ctx, 'ACTION', async ({ page }) => {
        await goto(page, X_URLS.home);
        if (!(await isAuthenticated(page))) {
          return {
            verified: false,
            detail: 'The X session is signed out, so nothing can be posted.',
            targetRef: null,
            targetUrl: null,
            targetAuthorHandle: null,
            evidence: { authenticated: false },
          };
        }
        const handle = selfHandles(ctx)[0] ?? null;
        return {
          verified: true,
          detail: handle ? `Signed in as @${handle}. A post has no target to verify.` : 'Signed in.',
          targetRef: null,
          targetUrl: null,
          targetAuthorHandle: handle,
          evidence: { authenticated: true, actionType: 'POST' },
        };
      });
    }

    const targetRef = normalizeTargetId(request.targetRef);
    const statusId = extractStatusId(targetRef);
    const empty = { targetRef, targetUrl: null, targetAuthorHandle: null, evidence: {} as Record<string, unknown> };
    if (!targetRef || !statusId) {
      return { verified: false, detail: 'No canonical X status could be derived from the target.', ...empty };
    }

    return withSession(ctx, 'ACTION', async ({ page }) => {
      const url = buildStatusUrl(targetRef)!;
      await goto(page, url);

      const bodyText = await readText(page);
      if (looksUnavailable(bodyText)) {
        return {
          verified: false,
          detail: 'The target post has been deleted or is not visible to this account.',
          targetRef,
          targetUrl: url,
          targetAuthorHandle: null,
          evidence: { deleted: true },
        };
      }

      const anchor = articleForStatus(statusId);
      const attached = await page
        .locator(anchor)
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!attached) {
        return {
          verified: false,
          detail: `The article for status ${statusId} did not render, so the exact post could not be identified.`,
          targetRef,
          targetUrl: url,
          targetAuthorHandle: null,
          evidence: { rendered: false },
        };
      }

      const snapshot = await readArticle(page, anchor);
      if (snapshot.statusId !== statusId) {
        return {
          verified: false,
          detail: `Anchored article reports status ${snapshot.statusId ?? 'unknown'}, expected ${statusId}.`,
          targetRef,
          targetUrl: url,
          targetAuthorHandle: snapshot.authorHandle,
          evidence: { anchoredStatusId: snapshot.statusId },
        };
      }
      if (snapshot.authorHandle && selfHandles(ctx).includes(snapshot.authorHandle)) {
        return {
          verified: false,
          detail: `The target post belongs to this account (@${snapshot.authorHandle}). Refusing to self-reply.`,
          targetRef,
          targetUrl: url,
          targetAuthorHandle: snapshot.authorHandle,
          evidence: { selfReply: true },
        };
      }

      return {
        verified: true,
        detail: `Anchored to status ${statusId} by @${snapshot.authorHandle ?? 'unknown'}.`,
        targetRef,
        targetUrl: url,
        targetAuthorHandle: snapshot.authorHandle,
        evidence: { statusId, author: snapshot.authorHandle, textPreview: snapshot.text.slice(0, 200) },
      };
    });
  },

  /**
   * Looks on X for the thing this action would have done.
   *
   * The same read-back that confirms a fresh reply, asked before one is sent
   * rather than after. A worker can die between X accepting a reply and the row
   * being updated, and the only way to tell those apart is to go and look.
   */
  async wasAlreadyDone(ctx: ChannelContext, request: ActionRequest) {
    const me = selfHandles(ctx);
    const statusId = extractStatusId(normalizeTargetId(request.targetRef));

    return withSession(ctx, 'ACTION', async ({ page }) => {
      // A post has no target, so the account's own timeline is where to look.
      const where = request.type === 'POST' ? (me[0] ? X_URLS.profile(me[0]) : X_URLS.home) : buildStatusUrl(request.targetRef);
      if (!where) return { done: false, remoteActionId: null, remoteActionUrl: null, detail: 'No target to check.' };

      await goto(page, where);
      const found = await findOwnReply(page, request.text, me);
      if (!found) {
        return {
          done: false,
          remoteActionId: null,
          remoteActionUrl: null,
          detail: `Nothing matching this text is on ${statusId ? `status ${statusId}` : 'the timeline'}, so it was not sent.`,
        };
      }
      return {
        done: true,
        remoteActionId: found.statusId,
        remoteActionUrl: found.url,
        detail: `This was already sent as ${found.statusId}; the previous attempt succeeded before it was recorded.`,
      };
    });
  },

  async executeAction(ctx: ChannelContext, request: ActionRequest): Promise<ActionResult> {
    // LIKE was advertised in `capabilities` long before anything could perform
    // it, so an agent granted it queued work that always failed here.
    if (!['REPLY', 'POST', 'LIKE', 'REPOST'].includes(request.type)) {
      throw PipelineError.permanent('unsupported_action', `The X adapter cannot perform ${request.type} yet.`);
    }
    const verification = await xAdapter.verifyAction(ctx, request);
    if (!verification.verified) {
      // Refusing is the correct outcome: a reply sent to an unverified article is
      // worse than a reply that never goes out.
      throw PipelineError.review('target_unverified', verification.detail, { targetRef: request.targetRef });
    }
    if (request.dryRun) {
      return { status: 'DRY_RUN', remoteActionId: null, remoteActionUrl: null, verification };
    }
    if (request.type === 'POST') return postOwn(ctx, request, verification);
    if (request.type === 'LIKE' || request.type === 'REPOST') {
      return engagePost(ctx, request, verification, request.type);
    }

    return replyOnPage(ctx, request, verification);
  },
};
export { readPost, readProfile, parseCount, searchPosts, readThread } from './read';
