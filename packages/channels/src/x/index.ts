import type { NormalizedEvent, RadarPollResult, ResolvedContext } from '@xbam/shared/contracts';
import { PipelineError, envBool, errorMessage, sleep } from '@xbam/shared';
import { captureScreenshot, resolveProfileDir, leaseSession, safeUrl, type LeasedSession, type Page } from '@xbam/browser';
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
  VerificationResult,
} from '../contract';
import { SEL, X_URLS, articleForStatus } from './selectors';
import { observeAuthPage } from './auth';
import { X_MONITORS } from './monitors';
import { readMediaInventory } from './media';
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
 * Short randomised pause between UI steps.
 *
 * This exists for reliability, not for evading anything: the X timeline is a
 * virtualised list that re-renders asynchronously, and acting on the frame that
 * was there a moment ago is the single largest source of flaky automation.
 */
async function settle(minMs = 350, maxMs = 900): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

async function withSession<T>(ctx: ChannelContext, fn: (session: LeasedSession) => Promise<T>): Promise<T> {
  const session = await leaseSession({
    accountId: ctx.account.id,
    mode: ctx.session?.mode ?? 'MANAGED',
    profileDir: resolveProfileDir(ctx.account.id, ctx.session?.profileDir),
    cdpUrl: ctx.session?.cdpUrl ?? null,
    engine: ctx.session?.engine ?? 'GOOGLE_CHROME',
    channel: ctx.session?.channel ?? null,
    headless: envBool('XBAM_BROWSER_HEADLESS', false),
  });
  try {
    return await fn(session);
  } finally {
    await session.release();
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
function textStandsAlone(text: string): boolean {
  const withoutNoise = text.replace(/@[A-Za-z0-9_]{1,15}/g, '').replace(/https?:\/\/\S+/g, '').trim();
  return withoutNoise.split(/\s+/).filter(Boolean).length >= 8;
}

/** Reads one anchored article. All extraction is scoped to the article element. */
async function readArticle(page: Page, articleSelector: string, index = 0): Promise<ArticleSnapshot> {
  const article = page.locator(articleSelector).first();
  const href = await article
    .locator('a[href*="/status/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);
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

  const whole = await article.innerText().catch(() => '');

  return {
    index,
    statusId: extractStatusId(url),
    authorHandle: normalizeHandle(handleFromName) ?? handleFromUrl(url),
    authorDisplayName: displayName && !displayName.startsWith('@') ? displayName : null,
    text: textParts.join('\n').trim(),
    url: normalizeTargetId(url),
    createdAt,
    replyingTo: replyingToHandles(whole),
  };
}

export const xAdapter: ChannelAdapter = {
  id: 'x',
  displayName: 'X',
  capabilities: ['REPLY', 'POST', 'LIKE'],
  requiresBrowser: true,

  async connect(ctx: ChannelContext): Promise<ConnectionResult> {
    return withSession(ctx, async ({ page }) => {
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
      return await withSession(ctx, async ({ page }) => {
        await goto(page, X_URLS.home);
        const authed = await isAuthenticated(page);
        return authed
          ? { status: 'healthy' as const, detail: 'Session is signed in.', authenticated: true }
          : { status: 'degraded' as const, detail: 'Browser reachable but the X session is signed out.', authenticated: false };
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
      return await withSession(ctx, async ({ page }) =>
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

  async observeAuth(ctx: ChannelContext): Promise<AuthObservation> {
    try {
      return await withSession(ctx, async ({ page }) => observeAuthPage(page));
    } catch (error) {
      return { state: 'UNREACHABLE', detail: errorMessage(error) };
    }
  },

  async captureDiagnostics(ctx: ChannelContext, reason: string): Promise<DiagnosticCapture | null> {
    try {
      return await withSession(ctx, async ({ page }) => {
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
    return withSession(ctx, async ({ page }) => {
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
      const count = Math.min(await articles.count(), Math.max(options.limit, 1) * 3);
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

    return withSession(ctx, async ({ page }) => {
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
      const total = Math.min(await all.count(), MAX_ARTICLES_READ);
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
    const targetRef = normalizeTargetId(request.targetRef);
    const statusId = extractStatusId(targetRef);
    const empty = { targetRef, targetUrl: null, targetAuthorHandle: null, evidence: {} as Record<string, unknown> };
    if (!targetRef || !statusId) {
      return { verified: false, detail: 'No canonical X status could be derived from the target.', ...empty };
    }

    return withSession(ctx, async ({ page }) => {
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

  async executeAction(ctx: ChannelContext, request: ActionRequest): Promise<ActionResult> {
    if (request.type !== 'REPLY') {
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

    const statusId = extractStatusId(verification.targetRef)!;
    const anchor = articleForStatus(statusId);

    return withSession(ctx, async ({ page }) => {
      const article = page.locator(anchor).first();
      const replyButton = article.locator(SEL.replyButton).first();
      if (!(await replyButton.isVisible().catch(() => false))) {
        throw PipelineError.retryable('reply_button_missing', 'The reply control was not visible on the target post.');
      }
      await replyButton.click({ timeout: 10_000 });
      await settle(600, 1_400);

      const dialog = page.locator(SEL.dialog).first();
      if (!(await dialog.isVisible().catch(() => false))) {
        throw PipelineError.retryable('composer_did_not_open', 'The reply composer did not open.');
      }

      const composer = dialog.locator(SEL.composer).first();
      await composer.waitFor({ state: 'visible', timeout: 10_000 });
      await composer.click();
      // Typed rather than pasted: X only enables the submit button once its editor
      // has processed real input events.
      await composer.type(request.text, { delay: 12 });
      await settle(400, 900);

      const typed = (await composer.innerText().catch(() => '')).trim();
      if (!typed) {
        throw PipelineError.retryable('composer_empty', 'The composer was still empty after typing the reply.');
      }

      const submit = dialog.locator(`${SEL.submitInline}, ${SEL.submitButton}`).first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.click({ timeout: 10_000 });
      } else {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      }

      const closed = await dialog
        .waitFor({ state: 'detached', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (!closed) {
        throw PipelineError.retryable('composer_did_not_close', 'The composer stayed open, so the reply was not accepted.');
      }

      await settle(1_500, 2_800);
      // Read back rather than treating a closed dialog as proof, which is where
      // the legacy poster reported success it had not actually confirmed.
      const readBack = await findOwnReply(page, request.text, selfHandles(ctx));
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

/** Looks for the reply we just sent, matching on author and text prefix. */
async function findOwnReply(
  page: Page,
  text: string,
  me: string[],
): Promise<{ statusId: string; url: string | null } | null> {
  const needle = text.replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase();
  const articles = page.locator(SEL.tweetArticle);
  const count = Math.min(await articles.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const snapshot = await readArticle(page, `${SEL.tweetArticle} >> nth=${index}`);
    if (!snapshot.statusId || !snapshot.authorHandle) continue;
    if (!me.includes(snapshot.authorHandle)) continue;
    if (!snapshot.text.replace(/\s+/g, ' ').toLowerCase().includes(needle)) continue;
    return { statusId: snapshot.statusId, url: snapshot.url };
  }
  return null;
}
