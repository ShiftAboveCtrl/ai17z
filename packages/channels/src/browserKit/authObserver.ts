import type { Page } from 'playwright';
import type { AuthObservation } from '../contract';

/**
 * Reading an open sign-in window, on any network.
 *
 * This file looks. It does not type, click, dismiss, or solve, and it has no
 * import that could: the only thing it is handed is a page to read. When a
 * network asks for a code, a CAPTCHA, a key, or a confirmation that a sign-in
 * was really the owner, the only correct behaviour is to stop and hand the
 * window back to the person, and that is enforced here by there being no other
 * branch.
 *
 * The *shape* of the loop is shared and the *signals* are the network's own:
 * what a signed-in page shows, what a challenge looks like and where the form
 * fields are all arrive as data. What cannot be configured is the order. A
 * challenge is ranked above the login form, because several challenge screens
 * also carry an input box and reading one as a form is exactly how an
 * automated flow types a stored password into a security prompt.
 */

/** One thing a network can show that only its owner can answer. */
export interface ChallengeSignal {
  kind: string;
  describe: string;
  selector?: string;
  text?: RegExp;
}

/** Everything a network contributes to reading its own sign-in page. */
export interface AuthSignals {
  /** Present only when a session is authenticated. */
  loggedIn: string;
  /** Matched generously: a challenge that goes unrecognised is one a flow might blunder into. */
  challenge: readonly ChallengeSignal[];
  usernameField: string;
  passwordField: string;
  /** Which account a signed-in page belongs to. Reads only. */
  readHandle: (page: Page) => Promise<string | null>;
}

/** What each of the three timeouts is for: the cheap signed-in check, a selector probe, a field probe. */
const SIGNED_IN_PROBE_MS = 1_500;
const PROBE_MS = 500;

export async function observeAuthWith(page: Page, signals: AuthSignals): Promise<AuthObservation> {
  // Signed in is checked first and cheaply: once the account marker is on the
  // page, nothing else about the sign-in flow matters.
  if (await visible(page, signals.loggedIn, SIGNED_IN_PROBE_MS)) {
    return { state: 'SIGNED_IN', detail: 'Signed in.', handle: await signals.readHandle(page) };
  }

  const body = await bodyText(page);
  if (body === null) return { state: 'UNREACHABLE', detail: 'The sign-in window is not responding.' };

  // A challenge outranks everything below it. See the note at the top of this
  // file: this ordering is the guarantee, and it is why the loop is not
  // configurable beyond the signals it reads.
  for (const signal of signals.challenge) {
    const bySelector = signal.selector ? await visible(page, signal.selector, PROBE_MS) : false;
    const byText = signal.text ? signal.text.test(body) : false;
    if (bySelector || byText) {
      return { state: 'CHALLENGE', detail: signal.describe, challengeKind: signal.kind };
    }
  }

  if (await visible(page, signals.usernameField, PROBE_MS)) {
    return { state: 'AWAITING_LOGIN', detail: 'Waiting for the username.' };
  }
  if (await visible(page, signals.passwordField, PROBE_MS)) {
    return { state: 'AWAITING_LOGIN', detail: 'Waiting for the password.' };
  }

  // Between steps a site often shows nothing recognisable for a second or two.
  // That is a sign-in in progress, not a failure.
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
