import { PipelineError, sleep } from '@xbam/shared';
import type { Locator, Page } from '@xbam/browser';
import type { ActionRequest, ActionResult, ChannelContext, MediaAttachment, VerificationResult } from '../contract';
import {
  MEDIA_UPLOAD_BUDGET_MS,
  attachMediaFiles,
  fillComposer,
  fingerprint,
  readyForTyping,
  returnToIdle as kitReturnToIdle,
  visibleDialogOf,
  waitForEnabled,
  type OpenComposer,
} from '../browserKit';
import { SEL, X_URLS, articleForStatus } from './selectors';
import { goto, readArticle, selfHandles, settle, withSession } from './page';
import { anchorTarget } from './engagement';
import { buildStatusUrl, extractStatusId, normalizeHandle } from './targets';

/**
 * Writing something and confirming it arrived.
 *
 * Every reply and every post goes through here, and so does the reason this
 * file is worth having on its own: the composer is where X is least like a
 * document and most like an application. It may be a dialog or inline on the
 * status page; an @-mention typeahead opens over it and swallows pointer
 * events; a composer that does not close is ambiguous rather than failed; and
 * what was typed has to be read back in full before anything is submitted.
 *
 * Nothing here decides *what* to say. It types what it is given, submits it,
 * and goes and looks for it afterwards.
 */

export type { OpenComposer };

/*
  The parts of this that are the same on any site now live in the browser kit:
  proving a keystroke would land, typing and reading the whole draft back, and
  the fingerprint that compares them. They are re-exported under the names this
  adapter has always had, so what imports them from here is untouched.
*/
export { fingerprint, fillComposer, readyForTyping };

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
export async function openComposer(page: Page, timeoutMs = 15_000): Promise<OpenComposer | null> {
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
  //
  // Settled, not sampled once. Asking a single time is a race that was measured
  // losing on a live account: the inline composer on a status page became
  // visible at 18:22:13.294 with no dialog on the page, and X opened the reply
  // modal 548ms later. Binding to the inline editor in that gap is the whole
  // truncated-reply bug -- the first characters go into the editor that was
  // bound, X moves focus to the modal's editor, and the rest of the draft is
  // typed there without them. The orphaned node then never detaches, so the
  // post-submit wait for it burned its full twenty-second timeout every time.
  const dialog = await settledDialog(page);
  const inDialog = dialog !== null;
  return {
    scope: dialog ?? page.locator('main').first(),
    editor: dialog ? dialog.locator(SEL.anyComposer).first() : editor,
    inDialog,
  };
}

/**
 * The visible dialog, once X has had a moment to open one.
 *
 * `visibleDialog` answers about this instant. This answers about the surface
 * the composer is settling onto, which is a different question when the thing
 * being waited for arrives a few hundred milliseconds after the editor does.
 *
 * Bounded and short. A reply on a status page may legitimately have no dialog
 * at all -- docs/ENGINEERING.md is explicit that the composer may be inline --
 * so this must not become "wait for a dialog", only "do not conclude there is
 * none before X has had time to open one". The cost when there genuinely is no
 * dialog is this window; the saving when there is one is the twenty-second
 * detach timeout that was being paid on every single reply.
 */
async function settledDialog(page: Page, timeoutMs = 1_800): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialog = await visibleDialog(page);
    if (dialog) return dialog;
    if (Date.now() >= deadline) return null;
    await sleep(150);
  }
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
export async function submitComposer(page: Page, opened: OpenComposer): Promise<'clicked' | 'keyboard'> {
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
    if (clicked) return 'clicked';

    // The click reported failure, which usually means Playwright never
    // dispatched it. "Usually" is not a good enough basis for a second
    // irreversible attempt: a click that landed and then failed its own
    // actionability re-check, followed by the keyboard shortcut below, is two
    // submits of one reply. So ask the page whether it went anyway, and only
    // reach for the keyboard when it plainly did not.
    if (await composerLetGo(opened.editor)) return 'clicked';
  }

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  return 'keyboard';
}

/**
 * Whether the composer has accepted what was in it.
 *
 * A dialog composer detaches; an inline one is emptied in place. Either is X
 * saying it took the text. Short, because this only has to distinguish "the
 * click landed" from "nothing happened" before deciding whether to press a key
 * that would send the same reply a second time.
 */
async function composerLetGo(editor: Locator, timeoutMs = 2_500): Promise<boolean> {
  const gone = await editor
    .waitFor({ state: 'detached', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (gone) return true;
  return ((await editor.innerText().catch(() => 'x')) ?? '').trim().length === 0;
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
  return visibleDialogOf(page, SEL.dialog);
}

/** Handles from the composer's own "Replying to @someone" line. */
export async function composerReplyingTo(page: Page): Promise<string[]> {
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
 * reply was sent, and reporting it as one would be wrong. The kit re-asserts the
 * tab's tag afterwards, because the navigation just cleared it.
 */
export async function returnToIdle(page: Page): Promise<void> {
  await kitReturnToIdle(page, { homeUrl: X_URLS.home, dialogSelector: SEL.dialog, role: 'ACTION' });
}

/** Looks for the reply we just sent, matching on author and text prefix. */

async function scanForOwnReply(
  page: Page,
  needle: string,
  me: string[],
  whole: string,
  countMedia = false,
): Promise<OwnReply | null> {
  const articles = page.locator(SEL.tweetArticle);
  const count = Math.min(await articles.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const snapshot = await readArticle(page, `${SEL.tweetArticle} >> nth=${index}`);
    if (!snapshot.statusId || !snapshot.authorHandle) continue;
    if (!me.includes(snapshot.authorHandle)) continue;
    if (!fingerprint(snapshot.text).includes(needle)) continue;
    // The needle is sixty characters: enough to pick the right post out of
    // twenty, and nowhere near enough to prove the post is the whole reply. A
    // reply truncated after those sixty characters matched here and was
    // recorded `readBackConfirmed: true`, so the system could not see the one
    // failure it most needed to see.
    //
    // Reported rather than rejected. Refusing to match a post that is really
    // there would make the caller conclude nothing was sent and retry, and
    // retrying a reply X accepted posts it twice -- which is worse than an
    // imperfect one recorded honestly.
    const exact = fingerprint(snapshot.text).includes(whole);
    if (!countMedia) return { statusId: snapshot.statusId, url: snapshot.url, exact };
    const article = page.locator(`${SEL.tweetArticle} >> nth=${index}`);
    const photos = await article.locator(SEL.tweetPhoto).count().catch(() => 0);
    const videos = await article.locator(SEL.tweetVideo).count().catch(() => 0);
    return { statusId: snapshot.statusId, url: snapshot.url, exact, seen: { photos, videos } };
  }
  return null;
}


/**
 * A post of ours that was found on the remote.
 *
 * `exact` says whether it carries the entire draft. It is separate from
 * "found" because those are different questions with different consequences:
 * not finding it may mean nothing was sent, while finding a shortened version
 * means something was sent and must never be sent again.
 */
export interface OwnReply {
  statusId: string;
  url: string | null;
  exact: boolean;
  /** What the post shows, counted only when the caller asked: a post sent with files is read back for them. */
  seen?: { photos: number; videos: number };
}

export async function findOwnReply(
  page: Page,
  text: string,
  me: string[],
  reloads = 1,
  countMedia = false,
): Promise<OwnReply | null> {
  // Sixty characters of fingerprint, not forty of raw text: stripping the
  // punctuation costs length, and a short needle matches the wrong post.
  const needle = fingerprint(text).slice(0, 60);
  if (!needle) return null;
  const whole = fingerprint(text);

  const first = await scanForOwnReply(page, needle, me, whole, countMedia);
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
    const found = await scanForOwnReply(page, needle, me, whole, countMedia);
    if (found) return found;
  }
  return null;
}

/**
 * Whether a post read back off the timeline shows what was sent with it.
 *
 * Images are counted: three pictures sent and one shown is a different post.
 * A video must show a player. A GIF may be drawn either way, because X plays
 * it as a looping video but sometimes lays it out as a photo, so either counts.
 */
export function mediaSeenOnPost(sent: readonly Pick<MediaAttachment, 'kind'>[], seen: { photos: number; videos: number }): boolean {
  if (sent.length === 0) return true;
  const kind = sent[0]!.kind;
  if (kind === 'VIDEO') return seen.videos >= 1;
  if (kind === 'GIF') return seen.videos + seen.photos >= 1;
  return seen.photos >= sent.length;
}

/** How long each kind of upload is given before it is called failed. */
export { MEDIA_UPLOAD_BUDGET_MS };

/**
 * Puts files in the composer and waits until X has them.
 *
 * The mechanics are the browser kit's. What is X's is where its upload UI is
 * and what it calls itself in the sentence an owner reads when it goes wrong.
 * Everything that fails here is retryable: this runs before the submit, so
 * nothing has been sent and trying again cannot post twice.
 */
export async function attachMedia(
  page: Page,
  opened: OpenComposer,
  media: readonly MediaAttachment[],
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  return attachMediaFiles(
    page,
    opened,
    media,
    {
      fileInput: SEL.mediaInput,
      attachedItem: SEL.composerMediaItem,
      uploadProgress: SEL.composerMediaProgress,
      submit: SEL.anySubmit,
      toast: SEL.toast,
    },
    { ...options, networkName: 'X' },
  );
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
export async function postOwn(
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

    // Files go in after the text, so the editor is already proved to hold it,
    // and before the button is asked about, because an upload disables it.
    const media = request.media ?? [];
    if (media.length > 0) {
      try {
        await attachMedia(page, opened, media);
      } catch (error) {
        await returnToIdle(page);
        throw error;
      }
    }

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
    /*
      From the first attempt to submit, every failure is ambiguous rather than
      retryable. A click that landed and then failed its own check, a page that
      crashed after X took the text: from here none of them can say the post
      did not go out, and an error that propagates is retried as if it did not.
      So they are returned as an unconfirmed post, which the executor holds for
      the owner and never sends again, instead of thrown.
    */
    const unconfirmed = (detail: string, extra: Record<string, unknown>): ActionResult => ({
      // EXECUTED only means "submitted, nothing thrown": the executor decides the
      // real outcome from readBackConfirmed:false and holds the post.
      status: 'EXECUTED' as const,
      remoteActionId: null,
      remoteActionUrl: null,
      verification: {
        ...verification,
        detail,
        evidence: { ...verification.evidence, readBackConfirmed: false, ...extra },
      },
    });

    let composerClosed = false;
    try {
      await submitComposer(page, opened);
      composerClosed = await composerLetGo(opened.editor, 8_000);
      await settle(2_000, 3_500);
    } catch (error) {
      return unconfirmed(`The post may have been submitted: ${(error as Error).message}`, { submitError: (error as Error).message });
    }

    // Read back from the account's own timeline. A dialog that closed is not
    // evidence that anything was published, which is the mistake the legacy
    // poster made and reported as success. Confirmed means the post itself was
    // found there; a closed composer alone is not enough.
    const handle = me[0];
    if (!handle) {
      return unconfirmed('Post submitted. This account has no handle recorded, so it could not be confirmed.', { composerClosed });
    }

    let readBack: OwnReply | null = null;
    try {
      await goto(page, X_URLS.profile(handle));
      readBack = await findOwnReply(page, request.text, me, 3, media.length > 0);
      await returnToIdle(page);
    } catch (error) {
      return unconfirmed(`Post submitted, but the profile could not be read back: ${(error as Error).message}`, {
        composerClosed,
        readBackError: (error as Error).message,
      });
    }

    if (!readBack) {
      // Reported as executed but unconfirmed rather than retried: retrying a
      // post that may already be live is how an account posts twice.
      return unconfirmed(
        composerClosed
          ? 'Post submitted and the composer closed, but it was not visible on the profile on read-back.'
          : 'Post submitted, but the composer stayed open and it was not visible on the profile on read-back.',
        { composerClosed },
      );
    }

    // Found, but without what was sent with it. It is public, so it must never
    // be sent again, and it is not the post that was approved, so it is not
    // recorded as done: the owner is told, with the address, and decides.
    if (media.length > 0 && !mediaSeenOnPost(media, readBack.seen ?? { photos: 0, videos: 0 })) {
      const noun = media[0]!.kind === 'VIDEO' ? 'video' : media[0]!.kind === 'GIF' ? 'GIF' : 'image';
      return unconfirmed(`The post is on the profile as ${readBack.statusId}, but it does not show its ${noun}.`, {
        composerClosed,
        mediaConfirmed: false,
        postStatusId: readBack.statusId,
        postUrl: readBack.url,
        mediaSeen: readBack.seen ?? null,
      });
    }

    return {
      status: 'EXECUTED' as const,
      remoteActionId: readBack.statusId,
      remoteActionUrl: readBack.url,
      verification: {
        ...verification,
        detail: `Post confirmed on the profile as ${readBack.statusId}.`,
        evidence: {
          ...verification.evidence,
          readBackConfirmed: true,
          composerClosed,
          postStatusId: readBack.statusId,
          ...(media.length > 0 ? { mediaConfirmed: true, mediaSeen: readBack.seen ?? null } : {}),
        },
      },
    };
  });
}

/**
 * Replying to a post, from navigation to reading it back.
 *
 * The three other actions -- posting, liking, reposting -- were already
 * functions the adapter dispatched to, and this one was written out inside
 * `executeAction` instead. Same code, now in the same shape as its siblings
 * and beside the composer it spends its time in.
 */
export async function replyOnPage(
  ctx: ChannelContext,
  request: ActionRequest,
  verification: VerificationResult,
): Promise<ActionResult> {
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
    // Navigate, wait for the anchored article, and re-check on the freshly
    // loaded page that it is still the intended post. One implementation,
    // shared with likes and reposts: a wrong-target guard that exists twice
    // is a wrong-target guard that will eventually disagree with itself.
    const url = buildStatusUrl(verification.targetRef)!;
    const onPage = await anchorTarget(page, statusId, url);
    const article = page.locator(anchor).first();

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
          detail:
            `${verification.detail} The composer stayed open, but the reply is on the thread as ${sent.statusId}.` +
            (sent.exact ? '' : ' What was published does not carry the whole draft.'),
          evidence: {
            ...verification.evidence,
            readBackConfirmed: true,
            composerStayedOpen: true,
            draftExact: sent.exact,
          },
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
        detail:
          `${verification.detail} Reply confirmed on read-back as ${readBack.statusId}.` +
          (readBack.exact ? '' : ' What was published does not carry the whole draft.'),
        evidence: {
          ...verification.evidence,
          readBackConfirmed: true,
          replyStatusId: readBack.statusId,
          draftExact: readBack.exact,
        },
      },
    };
  });
}
