import type { Page } from 'playwright';
import type { CredentialSignInResult, LoginCredentials } from '../contract';
import { runCredentialSignIn } from '../browserKit';
import { observeAuthPage } from './auth';
import { SEL_AUTH } from './selectors';

/**
 * Types an account's stored sign-in details into the X login form.
 *
 * Deliberately a separate file from `auth.ts`. That one observes and has no
 * branch that touches the page, which is what its test asserts; this one acts,
 * and is only ever reached because somebody stored credentials and asked for
 * them to be used. Keeping them apart means "look at the window" can never
 * become "act on the window" by accident.
 *
 * The loop is the browser kit's and is given `observeAuthPage` as the only way
 * it can learn what the page is. That function checks `CHALLENGE_SIGNALS`
 * *before* it will report a login form, so a CHALLENGE verdict is the only thing
 * the loop can see on a challenge screen, and it returns without touching
 * anything. Do not pass anything else as `observe`, and do not add a selector
 * check here that runs ahead of it.
 *
 * What this does not do, in any branch: solve a CAPTCHA, enter a code from an
 * email or a text, answer a two-factor prompt, confirm an unusual sign-in,
 * dismiss a warning, or retry a rejected password.
 */
export async function signInWithStoredCredentials(
  page: Page,
  credentials: LoginCredentials,
  options: {
    deadlineMs?: number;
    /** Between reads. The default is paced for a real browser. */
    pollMs?: number;
  } = {},
): Promise<CredentialSignInResult> {
  return runCredentialSignIn(page, credentials, {
    observe: observeAuthPage,
    usernameField: SEL_AUTH.usernameField,
    passwordField: SEL_AUTH.passwordField,
    networkName: 'X',
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  });
}
