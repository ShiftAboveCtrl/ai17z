import type { Page } from 'playwright';
import type { AuthObservation } from '../contract';
import { CHALLENGE_SIGNALS, SEL, SEL_AUTH } from './selectors';

/**
 * Reads an open sign-in window and says what it shows.
 *
 * This function looks. It does not type, click, dismiss, or solve. When X asks
 * for a code, a CAPTCHA, a key, or a confirmation that a sign-in was really the
 * owner, the only correct behaviour is to stop and hand the window back to the
 * person, and that is enforced here by there being no other branch.
 */
export async function observeAuthPage(page: Page): Promise<AuthObservation> {
  // Signed in is checked first and cheaply: once the account switcher is on the
  // page, nothing else about the sign-in flow matters.
  if (await visible(page, SEL.loggedIn, 1_500)) {
    return { state: 'SIGNED_IN', detail: 'Signed in.', handle: await readHandle(page) };
  }

  const body = await bodyText(page);
  if (body === null) return { state: 'UNREACHABLE', detail: 'The sign-in window is not responding.' };

  // A challenge outranks everything below it. Checking it before the password
  // field matters: several challenge screens also carry an input box, and
  // mistaking one for a login form is how an automated flow ends up typing into
  // a security prompt.
  for (const signal of CHALLENGE_SIGNALS) {
    const bySelector = signal.selector ? await visible(page, signal.selector, 500) : false;
    const byText = signal.text ? signal.text.test(body) : false;
    if (bySelector || byText) {
      return { state: 'CHALLENGE', detail: signal.describe, challengeKind: signal.kind };
    }
  }

  if (await visible(page, SEL_AUTH.usernameField, 500)) {
    return { state: 'AWAITING_LOGIN', detail: 'Waiting for the username.' };
  }
  if (await visible(page, SEL_AUTH.passwordField, 500)) {
    return { state: 'AWAITING_LOGIN', detail: 'Waiting for the password.' };
  }

  // Between steps X often shows nothing recognisable for a second or two. That
  // is a sign-in in progress, not a failure.
  return { state: 'AUTHENTICATING', detail: 'Sign-in in progress.' };
}

async function visible(page: Page, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function bodyText(page: Page): Promise<string | null> {
  try {
    return (await page.locator('body').innerText({ timeout: 5_000 })) ?? '';
  } catch {
    // A navigation mid-read is normal during a sign-in; it is not unreachable.
    return page.isClosed() ? null : '';
  }
}

async function readHandle(page: Page): Promise<string | null> {
  try {
    const label = await page.locator(SEL.loggedIn).first().getAttribute('aria-label', { timeout: 3_000 });
    const match = label?.match(/@([A-Za-z0-9_]{1,15})/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
