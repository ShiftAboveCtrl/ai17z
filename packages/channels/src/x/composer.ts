import { PipelineError, sleep } from '@xbam/shared';
import { retagIfLost, type Locator, type Page } from '@xbam/browser';
import type { ActionRequest, ActionResult, ChannelContext, VerificationResult } from '../contract';
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

export interface OpenComposer {
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
 * at all -- CLAUDE.md is explicit that the composer may be inline -- so this
 * must not become "wait for a dialog", only "do not conclude there is none
 * before X has had time to open one". The cost when there genuinely is no
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
  const dialogs = page.locator(SEL.dialog);
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = dialogs.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
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

export async function returnToIdle(page: Page): Promise<void> {
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
  whole: string,
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
    return { statusId: snapshot.statusId, url: snapshot.url, exact };
  }
  return null;
}

/**
 * How long to wait for an editor to become genuinely usable.
 *
 * X mounts the contenteditable node before it wires the editor behind it, so
 * "the locator resolved" and "a keystroke will land" are several hundred
 * milliseconds apart on a cold profile.
 */
const COMPOSER_READY_MS = 10_000;

/**
 * How many times a draft may be prepared before giving up.
 *
 * Bounded on purpose. The failure this replaces was an open/type/clear/retype
 * cycle a person could watch happening, and an unbounded version of it is worse
 * than a refusal: it hammers the editor and leaves drafts behind.
 */
const COMPOSER_ATTEMPTS = 2;

/**
 * Proves a keystroke would land in this editor, before any keystroke is sent.
 *
 * This is the fix for a bug that was visible from across the room: the reply
 * would start typing, arrive missing its first characters, get cleared, and be
 * typed again. The cause was two swallowed results --
 * `editor.focus().catch(() => undefined)` immediately followed by
 * `editor.type(...).catch(() => undefined)`. If focus landed anywhere but the
 * editor, which is exactly what X's @-mention typeahead exists to do, the
 * leading keystrokes went to the overlay and the draft arrived short; and if
 * the editor was re-rendered mid-type, the throw was discarded and a partial
 * draft was left sitting there.
 *
 * Nothing is typed until this returns. Recovery still exists below, but it is
 * no longer the mechanism: it is the exception.
 */
export async function readyForTyping(editor: Locator): Promise<void> {
  await editor.waitFor({ state: 'visible', timeout: COMPOSER_READY_MS }).catch(() => {
    throw PipelineError.retryable('composer_not_visible', 'The composer did not become visible.');
  });

  // Editable, not merely present. `isContentEditable` is false while X still
  // has the node mounted as a placeholder.
  const editable = await editor.evaluate((el) => (el as HTMLElement).isContentEditable).catch(() => false);
  if (!editable) {
    throw PipelineError.retryable(
      'composer_not_editable',
      'The composer is on screen but is not accepting input yet.',
    );
  }

  await editor.focus();

  // Verified, never assumed. `document.activeElement` is the only thing that
  // knows where the next keystroke actually goes.
  const holdsFocus = await editor
    .evaluate((el) => el === document.activeElement || el.contains(document.activeElement))
    .catch(() => false);
  if (!holdsFocus) {
    throw PipelineError.retryable(
      'composer_not_focused',
      'Focus did not land in the composer, so nothing was typed into it.',
    );
  }
}

/** Empties the editor. Select-all inside it, never across the page. */
async function clearComposer(page: Page, editor: Locator): Promise<void> {
  await editor.focus().catch(() => undefined);
  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.press('Delete').catch(() => undefined);
  await settle(300, 600);
}

/**
 * Puts the text into the composer, and proves the whole of it went in.
 *
 * Two changes from the version that shipped the truncation. Readiness is proved
 * before typing rather than recovered from afterwards, and the check is on the
 * *entire* draft rather than its first sixty characters -- a draft correct at
 * the start and cut off later passed the old check, which is the shape of the
 * bug that was actually happening.
 *
 * The comparison is on the fingerprint, not the raw string, because X's editor
 * turns a typed @mention into a link node and `innerText` puts spaces around
 * it. It strips punctuation and case and nothing else: a missing word, a
 * missing URL, or a missing first character all still fail.
 */
export async function fillComposer(page: Page, editor: Locator, text: string): Promise<string> {
  const wanted = fingerprint(text);
  let landed = '';

  for (let attempt = 0; attempt < COMPOSER_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await clearComposer(page, editor);

    await readyForTyping(editor);

    try {
      await editor.type(text, { delay: 12 });
    } catch {
      // A throw here means X replaced the node mid-type. The draft is partial
      // by definition, so fall through to the check, which will say so.
    }
    await settle(400, 900);

    landed = (await editor.innerText().catch(() => '')).trim();
    if (fingerprint(landed) === wanted) return landed;
  }

  // Deliberately not a submit. A composer holding the wrong text is the one
  // situation where doing nothing is the whole job.
  throw PipelineError.retryable(
    landed ? 'composer_text_mismatch' : 'composer_empty',
    landed
      ? `The composer holds ${landed.length} characters of a ${text.length} character draft, after ${COMPOSER_ATTEMPTS} attempts.`
      : `The composer was still empty after typing, ${COMPOSER_ATTEMPTS} times.`,
    { wantedChars: text.length, landedChars: landed.length },
  );
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
}

export async function findOwnReply(
  page: Page,
  text: string,
  me: string[],
  reloads = 1,
): Promise<OwnReply | null> {
  // Sixty characters of fingerprint, not forty of raw text: stripping the
  // punctuation costs length, and a short needle matches the wrong post.
  const needle = fingerprint(text).slice(0, 60);
  if (!needle) return null;
  const whole = fingerprint(text);

  const first = await scanForOwnReply(page, needle, me, whole);
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
    const found = await scanForOwnReply(page, needle, me, whole);
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
