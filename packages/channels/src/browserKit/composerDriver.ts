import { PipelineError, sleep } from '@xbam/shared';
import type { Locator, Page } from '@xbam/browser';
import type { MediaAttachment } from '../contract';
import { settle } from './tabSession';

/**
 * Typing into a composer and proving it landed, on any network.
 *
 * A composer is a contenteditable node that its page wires up a few hundred
 * milliseconds after it appears, that an overlay can steal focus from, and that
 * re-renders mid-type. None of that is specific to one site, so the discipline
 * lives here and each network's folder supplies only its selectors and its own
 * wording for what went wrong.
 *
 * Nothing here decides *what* to say. It types what it is given and says
 * whether the whole of it arrived.
 */

/** A composer found on a page: where it is, what to type into, and whether it floated. */
export interface OpenComposer {
  scope: ReturnType<Page['locator']>;
  editor: ReturnType<Page['locator']>;
  inDialog: boolean;
}

/**
 * Reduces text to the letters and digits in it, lowercased.
 *
 * What was submitted and what a page renders back are never byte-identical:
 * a typed @mention becomes a link element and `innerText` puts whitespace around
 * it; smart quotes, non-breaking spaces and zero-width characters do the same
 * more quietly. Failing to recognise one's own text is not cosmetic: it is the
 * check that tells "refused" apart from "accepted and left the composer up",
 * and retrying the second posts twice.
 */
export function fingerprint(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Polls until a control becomes enabled, or gives up.
 *
 * Playwright has no built-in wait for "enabled", only for visible, attached,
 * stable and editable, and sites toggle `aria-disabled` on a submit button a
 * beat after the composer changes, so a single check is a coin toss.
 */
export async function waitForEnabled(locator: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * How long to wait for an editor to become genuinely usable.
 *
 * The contenteditable node is mounted before the editor behind it is wired, so
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
 * Two swallowed results used to hide this: `focus()` and `type()` both ended in
 * `.catch(() => undefined)`. If focus landed anywhere but the editor, which is
 * exactly what an @-mention typeahead exists to do, the leading keystrokes went
 * to the overlay and the draft arrived short; and if the editor re-rendered
 * mid-type, the throw was discarded and a partial draft was left sitting there.
 *
 * Nothing is typed until this returns.
 */
export async function readyForTyping(editor: Locator): Promise<void> {
  await editor.waitFor({ state: 'visible', timeout: COMPOSER_READY_MS }).catch(() => {
    throw PipelineError.retryable('composer_not_visible', 'The composer did not become visible.');
  });

  // Editable, not merely present. `isContentEditable` is false while the page
  // still has the node mounted as a placeholder.
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
export async function clearComposer(page: Page, editor: Locator): Promise<void> {
  await editor.focus().catch(() => undefined);
  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.press('Delete').catch(() => undefined);
  await settle(300, 600);
}

/**
 * Puts the text into the composer, and proves the whole of it went in.
 *
 * Readiness is proved before typing rather than recovered from afterwards, and
 * the check is on the *entire* draft rather than its first characters: a draft
 * correct at the start and cut off later is the shape of the bug that shipped.
 *
 * The comparison is on the fingerprint, not the raw string, because an editor
 * turns a typed @mention into a link node. It strips punctuation and case and
 * nothing else: a missing word, a missing URL, or a missing first character
 * all still fail.
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
      // A throw here means the page replaced the node mid-type. The draft is
      // partial by definition, so fall through to the check, which will say so.
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

/** How long each kind of upload is given before it is called failed. */
export const MEDIA_UPLOAD_BUDGET_MS = { IMAGE: 60_000, GIF: 90_000, VIDEO: 300_000 } as const;

const UPLOAD_FAILED = /fail|couldn.?t|could not|unable|too large|not supported|try again|went wrong/i;

/** Where a network keeps the parts of its upload UI. */
export interface MediaSelectors {
  /** The composer's own file input, scoped to the composer by the caller. */
  fileInput: string;
  /** One attached item. Counting these is how a finished upload is known. */
  attachedItem: string;
  /** Present on an item that is still uploading. */
  uploadProgress: string;
  /** Submit, whichever composer it belongs to. */
  submit: string;
  /** Where the page reports a failed upload. */
  toast: string;
}

/**
 * Puts files in the composer and waits until the page has them.
 *
 * The files go into the composer's own file input with `setInputFiles`. The
 * visible "add photos" button is never clicked: it opens a native picker, which
 * nothing here can drive. Focus goes back to the editor afterwards, because
 * attaching moves it and the keyboard submit fallback needs it there.
 *
 * Done when every file has its tile, none is still showing progress, and the
 * submit button is enabled: sites disable it for the length of an upload, so an
 * enabled button is the page agreeing, not this code guessing. Bounded, because
 * a video that never finishes is a stuck tab and not a reason to wait forever.
 *
 * Everything that goes wrong here is *retryable*: this runs before the submit,
 * so nothing has been sent and trying again cannot post twice.
 *
 * `networkName` is only for the sentences an owner reads.
 */
export async function attachMediaFiles(
  page: Page,
  opened: OpenComposer,
  media: readonly MediaAttachment[],
  selectors: MediaSelectors,
  options: { timeoutMs?: number; pollMs?: number; networkName: string },
): Promise<void> {
  if (media.length === 0) return;
  const pollMs = options.pollMs ?? 500;
  const timeoutMs = options.timeoutMs ?? Math.max(...media.map((m) => MEDIA_UPLOAD_BUDGET_MS[m.kind]));
  const network = options.networkName;

  const input = opened.scope.locator(selectors.fileInput).first();
  if ((await input.count().catch(() => 0)) === 0) {
    throw PipelineError.retryable('media_input_missing', 'The composer has no file input, so the attachment could not be added. Nothing was posted.');
  }
  try {
    await input.setInputFiles(
      media.map((m) => m.path),
      { timeout: 15_000 },
    );
  } catch (error) {
    throw PipelineError.retryable(
      'media_upload_failed',
      `The attachment could not be given to the composer: ${(error as Error).message}. Nothing was posted.`,
    );
  }

  const items = opened.scope.locator(selectors.attachedItem);
  const progress = opened.scope.locator(selectors.uploadProgress);
  const submit = opened.scope.locator(selectors.submit).first();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const toast = ((await page.locator(selectors.toast).first().innerText({ timeout: 500 }).catch(() => '')) ?? '').trim();
    if (toast && UPLOAD_FAILED.test(toast)) {
      throw PipelineError.retryable('media_upload_failed', `${network} rejected the attachment: ${toast.slice(0, 160)}. Nothing was posted.`);
    }
    const attached = await items.count().catch(() => 0);
    const busy = await progress.count().catch(() => 0);
    if (attached >= media.length && busy === 0 && (await submit.isEnabled().catch(() => false))) break;
    if (Date.now() >= deadline) {
      throw PipelineError.retryable(
        'media_upload_timeout',
        `${network} had ${attached} of ${media.length} attachment${media.length === 1 ? '' : 's'} ready after ${Math.round(timeoutMs / 1000)} seconds${busy > 0 ? ' and was still uploading' : ''}. Nothing was posted.`,
        { attached, expected: media.length, uploading: busy },
      );
    }
    await sleep(pollMs);
  }
  await opened.editor.focus();
}
