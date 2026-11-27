import { PipelineError, envBool, errorMessage, sleep } from '@xbam/shared';
import {
  leaseSession,
  resolveProfileDir,
  retagIfLost,
  type LeasedSession,
  type Locator,
  type Page,
  type TabRole,
} from '@xbam/browser';
import type { ChannelContext } from '../contract';

/**
 * Driving a page on any network, without knowing which one.
 *
 * Taking a lease on a tab, waiting the way a person waits, going somewhere and
 * putting the tab back afterwards are the same on every site that is driven
 * through the signed-in browser. Where things are *on* the page is what differs,
 * and that arrives as an argument from the network's own folder.
 */

/**
 * Short randomised pause between UI steps.
 *
 * This exists for reliability, not for evading anything: a timeline is a
 * virtualised list that re-renders asynchronously, and acting on the frame that
 * was there a moment ago is the single largest source of flaky automation.
 */
export async function settle(minMs = 350, maxMs = 900): Promise<void> {
  await sleep(minMs + Math.random() * (maxMs - minMs));
}

/**
 * Runs one operation on the tab that belongs to it.
 *
 * The account's channel travels with the lease so the browser package can start
 * Chrome on that network's page and recognise that network's tabs; nothing else
 * about the network is known here.
 *
 * Releases on success and records the failure against the tab on a throw, so a
 * monitor that keeps failing shows as one unhealthy surface rather than as an
 * unhealthy account.
 */
export async function withTabSession<T>(
  ctx: ChannelContext,
  role: TabRole,
  fn: (session: LeasedSession) => Promise<T>,
  existingOnly = false,
): Promise<T> {
  const session = await leaseSession(
    {
      accountId: ctx.account.id,
      existingOnly,
      mode: ctx.session?.mode ?? 'MANAGED',
      profileDir: resolveProfileDir(ctx.account.id, ctx.session?.profileDir),
      cdpUrl: ctx.session?.cdpUrl ?? null,
      engine: ctx.session?.engine ?? 'GOOGLE_CHROME',
      channel: ctx.session?.channel ?? null,
      network: ctx.account.channel,
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

/** Opens an address and gives the page a moment to draw. Retryable when it cannot. */
export async function navigate(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    throw PipelineError.retryable('navigation_failed', `Could not open ${url}: ${errorMessage(error)}`, { url }, error);
  }
  await settle(800, 1_600);
}

/** What the page says, or nothing when it will not answer. Never throws. */
export async function readBodyText(page: Page): Promise<string> {
  try {
    return (await page.locator('body').innerText({ timeout: 10_000 })) ?? '';
  } catch {
    return '';
  }
}

/**
 * The dialog a person can actually see.
 *
 * Sites render more than one `role="dialog"` node and the first in the DOM is
 * often hidden. Taking `.first()` and drawing a conclusion from an empty,
 * invisible element is how a safety check silently stops checking, so every
 * caller asks for the visible one.
 */
export async function visibleDialogOf(page: Page, dialogSelector: string): Promise<Locator | null> {
  const dialogs = page.locator(dialogSelector);
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = dialogs.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/**
 * Puts the action tab back to a known state after acting.
 *
 * Best-effort by design: a failure here has nothing to do with whether the
 * reply was sent, and reporting it as one would be wrong.
 *
 * The tag is re-asserted afterwards because that navigation just cleared it. A
 * tab is identified by `window.name`, and a navigation wipes it; between actions
 * the tab would otherwise sit at the home page with an empty name, health would
 * report it MISSING, and adoption would fall back to guessing which untagged
 * tab was ours.
 */
export async function returnToIdle(
  page: Page,
  options: { homeUrl: string; dialogSelector: string; role?: TabRole },
): Promise<void> {
  try {
    if (await visibleDialogOf(page, options.dialogSelector)) {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await page.goto(options.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await retagIfLost(page, options.role ?? 'ACTION');
  } catch {
    // Nothing to do about it, and nothing depends on it.
  }
}
