import type { NormalizedEvent, RadarPollResult, ResolvedContext } from '@xbam/shared/contracts';
import { PipelineError, envBool, errorMessage, sleep, textStandsAlone } from '@xbam/shared';
import {
  captureScreenshot,
  resolveProfileDir,
  leaseSession,
  safeUrl,
  retagIfLost,
  type LeasedSession,
  type Locator,
  type Page,
  type TabRole,
} from '@xbam/browser';
import type {
  ActionRequest,
  ActionResult,
  AuthObservation,
  ChannelAdapter,
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
import { X_MONITORS } from './monitors';
import { readMediaInventory } from './media';
import { readPage, webSearch } from './websearch';
import { type ArticleSnapshot, parentTextOf, resolveBranch } from './conversation';
import { buildStatusUrl, extractStatusId, handleFromUrl, looksUnavailable, normalizeHandle, normalizeTargetId } from './targets';

/**
 * How far down a status page to read.
 *
 * A busy thread renders hundreds of replies, and everything past the focal post
 * is a different branch anyway. Twenty covers a deep ancestor chain with room
 * to spare and keeps one context resolution to a few hundred milliseconds.
 */
const MAX_ARTICLES_READ = 20;

/**
 * How many times to scroll a feed looking for more.
 *
 * Eight passes of two thousand pixels reaches roughly sixty mentions, which is
 * far more than a poll every two minutes will ever need. The cap exists because
 * an infinite feed has no end to scroll to, and a poller that tries to find one
 * never returns.
 */
const MAX_SCROLL_PASSES = 8;

/**
 * Short randomised pause between UI steps.
 *
 * This exists for reliability, not for evading anything: the X timeline is a
 * virtualised list that re-renders asynchronously, and acting on the frame that
 * was there a moment ago is the single largest source of flaky automation.
 */
async function settle(minMs = 350, maxMs = 900): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Runs one operation on the tab that belongs to it.
 *
 * ACTION for anything that changes something on X or verifies where a change
 * will land; MENTIONS and NOTIFICATIONS for the two discovery surfaces. Reading
 * on one tab can no longer discard a composer open on another, and a monitor
 * that fails is recorded against its own tab rather than against the account.
 */
async function withSession<T>(
  ctx: ChannelContext,
  role: TabRole,
  fn: (session: LeasedSession) => Promise<T>,
): Promise<T> {
  const session = await leaseSession(
    {
      accountId: ctx.account.id,
      mode: ctx.session?.mode ?? 'MANAGED',
      profileDir: resolveProfileDir(ctx.account.id, ctx.session?.profileDir),
      cdpUrl: ctx.session?.cdpUrl ?? null,
      engine: ctx.session?.engine ?? 'GOOGLE_CHROME',
      channel: ctx.session?.channel ?? null,
      headless: envBool('AI17Z_BROWSER_HEADLESS', false),
    },
    role,
  );
  try {
    const result = await fn(session);
    await session.release();
    return result;
  } catch (error) {
    await session.releaseFailed(errorMessage(error));
    throw error;
  }
}

async function goto(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    throw PipelineError.retryable('navigation_failed', `Could not open ${url}: ${errorMessage(error)}`, { url }, error);
  }
  await settle(800, 1_600);
}

async function isAuthenticated(page: Page): Promise<boolean> {
  const marker = page.locator(SEL.loggedIn).first();
  try {
    await marker.waitFor({ state: 'visible', timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function readText(page: Page): Promise<string> {
  try {
    return (await page.locator('body').innerText({ timeout: 10_000 })) ?? '';
  } catch {
    return '';
  }
}

function selfHandles(ctx: ChannelContext): string[] {
  const configured = Array.isArray((ctx.account.settings as { selfHandles?: unknown }).selfHandles)
    ? ((ctx.account.settings as { selfHandles: unknown[] }).selfHandles as string[])
    : [];
  return [ctx.account.handle, ...configured]
    .map((h) => normalizeHandle(h))
    .filter((h): h is string => Boolean(h));
}

/**
 * Handles from the "Replying to @a @b" line X renders above a reply.
 *
 * There is no test id on that line, so it is read from the article's own text
 * rather than by selector — which also means a redesign of the markup does not
 * silently turn the cross-check off. X truncates the list ("and 3 others"), so
 * this is a confirmation signal and never the thing that picks a parent.
 */
export function replyingToHandles(articleText: string): string[] {
  const line = articleText.split('\n').find((l) => /^\s*replying to\b/i.test(l));
  if (!line) return [];
  return [...line.matchAll(/@([A-Za-z0-9_]{1,15})/g)]
    .map((m) => normalizeHandle(m[1]))
    .filter((h): h is string => Boolean(h));
}

/**
 * Whether a post says enough to be answered without looking at anything else.
 *
 * Deliberately crude and deliberately conservative: "thoughts?" and "this?" are
 * questions about something else, and treating them as self-contained is how an
 * agent answers confidently about a chart it never saw.
 */
// `textStandsAlone` now lives in @xbam/shared, because the runtime asks the
// same question when deciding whether an unread image is a gap worth admitting
// to, and the two copies had drifted into being a bare word count.

/** Reads one anchored article. All extraction is scoped to the article element. */
async function readArticle(page: Page, articleSelector: string, index = 0): Promise<ArticleSnapshot> {
  const article = page.locator(articleSelector).first();

  // An article's own permalink is the link wrapping its timestamp. Taking the
  // first `/status/` link instead meant an article carrying a quoted post could
  // report the quoted post's id as its own -- so the focal post was read under
  // the wrong id, `resolveBranch` could not find it, and the job retried five
  // times against a post the page was plainly showing before going to a person.
  //
  // Falls back to the first link, because an article with no timestamp is
  // stranger than one whose first link is the right one.
  const href =
    (await article
      .locator('a:has(time)')
      .first()
      .getAttribute('href')
      .catch(() => null)) ??
    (await article
      .locator('a[href*="/status/"]')
      .first()
      .getAttribute('href')
      .catch(() => null));
  const url = href ? `https://x.com${href.startsWith('/') ? href : `/${href}`}` : null;

  // "Display Name\n@handle\n·\n2h" is how X composes this block, so the first
  // line is the display name and the rest is machine detail.
  const nameBlock = await article
    .locator(SEL.userName)
    .first()
    .innerText()
    .catch(() => '');
  const handleFromName = nameBlock.match(/@([A-Za-z0-9_]{1,15})/)?.[1] ?? null;
  const displayName = nameBlock.split('\n')[0]?.trim() || null;

  const textParts = await article
    .locator(SEL.tweetText)
    .allInnerTexts()
    .catch(() => [] as string[]);

  const createdAt = await article
    .locator('time')
    .first()
    .getAttribute('datetime')
    .catch(() => null);

  // X marks a verified account with a badge inside the name block. Its absence
  // is reported as "not verified" only when the name block itself was readable;
  // an unread block is unknown, not unverified.
  const authorVerified = nameBlock
    ? (await article
        .locator(SEL.verifiedBadge)
        .first()
        .count()
        .catch(() => 0)) > 0
    : null;

  const whole = await article.innerText().catch(() => '');

  return {
    index,
    statusId: extractStatusId(url),
    authorHandle: normalizeHandle(handleFromName) ?? handleFromUrl(url),
    authorDisplayName: displayName && !displayName.startsWith('@') ? displayName : null,
    text: textParts.join('\n').trim(),
    url: normalizeTargetId(url),
    createdAt,
    authorVerified,
    replyingTo: replyingToHandles(whole),
  };
}

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
  capabilities: ['REPLY', 'POST', 'LIKE'],
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
    if (request.type !== 'REPLY' && request.type !== 'POST') {
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

    const statusId = extractStatusId(verification.targetRef)!;
    const anchor = articleForStatus(statusId);

    return withSession(ctx, 'ACTION', async ({ page }) => {
      // Navigate here rather than trusting where verifyAction left the tab.
      //
      // Verification and execution are separate leases, and anything else can
      // use the action tab in between — a scheduled post navigates it to the
      // compose page, a finished reply returns it to the timeline. Acting on
      // whatever happens to be loaded is how an automation replies to the wrong
      // post, and it is why this failed with "the composer did not open" while
      // sitting on /compose/post.
      const url = buildStatusUrl(verification.targetRef)!;
      await goto(page, url);

      const article = page.locator(anchor).first();
      const rendered = await article
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!rendered) {
        throw PipelineError.retryable(
          'target_not_rendered',
          `Status ${statusId} did not render on ${url}, so there was nothing to reply to.`,
          { url },
        );
      }

      // Re-check the author on the freshly loaded page. The verification a
      // moment ago was on a different load, and this is the last look before
      // something irreversible.
      const onPage = await readArticle(page, anchor);
      if (onPage.statusId !== statusId) {
        throw PipelineError.review(
          'target_moved',
          `The anchored article now reports status ${onPage.statusId ?? 'unknown'}, expected ${statusId}.`,
        );
      }
      if (onPage.authorHandle && selfHandles(ctx).includes(onPage.authorHandle)) {
        throw PipelineError.permanent('self_reply', `The target post belongs to this account (@${onPage.authorHandle}).`);
      }

      const replyButton = article.locator(SEL.replyButton).first();
      if (!(await replyButton.isVisible().catch(() => false))) {
        throw PipelineError.retryable('reply_button_missing', 'The reply control was not visible on the target post.');
      }
      await replyButton.click({ timeout: 10_000 });

      const opened = await openComposer(page);
      if (!opened) {
        throw PipelineError.retryable('composer_did_not_open', 'The reply composer did not open.');
      }

      // The last chance to notice the composer belongs to a different post than
      // the one that was anchored. AI4CZ wrote this check and never called it.
      const expected = verification.targetAuthorHandle;
      if (opened.inDialog && expected) {
        const replyingTo = await composerReplyingTo(page);
        if (replyingTo.length > 0 && !replyingTo.includes(expected)) {
          throw PipelineError.review(
            'composer_wrong_target',
            `The composer says it is replying to @${replyingTo.join(', @')}, but the target is @${expected}.`,
            { expected, replyingTo },
          );
        }
      }

      // Focused rather than clicked. X's @-mention typeahead opens over the
      // composer and swallows pointer events, so a click waits thirty seconds
      // for an element that is visible, enabled, stable, and covered. Focus
      // needs no pointer at all, and typing focuses anyway.
      //
      // Verified rather than assumed, and retried once: this used to check only
      // that the composer was not empty, so a reply typed in halfway would have
      // been submitted halfway.
      await fillComposer(page, opened.editor, request.text);

      await submitComposer(page, opened);

      // Whichever composer it was, it going away is the signal X accepted it.
      const closed = await opened.editor
        .waitFor({ state: 'detached', timeout: 20_000 })
        .then(() => true)
        .catch(async () =>
          // An inline composer is not detached, only emptied.
          ((await opened.editor.innerText().catch(() => 'x')) ?? '').trim().length === 0,
        );
      if (!closed) {
        // A composer that has not gone is usually a reply X did not accept, and
        // occasionally one it accepted while the editor stayed on screen. Those
        // look identical from here and are opposite: retrying the first is
        // correct, retrying the second posts twice. So go and look before
        // deciding, which is the only thing that actually distinguishes them.
        const sent = await findOwnReply(page, request.text, selfHandles(ctx));
        if (!sent) {
          throw PipelineError.retryable('composer_did_not_close', 'The composer stayed open, so the reply was not accepted.');
        }
        await returnToIdle(page);
        return {
          status: 'EXECUTED' as const,
          remoteActionId: sent.statusId,
          remoteActionUrl: sent.url,
          verification: {
            ...verification,
            detail: `${verification.detail} The composer stayed open, but the reply is on the thread as ${sent.statusId}.`,
            evidence: { ...verification.evidence, readBackConfirmed: true, composerStayedOpen: true },
          },
        };
      }

      await settle(1_500, 2_800);
      // Read back rather than treating a closed dialog as proof, which is where
      // the legacy poster reported success it had not actually confirmed.
      const readBack = await findOwnReply(page, request.text, selfHandles(ctx));
      // Leave the action tab somewhere harmless. A tab parked on a stranger's
      // status page is one keystroke from doing something nobody asked for, and
      // the next action navigates from wherever it finds itself.
      await returnToIdle(page);
      if (!readBack) {
        return {
          status: 'EXECUTED' as const,
          remoteActionId: null,
          remoteActionUrl: null,
          verification: {
            ...verification,
            detail: `${verification.detail} Reply submitted, but it was not visible on read-back.`,
            evidence: { ...verification.evidence, readBackConfirmed: false },
          },
        };
      }
      return {
        status: 'EXECUTED' as const,
        remoteActionId: readBack.statusId,
        remoteActionUrl: readBack.url,
        verification: {
          ...verification,
          detail: `${verification.detail} Reply confirmed on read-back as ${readBack.statusId}.`,
          evidence: { ...verification.evidence, readBackConfirmed: true, replyStatusId: readBack.statusId },
        },
      };
    });
  },
};

interface OpenComposer {
  scope: ReturnType<Page['locator']>;
  editor: ReturnType<Page['locator']>;
  inDialog: boolean;
}

/**
 * Waits for a composer to appear, wherever X decided to put it.
 *
 * Clicking reply usually opens a dialog and sometimes just focuses the box
 * already sitting under the post on a status page. The old code waited only for
 * the dialog, and did so with an instant visibility check after a fixed pause —
 * so it reported "the reply composer did not open" while one was plainly on
 * screen, which is a bad thing for an automation to be wrong about.
 *
 * Waits for the editor itself, because that is the thing that has to be typed
 * into, and reports which container it landed in so the caller knows whether
 * the "replying to" line is available to check.
 */
async function openComposer(page: Page, timeoutMs = 15_000): Promise<OpenComposer | null> {
  const editor = page.locator(SEL.anyComposer).first();
  const appeared = await editor
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return null;

  // The *visible* dialog, not the first one.
  //
  // X renders two `role="dialog"` nodes on the compose route and the first is
  // hidden. Taking `.first()` and asking whether it is visible therefore
  // concluded "not in a dialog", which scoped the submit button to `main` --
  // where the only candidate is the inline composer's button, permanently
  // disabled because the inline composer is empty. The text went into the
  // dialog, the dialog's own button was enabled, and the code was looking at a
  // different button on the page behind it.
  //
  // Five live attempts failed on "X did not enable the post button" while a
  // diagnostic screenshot showed an enabled Post button holding the right text.
  const dialog = await visibleDialog(page);
  const inDialog = dialog !== null;
  return {
    scope: dialog ?? page.locator('main').first(),
    editor: dialog ? dialog.locator(SEL.anyComposer).first() : editor,
    inDialog,
  };
}

/**
 * Sends what is in the composer.
 *
 * Two ways, in order of preference. The button is the honest one: it is what a
 * person clicks, and X disables it until the editor is genuinely ready. But the
 * @-mention typeahead opens over the composer and swallows pointer events, so
 * the click can wait out its timeout against a button that is perfectly fine
 * and merely covered. The keyboard shortcut goes through the same handler and
 * no overlay can intercept it.
 */
async function submitComposer(page: Page, opened: OpenComposer): Promise<void> {
  const submit = opened.scope.locator(SEL.anySubmit).first();
  const ready = await submit
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (ready && (await submit.isEnabled().catch(() => false))) {
    // Short timeout: if something is covering it, fall through rather than
    // spending thirty seconds finding that out.
    const clicked = await submit
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) return;
  }

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
}

/**
 * The dialog a person can actually see.
 *
 * X renders more than one `role="dialog"` node and the first in the DOM is
 * hidden. Every place that took `.first()` was therefore reading an empty
 * element and drawing a confident conclusion from it:
 *
 *   - the composer scope picked the page behind the dialog, so the submit
 *     button it watched was the inline composer's, permanently disabled;
 *   - `composerReplyingTo` read no text, found no "Replying to" line, and
 *     returned nothing -- which made the wrong-target guard skip itself,
 *     because the caller only acts on a non-empty result;
 *   - `returnToIdle` decided no dialog was open and left one up.
 *
 * The middle one is the reason this is a helper rather than three fixes: a
 * safety check that silently stops checking is worse than one that fails.
 */
async function visibleDialog(page: Page): Promise<Locator | null> {
  const dialogs = page.locator(SEL.dialog);
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = dialogs.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/** Handles from the composer's own "Replying to @someone" line. */
async function composerReplyingTo(page: Page): Promise<string[]> {
  const dialog = await visibleDialog(page);
  if (!dialog) return [];
  const text = await dialog.innerText().catch(() => '');
  const line = text.split('\n').find((l) => /^\s*replying to\b/i.test(l));
  if (!line) return [];
  return [...line.matchAll(/@([A-Za-z0-9_]{1,15})/g)]
    .map((m) => normalizeHandle(m[1]))
    .filter((h): h is string => Boolean(h));
}

/**
 * Puts the action tab back to a known state after acting.
 *
 * Best-effort by design: a failure here has nothing to do with whether the
 * reply was sent, and reporting it as one would be wrong.
 */
/**
 * Polls until a control becomes enabled, or gives up.
 *
 * Playwright has no built-in wait for "enabled", only for visible, attached,
 * stable and editable. X toggles `aria-disabled` on its submit buttons a beat
 * after the composer changes, so a single check is a coin toss.
 */
async function waitForEnabled(locator: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

async function returnToIdle(page: Page): Promise<void> {
  try {
    if (await visibleDialog(page)) {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await page.goto(X_URLS.home, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    // Re-assert the tag, because that navigation just cleared it.
    //
    // A tab is identified by `window.name`, and a navigation wipes it. Leases
    // retag on the way in, so work always found its tab -- but between actions
    // the action tab sat at /home with an empty name. Health reported ACTION as
    // MISSING while the tab was plainly open, and adoption fell back to "any
    // untagged tab", which is a guess: open a tab yourself and it could have
    // been adopted as the one AI17Z posts from.
    await retagIfLost(page, 'ACTION');
  } catch {
    // Nothing to do about it, and nothing depends on it.
  }
}

/** Looks for the reply we just sent, matching on author and text prefix. */
/**
 * Reduces text to the letters and digits in it, lowercased.
 *
 * Because what we submitted and what X renders are never byte-identical. X
 * turns every @mention into a link element, and `innerText` puts whitespace
 * around a link: "@someone-August" comes back as "@someone -August". Smart
 * quotes, non-breaking spaces and zero-width characters do the same kind of
 * thing more quietly.
 *
 * This mattered more than it looks. Failing to recognise its own reply is not
 * a cosmetic problem: it is the check that tells "X refused this" apart from
 * "X accepted it and left the composer up", and retrying the second posts
 * twice. Two near-duplicate replies on the account are what this looked like
 * from outside.
 */
export function fingerprint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function scanForOwnReply(
  page: Page,
  needle: string,
  me: string[],
): Promise<{ statusId: string; url: string | null } | null> {
  const articles = page.locator(SEL.tweetArticle);
  const count = Math.min(await articles.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const snapshot = await readArticle(page, `${SEL.tweetArticle} >> nth=${index}`);
    if (!snapshot.statusId || !snapshot.authorHandle) continue;
    if (!me.includes(snapshot.authorHandle)) continue;
    if (!fingerprint(snapshot.text).includes(needle)) continue;
    return { statusId: snapshot.statusId, url: snapshot.url };
  }
  return null;
}

/**
 * Puts the text into the composer, and proves it went in.
 *
 * Typing at X's editor fails often enough to matter: the @-mention typeahead
 * opens over it and takes focus, and the editor is sometimes re-rendered
 * between being located and being typed into. A live run hit this four times in
 * a row on one reply and gave up -- which for an agent meant to run unattended
 * is the difference between working and needing somebody.
 *
 * So it is attempted twice, and the second attempt clears first: a composer
 * holding half the text is worse than an empty one, because the half would have
 * been published.
 *
 * The check is on the fingerprint, not the raw string, because X's editor turns
 * a typed @mention into a link node and innerText puts spaces around it.
 */
async function fillComposer(page: Page, editor: Locator, text: string): Promise<string> {
  const wanted = fingerprint(text).slice(0, 60);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      // Clear whatever landed. Select-all inside the editor, not the page.
      await editor.focus().catch(() => undefined);
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.press('Delete').catch(() => undefined);
      await settle(300, 600);
    }

    await editor.focus().catch(() => undefined);
    await editor.type(text, { delay: 12 }).catch(() => undefined);
    await settle(400, 900);

    const typed = (await editor.innerText().catch(() => '')).trim();
    if (typed && (!wanted || fingerprint(typed).includes(wanted))) return typed;
  }

  const finally_ = (await editor.innerText().catch(() => '')).trim();
  throw PipelineError.retryable(
    finally_ ? 'composer_text_mismatch' : 'composer_empty',
    finally_
      ? 'The composer does not hold the text that was typed into it, after two attempts.'
      : 'The composer was still empty after typing, twice.',
    { typed: finally_.slice(0, 120) },
  );
}

async function findOwnReply(
  page: Page,
  text: string,
  me: string[],
  reloads = 1,
): Promise<{ statusId: string; url: string | null } | null> {
  // Sixty characters of fingerprint, not forty of raw text: stripping the
  // punctuation costs length, and a short needle matches the wrong post.
  const needle = fingerprint(text).slice(0, 60);
  if (!needle) return null;

  const first = await scanForOwnReply(page, needle, me);
  if (first) return first;

  // Reload before giving up. X does not always graft a new post into the page
  // it is showing, and the difference between "not there" and "not rendered
  // yet" is the difference between posting once and posting twice -- so it is
  // worth a few seconds to ask again properly.
  //
  // A profile timeline lags further behind than a status page, which is why the
  // post path asks for more attempts than the reply path: a real post appeared
  // at the top of the profile moments after being reported unconfirmed.
  for (let attempt = 0; attempt < reloads; attempt += 1) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000 + attempt * 2_000);
    const found = await scanForOwnReply(page, needle, me);
    if (found) return found;
  }
  return null;
}

/**
 * Posting something the agent decided to say.
 *
 * Deliberately not a variation on the reply path. A reply is anchored to
 * somebody else's post and most of its risk is landing in the wrong place; a
 * post has no target and all of its risk is going out twice or going out empty.
 * So the checks are different: the composer is proved to hold the text before
 * submitting, and the post is found on the account's own timeline afterwards
 * rather than assumed from a closed dialog.
 */
async function postOwn(
  ctx: ChannelContext,
  request: ActionRequest,
  verification: VerificationResult,
): Promise<ActionResult> {
  const me = selfHandles(ctx);

  return withSession(ctx, 'ACTION', async ({ page }) => {
    // The compose route opens a dialog on its own. When X changes it, the
    // timeline's inline composer is the fallback rather than a failure.
    await goto(page, X_URLS.compose);
    let opened = await openComposer(page, 8_000);

    if (!opened) {
      // The compose route did not give us one; the timeline's own composer is
      // the fallback rather than a failure.
      await goto(page, X_URLS.home);
      opened = await openComposer(page, 10_000);
      if (!opened) {
        throw PipelineError.retryable('composer_did_not_open', 'The post composer did not open.');
      }
    }
    const composer = opened.editor;
    const submit = opened.scope.locator(SEL.anySubmit).first();

    await composer.focus();
    // Typed rather than pasted: X only enables the submit button once its editor
    // has processed real input events. Proved to hold the right text before
    // submitting, because posting a mangled composer publishes the mangling.
    await fillComposer(page, composer, request.text);

    // Wait for X to enable the button rather than asking once.
    //
    // A live post failed five times on "X did not enable the post button", and
    // the diagnostic screenshot taken at the moment of failure showed the
    // dialog holding the right text with the Post button plainly enabled. X
    // enables it on a debounce after input, and this asked immediately after
    // typing and never looked again -- so the check was racing a UI that was
    // about to agree with it.
    //
    // `aria-disabled` is what X actually sets, which Playwright's `isEnabled`
    // understands; the problem was never the predicate, only when it was asked.
    const enabled = await submit
      .isEnabled()
      .then((ok) => ok || waitForEnabled(submit, 10_000))
      .catch(() => false);
    if (!enabled) {
      throw PipelineError.retryable(
        'post_button_disabled',
        'X did not enable the post button within ten seconds of the text being typed.',
      );
    }
    await submitComposer(page, opened);
    await settle(2_000, 3_500);

    // Read back from the account's own timeline. A dialog that closed is not
    // evidence that anything was published, which is the mistake the legacy
    // poster made and reported as success.
    const handle = me[0];
    if (!handle) {
      return {
        status: 'EXECUTED' as const,
        remoteActionId: null,
        remoteActionUrl: null,
        verification: {
          ...verification,
          detail: 'Post submitted. This account has no handle recorded, so it could not be confirmed.',
          evidence: { ...verification.evidence, readBackConfirmed: false },
        },
      };
    }

    await goto(page, X_URLS.profile(handle));
    const readBack = await findOwnReply(page, request.text, me, 3);
    await returnToIdle(page);

    if (!readBack) {
      // Reported as executed but unconfirmed rather than retried: retrying a
      // post that may already be live is how an account posts twice.
      return {
        status: 'EXECUTED' as const,
        remoteActionId: null,
        remoteActionUrl: null,
        verification: {
          ...verification,
          detail: 'Post submitted, but it was not visible on the profile on read-back.',
          evidence: { ...verification.evidence, readBackConfirmed: false },
        },
      };
    }

    return {
      status: 'EXECUTED' as const,
      remoteActionId: readBack.statusId,
      remoteActionUrl: readBack.url,
      verification: {
        ...verification,
        detail: `Post confirmed on the profile as ${readBack.statusId}.`,
        evidence: { ...verification.evidence, readBackConfirmed: true, postStatusId: readBack.statusId },
      },
    };
  });
}
