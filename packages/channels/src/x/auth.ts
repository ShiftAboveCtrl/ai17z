import type { Page } from 'playwright';
import type { AuthObservation } from '../contract';
import { observeAuthWith, type AuthSignals } from '../browserKit';
import { CHALLENGE_SIGNALS, SEL, SEL_AUTH } from './selectors';

/**
 * Reads an open sign-in window and says what it shows.
 *
 * This function looks. It does not type, click, dismiss, or solve. When X asks
 * for a code, a CAPTCHA, a key, or a confirmation that a sign-in was really the
 * owner, the only correct behaviour is to stop and hand the window back to the
 * person, and that is enforced by there being no other branch.
 *
 * The loop itself is the browser kit's, shared by every network. What is X's is
 * the signals it reads: where a signed-in page shows its marker, what a
 * challenge looks like, and where the form fields are.
 */
export const X_AUTH_SIGNALS: AuthSignals = {
  loggedIn: SEL.loggedIn,
  challenge: CHALLENGE_SIGNALS,
  usernameField: SEL_AUTH.usernameField,
  passwordField: SEL_AUTH.passwordField,
  readHandle,
};

export async function observeAuthPage(page: Page): Promise<AuthObservation> {
  return observeAuthWith(page, X_AUTH_SIGNALS);
}

/**
 * Which account this session belongs to.
 *
 * Two places, because X moved it. The profile link's href is `/handle` and is
 * where it lives now; the account switcher's aria-label used to carry it and no
 * longer does -- it reads "Account menu" on a real signed-in session, which is
 * why the health check reported "signed in" for months without ever knowing as
 * whom. Kept as a fallback rather than deleted, because a layout that still has
 * it costs nothing to read.
 */
async function readHandle(page: Page): Promise<string | null> {
  try {
    const href = await page.locator(SEL.profileLink).first().getAttribute('href', { timeout: 3_000 });
    // "/someone" and nothing else. A path with more in it is not a profile.
    const fromHref = href?.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (fromHref?.[1]) return fromHref[1];
  } catch {
    // Fall through to the older place.
  }
  try {
    const label = await page.locator(SEL.loggedIn).first().getAttribute('aria-label', { timeout: 3_000 });
    const match = label?.match(/@([A-Za-z0-9_]{1,15})/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
