import { PipelineError } from '@xbam/shared';
import type { NormalizedEvent, ResolvedContext } from '@xbam/shared/contracts';
import type {
  ActionRequest,
  ActionResult,
  ChannelAdapter,
  ChannelContext,
  ConnectionResult,
  DiagnosticCapture,
  HealthResult,
  IngestOptions,
  VerificationResult,
} from '../contract';
import {
  BlueskyApiError,
  BlueskyTransportError,
  authed,
  classifyBlueskyError,
  createSession,
  endSession,
  ensureSession,
  forgetBlueskySession,
} from './client';
import {
  conversationFromBranch,
  inventoryIfAny,
  notificationToEvent,
  parseNotifications,
  type PostView,
} from './normalise';
import {
  fetchPostViews,
  resolveHandle,
  resolvePostUri,
  targetOf,
  threadBranchOf,
} from './reads';
import { buildFacets, lengthProblem } from './text';
import { LIKE_COLLECTION, POST_COLLECTION, parseAtUri, postPermalink } from './uri';
import { notificationsResume, notificationsSeenThrough } from './watermark';

/**
 * Bluesky, over the AT Protocol's HTTP API.
 *
 * No browser, so no session to keep open, no tab to lease and nothing for the
 * resource governor to worry about. What it has instead is a server that
 * rate-limits and a password that must never leak, and both are handled in
 * `client.ts`.
 *
 * The contract it keeps is the one every channel keeps: events leave as
 * `NormalizedEvent`, context as `ResolvedContext`, and nothing about records,
 * CIDs or lexicons crosses into the pipeline. The CID of a post is the single
 * piece of protocol a reply needs (the parent and root must be quoted by URI
 * and CID), so it is fetched at verification time, from the post itself, and
 * never taken from the event.
 */

/** A page of notifications, at the API's own ceiling. */
const NOTIFICATION_PAGE = 50;
/**
 * How many pages one poll may read when it knows where it stopped last time.
 *
 * Bounded, because the poll is a read against the one budget and "read until
 * you run out" is how a busy account spends all of it on history. Two hundred
 * new notifications between two polls is already unusual.
 */
const NOTIFICATION_PAGES_PER_POLL = 4;
/** How far back a scan for an action that may already have happened looks. */
const RECOVERY_PAGE = 100;
/** A scan only proves absence if it reached back further than an action could be old. */
const RECOVERY_HORIZON_MS = 6 * 60 * 60_000;

function selfOf(session: { did: string; handle: string }): { did: string; handle: string } {
  return { did: session.did, handle: session.handle };
}

function failureStatus(error: unknown): { status: ConnectionResult['status']; detail: string } {
  if (error instanceof PipelineError) {
    if (error.reason === 'bluesky_auth_challenge') return { status: 'CHALLENGE_REQUIRES_USER', detail: error.message };
    if (error.reason === 'bluesky_auth_failed' || error.reason === 'bluesky_no_credentials') {
      return { status: 'NEEDS_AUTH', detail: error.message };
    }
    return { status: 'ERROR', detail: error.message };
  }
  return { status: 'ERROR', detail: error instanceof Error ? error.message : String(error) };
}

/** The post an action is about, fetched fresh so its CID is current. */
async function targetPost(ctx: ChannelContext, targetRef: string): Promise<PostView | null> {
  const uri = await resolvePostUri(ctx, targetRef);
  const [view] = await fetchPostViews(ctx, [uri]);
  return view ?? null;
}

function unverified(detail: string, targetRef: string | null = null): VerificationResult {
  return { verified: false, detail, targetRef, targetUrl: null, targetAuthorHandle: null, evidence: {} };
}

async function verifyPost(ctx: ChannelContext, request: ActionRequest): Promise<VerificationResult> {
  // A post has no target. What can be checked is that it would be accepted and
  // that the account can sign in, which is checked by asking for the session.
  if (request.type === 'POST') {
    const problem = lengthProblem(request.text);
    if (problem) return unverified(problem);
    await ensureSession(ctx, targetOf(ctx));
    return {
      verified: true,
      detail: 'A post has no target; the text fits and the account is signed in.',
      targetRef: null,
      targetUrl: null,
      targetAuthorHandle: null,
      evidence: { post: true },
    };
  }

  if (request.type !== 'REPLY' && request.type !== 'LIKE') {
    return unverified(`Bluesky does not support ${request.type} yet.`);
  }
  if (!request.targetRef) return unverified('No target reference was supplied.');

  if (request.type === 'REPLY') {
    const problem = lengthProblem(request.text);
    if (problem) return unverified(problem, request.targetRef);
  }

  const view = await targetPost(ctx, request.targetRef);
  if (!view) return unverified('That post was not found. It may have been deleted.', request.targetRef);

  const base = {
    targetRef: view.uri,
    targetUrl: postPermalink(view.author.handle, view.uri),
    targetAuthorHandle: view.author.handle,
  };

  if (request.type === 'REPLY') {
    if (view.author.viewer?.blockedBy === true) {
      return { verified: false, detail: `@${view.author.handle} has blocked this account, so a reply would be refused.`, ...base, evidence: {} };
    }
    if (view.viewer?.replyDisabled === true) {
      return { verified: false, detail: 'The author limited who can reply to this post, and this account is not among them.', ...base, evidence: {} };
    }
    // A reply quotes its parent and its thread's root, each by URI and CID. If
    // the parent is itself a reply, the root is the one it already names.
    const root = view.record.reply?.root ?? { uri: view.uri, cid: view.cid };
    return {
      verified: true,
      detail: `Bluesky post ${view.uri} resolved and can be replied to.`,
      ...base,
      evidence: { parent: { uri: view.uri, cid: view.cid }, root: { uri: root.uri, cid: root.cid } },
    };
  }

  return {
    verified: true,
    detail: `Bluesky post ${view.uri} resolved.`,
    ...base,
    evidence: { cid: view.cid, likeUri: view.viewer?.like ?? null },
  };
}

/**
 * Whether the account already wrote this, by looking at what it wrote.
 *
 * Read off the repository itself (`listRecords`), which is the authority on what
 * was written, rather than off a feed that is assembled a moment later. Only a
 * scan that provably reached back past the age an action could have is called
 * conclusive: a miss in a page that stopped early is an absence of evidence.
 */
async function scanOwnPosts(
  ctx: ChannelContext,
  request: ActionRequest,
): Promise<{ found: { uri: string; cid: string } | null; conclusive: boolean }> {
  const session = await ensureSession(ctx, targetOf(ctx));
  const body = await authed<{ records?: unknown[]; cursor?: string }>(ctx, targetOf(ctx), 'com.atproto.repo.listRecords', {
    params: { repo: session.did, collection: POST_COLLECTION, limit: RECOVERY_PAGE },
  });
  const records = Array.isArray(body.records) ? body.records : [];

  const dated: number[] = [];
  for (const entry of records) {
    const record = entry as { uri?: unknown; cid?: unknown; value?: { text?: unknown; createdAt?: unknown; reply?: { parent?: { uri?: unknown } } } };
    const at = typeof record.value?.createdAt === 'string' ? Date.parse(record.value.createdAt) : NaN;
    if (Number.isFinite(at)) dated.push(at);

    const isReply = Boolean(record.value?.reply);
    const sameShape = request.type === 'REPLY' ? isReply && record.value?.reply?.parent?.uri === request.targetRef : !isReply;
    if (sameShape && record.value?.text === request.text && typeof record.uri === 'string' && typeof record.cid === 'string') {
      return { found: { uri: record.uri, cid: record.cid }, conclusive: true };
    }
  }

  // Newest first is what the server returns; check it rather than trust it,
  // because a page read oldest first would look like it reached far back.
  const newestFirst = dated.length < 2 || dated[0]! >= dated[dated.length - 1]!;
  const reachedBack = dated.length > 0 && Date.now() - dated[dated.length - 1]! > RECOVERY_HORIZON_MS;
  const wholeCollection = !body.cursor;
  return { found: null, conclusive: newestFirst && (reachedBack || wholeCollection) };
}

export const blueskyAdapter: ChannelAdapter = {
  id: 'bluesky',
  displayName: 'Bluesky',
  capabilities: ['REPLY', 'POST', 'LIKE'],
  requiresBrowser: false,
  signInKind: 'APP_PASSWORD',

  async connect(ctx: ChannelContext): Promise<ConnectionResult> {
    // A fresh sign-in on purpose: connecting is how new details are tested, and
    // a cached session would report success for a password just replaced.
    forgetBlueskySession(ctx.account.id);
    try {
      const session = await createSession(ctx, targetOf(ctx));
      if (session.status) {
        return {
          status: 'ERROR',
          detail: `Bluesky signed in, but says this account is ${session.status}.`,
          remoteAccountId: session.did,
          handle: session.handle,
        };
      }
      return {
        status: 'CONNECTED',
        detail: `Signed in to Bluesky as @${session.handle}.`,
        remoteAccountId: session.did,
        handle: session.handle,
      };
    } catch (error) {
      return failureStatus(error);
    }
  },

  async disconnect(ctx: ChannelContext): Promise<void> {
    await endSession(ctx, targetOf(ctx));
  },

  async healthCheck(ctx: ChannelContext): Promise<HealthResult> {
    try {
      const body = await authed<{ handle?: unknown; active?: unknown; status?: unknown }>(
        ctx,
        targetOf(ctx),
        'com.atproto.server.getSession',
      );
      const handle = typeof body.handle === 'string' ? body.handle : null;
      if (body.active === false || typeof body.status === 'string') {
        return {
          status: 'offline',
          detail: `Bluesky says this account is ${String(body.status ?? 'inactive')}.`,
          authenticated: true,
          handle,
        };
      }
      return { status: 'healthy', detail: 'Signed in to Bluesky.', authenticated: true, handle };
    } catch (error) {
      const failure = classifyBlueskyError(error, 'checking the session');
      const authFailed = failure.reason === 'bluesky_auth_failed' || failure.reason === 'bluesky_no_credentials' || failure.reason === 'bluesky_auth_challenge';
      return { status: authFailed ? 'offline' : 'degraded', detail: failure.message, authenticated: false };
    }
  },

  async ingestEvents(ctx: ChannelContext, options: IngestOptions): Promise<NormalizedEvent[]> {
    const target = targetOf(ctx);
    const session = await ensureSession(ctx, target);

    /*
      Where the last poll stopped, kept on the account and moved only after its
      events were ingested (see `advanceNotificationWatermark`), so a crash
      between reading and ingesting re-reads rather than loses.

      Without one this reads a single page, which is what the first poll of an
      account should do: a new link is not a reason to ingest its history. With
      one it pages back until it meets something older than the mark, so a burst
      larger than a page is read to its end instead of leaving the oldest
      unread. The unique index on the event stays the real deduplication; the
      mark only decides how far back to look.
    */
    const seenThrough = notificationsSeenThrough(ctx.account.settings);
    const mark = seenThrough ? Date.parse(seenThrough) : null;
    const items: ReturnType<typeof parseNotifications>['items'] = [];
    let skipped = 0;
    let metKnown = false;
    let restarted = false;

    /*
      A burst that was only partly read carries on where it stopped.

      The newest pages are read first, so what a poll leaves behind is the OLDEST
      of the burst, between the mark and the oldest thing it read. Taking the
      newest event as the new mark would skip that remainder for ever, and
      re-reading from the newest would never get past the first pages. So the
      account keeps the cursor, the mark stays where it was, and the next poll
      starts from the cursor. The mark moves only when a poll reaches it.
    */
    const resume = mark === null ? null : notificationsResume(ctx.account.settings);
    let cursor: string | undefined = resume?.cursor;
    let resuming = resume !== null;
    const maxPages = mark === null ? 1 : NOTIFICATION_PAGES_PER_POLL;
    let pages = 0;
    let stoppedForBudget = false;

    while (pages < maxPages) {
      // Every page is a read against the one budget. The first was checked
      // before this poll started; each further one is asked about here.
      if (pages > 0 && options.canReadAnother && !(await options.canReadAnother().catch(() => true))) {
        stoppedForBudget = true;
        break;
      }
      let body: { cursor?: unknown };
      try {
        body = await authed<{ cursor?: unknown }>(ctx, target, 'app.bsky.notification.listNotifications', {
          params: { limit: NOTIFICATION_PAGE, reasons: ['mention', 'reply', 'quote'], ...(cursor ? { cursor } : {}) },
        });
      } catch (error) {
        // A stored cursor the server no longer accepts (it was issued long ago)
        // is not a failed poll: start again from the newest, with the mark
        // unmoved, which re-reads and skips nothing.
        if (resuming && pages === 0 && error instanceof BlueskyApiError && error.status === 400) {
          resuming = false;
          restarted = true;
          cursor = undefined;
          continue;
        }
        throw classifyBlueskyError(error, 'reading notifications');
      }
      pages += 1;
      await options.onRead?.();
      const parsed = parseNotifications(body);
      skipped += parsed.skipped;
      items.push(...parsed.items);
      cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : undefined;
      metKnown = mark !== null && parsed.items.some((n) => Date.parse(n.indexedAt) < mark);
      if (!cursor || metKnown) break;
    }

    // With no mark there is no history to catch up on, so one page is the whole
    // read and a new link does not ingest what came before it.
    const complete = mark === null || metKnown || !cursor;
    options.report?.({ complete, resume: complete ? null : (cursor ?? null), restarted });
    if (!complete) {
      ctx.logger.warn(
        stoppedForBudget
          ? 'the read budget ran out part way through a burst of Bluesky notifications; the rest is read next poll'
          : 'more new Bluesky notifications than one poll reads; the rest is read next poll',
        { read: items.length },
      );
    }
    if (skipped > 0) ctx.logger.warn('some Bluesky notifications could not be read', { skipped });

    const events: NormalizedEvent[] = [];
    for (const notification of items) {
      // Older than the mark was ingested by an earlier poll. Equal is read
      // again, because two notifications can share a millisecond.
      if (mark !== null && Date.parse(notification.indexedAt) < mark) continue;
      const event = notificationToEvent(notification, selfOf(session));
      if (!event) continue;
      if (options.since && event.remoteEventId === options.since) continue;
      events.push(event);
    }
    // Oldest first, so what was read is answered in the order it arrived. The
    // unique index on the event makes reading one twice harmless; nothing is
    // marked read on the owner's behalf.
    return events.reverse();
  },

  async resolveContext(ctx: ChannelContext, event: NormalizedEvent): Promise<ResolvedContext> {
    const started = Date.now();
    const uri = event.remoteMessageId ?? event.remoteEventId;
    const session = await ensureSession(ctx, targetOf(ctx));

    const branch = await threadBranchOf(ctx, uri);
    if (!branch.found) {
      if (branch.reason === 'UNREADABLE') {
        throw PipelineError.retryable('bluesky_unreadable', 'Bluesky answered with a thread that could not be read.');
      }
      throw PipelineError.permanent(
        'bluesky_post_unavailable',
        branch.reason === 'BLOCKED'
          ? 'The post that mentioned this account is blocked or hidden, so there is nothing to answer.'
          : 'The post that mentioned this account was deleted before it could be answered.',
      );
    }
    // The action target is the incoming post's own URI. If the server answers
    // with a different post as the focus, something is wrong and nothing may be
    // sent on the strength of it.
    if (branch.focal.uri !== uri) {
      throw PipelineError.permanent(
        'focal_post_mismatch',
        `Asked for ${uri} but Bluesky answered about ${branch.focal.uri}. Nothing was sent.`,
      );
    }

    const conversation = conversationFromBranch(branch, session.did);
    const parent = conversation.parent;
    const thread = conversation.ancestors.map((post) => ({
      role: post.isSelf ? ('OUTBOUND' as const) : ('INBOUND' as const),
      remoteMessageId: post.remoteId,
      authorHandle: post.authorHandle,
      text: post.text,
      createdAt: post.createdAt,
    }));

    // What is attached to the mention, and, when the mention has nothing, what is
    // attached to the post above it. The media step describes them or records a
    // gap; it only reads the parent's when the mention carries nothing itself.
    const own = inventoryIfAny(branch.focal.embed);
    const above = branch.ancestors.length > 0 ? inventoryIfAny(branch.ancestors[branch.ancestors.length - 1]!.embed) : null;

    return {
      targetRef: branch.focal.uri,
      targetUrl: postPermalink(branch.focal.author.handle, branch.focal.uri),
      targetAuthorHandle: branch.focal.author.handle,
      conversationRef: branch.focal.record.reply?.root.uri ?? branch.focal.uri,
      incomingText: branch.focal.record.text,
      parentText: parent?.text ?? null,
      thread,
      conversation,
      meta: {
        channel: 'bluesky',
        resolvedAt: new Date().toISOString(),
        timingsMs: { thread: Date.now() - started },
        ...(own ? { inventory: own } : {}),
        ...(above ? { parentInventory: above } : {}),
      },
    };
  },

  async verifyAction(ctx: ChannelContext, request: ActionRequest): Promise<VerificationResult> {
    try {
      return await verifyPost(ctx, request);
    } catch (error) {
      throw classifyBlueskyError(error, 'verifying the target');
    }
  },

  async executeAction(ctx: ChannelContext, request: ActionRequest): Promise<ActionResult> {
    // Verification is repeated here and not trusted from the caller: it is what
    // supplies the target's current CID, and anything can have happened to the
    // post between the two calls.
    const verification = await blueskyAdapter.verifyAction(ctx, request);
    if (!verification.verified) {
      throw PipelineError.review('target_unverified', `Bluesky could not verify the target: ${verification.detail}`);
    }
    if (request.dryRun) {
      return { status: 'DRY_RUN', remoteActionId: null, remoteActionUrl: null, verification };
    }

    const target = targetOf(ctx);
    const session = await ensureSession(ctx, target);

    if (request.type === 'LIKE') {
      const existing = (verification.evidence as { likeUri?: string | null }).likeUri;
      if (existing) {
        return {
          status: 'EXECUTED',
          remoteActionId: existing,
          remoteActionUrl: verification.targetUrl,
          verification: { ...verification, detail: 'Already liked; nothing was sent again.' },
        };
      }
      const subject = verification.evidence as { cid: string };
      try {
        const created = await authed<{ uri?: string }>(ctx, target, 'com.atproto.repo.createRecord', {
          method: 'POST',
          body: {
            repo: session.did,
            collection: LIKE_COLLECTION,
            record: {
              $type: LIKE_COLLECTION,
              subject: { uri: verification.targetRef, cid: subject.cid },
              createdAt: new Date().toISOString(),
            },
          },
        });
        return {
          status: 'EXECUTED',
          remoteActionId: created.uri ?? null,
          remoteActionUrl: verification.targetUrl,
          verification,
        };
      } catch (error) {
        throw await settleFailedWrite(ctx, request, error);
      }
    }

    // POST and REPLY write a post record.
    const facets = await buildFacets(request.text, (handle) => resolveHandle(ctx, handle));
    const evidence = verification.evidence as { parent?: { uri: string; cid: string }; root?: { uri: string; cid: string } };
    const record: Record<string, unknown> = {
      $type: POST_COLLECTION,
      text: request.text,
      createdAt: new Date().toISOString(),
      ...(facets.length > 0 ? { facets } : {}),
      ...(request.type === 'REPLY' && evidence.parent && evidence.root
        ? { reply: { root: evidence.root, parent: evidence.parent } }
        : {}),
    };

    try {
      const created = await authed<{ uri?: string; cid?: string }>(ctx, target, 'com.atproto.repo.createRecord', {
        method: 'POST',
        body: { repo: session.did, collection: POST_COLLECTION, record },
      });
      if (!created.uri || !parseAtUri(created.uri)) {
        // Accepted, but with an answer that names nothing: the post may exist.
        throw new BlueskyTransportError('Bluesky accepted the post but did not say where it went.');
      }
      return {
        status: 'EXECUTED',
        remoteActionId: created.uri,
        remoteActionUrl: postPermalink(session.handle, created.uri),
        verification,
      };
    } catch (error) {
      const settled = await settleFailedWrite(ctx, request, error);
      if (settled instanceof FoundAfterAll) {
        return {
          status: 'EXECUTED',
          remoteActionId: settled.uri,
          remoteActionUrl: postPermalink(session.handle, settled.uri),
          verification: { ...verification, detail: 'The post was written even though the answer was lost.' },
        };
      }
      throw settled;
    }
  },

  async wasAlreadyDone(ctx: ChannelContext, request: ActionRequest) {
    try {
      if (request.type === 'LIKE') {
        const view = request.targetRef ? await targetPost(ctx, request.targetRef) : null;
        const likeUri = view?.viewer?.like ?? null;
        return {
          done: Boolean(likeUri),
          remoteActionId: likeUri,
          remoteActionUrl: view ? postPermalink(view.author.handle, view.uri) : null,
          detail: likeUri ? 'The account already likes this post.' : 'The account does not like this post.',
          // The post's own viewer state is the whole truth for a like.
          conclusive: Boolean(view),
        };
      }
      if (request.type === 'POST' || request.type === 'REPLY') {
        const scan = await scanOwnPosts(ctx, request);
        const session = await ensureSession(ctx, targetOf(ctx));
        return {
          done: scan.found !== null,
          remoteActionId: scan.found?.uri ?? null,
          remoteActionUrl: scan.found ? postPermalink(session.handle, scan.found.uri) : null,
          detail: scan.found ? 'The account already wrote this exact text.' : 'No post with this text was found.',
          conclusive: scan.conclusive,
        };
      }
    } catch (error) {
      return {
        done: false,
        remoteActionId: null,
        remoteActionUrl: null,
        detail: `Could not check: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { done: false, remoteActionId: null, remoteActionUrl: null, detail: 'Nothing to check for this action.' };
  },

  async captureDiagnostics(_ctx: ChannelContext, reason: string): Promise<DiagnosticCapture | null> {
    // No page to photograph. The reason is all there is, and it is kept free of
    // anything the server or the stored password could have put in it.
    return { kind: 'bluesky_diagnostic', message: reason, url: null, screenshotRelPath: null, meta: { channel: 'bluesky' } };
  },
};

/** Marks that an ambiguous write turned out to have gone through. */
class FoundAfterAll extends Error {
  constructor(readonly uri: string) {
    super('The write had already happened.');
  }
}

/**
 * Decides what a failed write means.
 *
 * A server that answers with a refusal tells us nothing was written. A request
 * that got no answer tells us nothing at all: the post may exist. Retrying that
 * second case blindly is how a post goes out twice, so the account's own
 * repository is read first. Only when that read provably covers the window and
 * finds nothing is the failure retryable; when it cannot say, a person decides.
 */
async function settleFailedWrite(
  ctx: ChannelContext,
  request: ActionRequest,
  error: unknown,
): Promise<PipelineError | FoundAfterAll> {
  const ambiguous = error instanceof BlueskyTransportError;
  if (!ambiguous) return classifyBlueskyError(error, request.type === 'LIKE' ? 'liking the post' : 'publishing the post');

  if (request.type === 'LIKE') {
    // A like is a desired state: verification reads whether it landed, so the
    // retry cannot double it.
    return classifyBlueskyError(error, 'liking the post');
  }
  try {
    const scan = await scanOwnPosts(ctx, request);
    if (scan.found) return new FoundAfterAll(scan.found.uri);
    if (scan.conclusive) return classifyBlueskyError(error, 'publishing the post');
  } catch {
    // Could not look either; fall through to a person.
  }
  return PipelineError.review(
    'bluesky_write_ambiguous',
    'Bluesky did not answer the post, and it could not be confirmed whether it was published. Check the account before sending it again.',
  );
}
