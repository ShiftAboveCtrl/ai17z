import type { Page } from 'playwright';
import { envInt, sleep } from '@xbam/shared';
import type { AuthObservation, CredentialSignInResult, LoginCredentials } from '../contract';

/**
 * Typing an account's stored sign-in details into a login form, on any network.
 *
 * Deliberately a separate file from `authObserver.ts`. That one observes and has
 * no branch that touches the page; this one acts, and is only ever reached
 * because somebody stored credentials and asked for them to be used. Keeping
 * them apart means "look at the window" can never become "act on the window" by
 * accident.
 *
 * **The challenge boundary is structural, not a convention.** This loop is not
 * given a page to inspect for itself: it is given `observe`, the network's own
 * observation, and it only ever learns what the page is from that. The
 * observation ranks challenge signals above the login form, so a CHALLENGE
 * verdict is the only thing this loop can see on such a page, and it returns
 * without touching anything. There is no selector check here that could run
 * ahead of it, and adding one would be adding the bug.
 *
 * What this does not do, in any branch: solve a CAPTCHA, enter a code from an
 * email or a text, answer a two-factor prompt, confirm an unusual sign-in,
 * dismiss a warning, or retry a rejected password.
 */

/**
 * How long to keep trying before handing the window to a person.
 *
 * Long enough for two form steps on a cold profile, short enough that an owner
 * watching the panel is not left wondering. Running out is not a failure: the
 * window is open on whatever the network is showing and the ordinary watcher
 * takes over.
 */
const DEFAULT_DEADLINE_MS = envInt('AI17Z_CREDENTIAL_SIGNIN_MS', 90_000);

/** Between reads. Each one drives a real page, and a login step is not instant. */
const POLL_MS = envInt('AI17Z_CREDENTIAL_SIGNIN_POLL_MS', 1_500);

/**
 * How long to wait for a field before deciding it is not this step.
 *
 * Short: the observation has already said a login form is showing, so the
 * question is only which of the two steps it is.
 */
const FIELD_MS = 750;

export interface CredentialLoopConfig {
  /** The network's own reading of the page. The only way this loop learns what it is looking at. */
  observe: (page: Page) => Promise<AuthObservation>;
  usernameField: string;
  passwordField: string;
  /** For the one sentence an owner reads when the stored details were not accepted. */
  networkName: string;
  deadlineMs?: number;
  /** Between reads. The default is paced for a real browser. */
  pollMs?: number;
}

export async function runCredentialSignIn(
  page: Page,
  credentials: LoginCredentials,
  config: CredentialLoopConfig,
): Promise<CredentialSignInResult> {
  const deadline = Date.now() + (config.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const pollMs = config.pollMs ?? POLL_MS;
  const filled: ('username' | 'password')[] = [];
  let observation: AuthObservation = { state: 'AUTHENTICATING', detail: 'Opening the sign-in form.' };

  while (Date.now() < deadline) {
    observation = await config.observe(page);

    // Three of the five states are terminal, and one of them is the point of
    // all of this: a challenge stops here with the page exactly as it was.
    if (observation.state === 'SIGNED_IN') return { observation, filled };
    if (observation.state === 'CHALLENGE') return { observation, filled };
    if (observation.state === 'UNREACHABLE') return { observation, filled };

    if (observation.state === 'AWAITING_LOGIN') {
      const step = await nextStep(page, config, filled);
      if (step === 'username') {
        await typeInto(page, config.usernameField, credentials.loginUsername);
        filled.push('username');
      } else if (step === 'password') {
        await typeInto(page, config.passwordField, credentials.loginPassword);
        filled.push('password');
      } else if (step === 'again') {
        // The same step is showing after it was filled, which means the network
        // did not accept what was stored. Trying again is how an account gets
        // locked, so this hands the open window over instead.
        return {
          observation: {
            state: 'AWAITING_LOGIN',
            detail: `${config.networkName} did not accept the stored sign-in details. The window is open for you to finish.`,
          },
          filled,
        };
      }
      // 'none' falls through: the page is between steps and there is nothing to
      // type yet, which is normal and not a reason to give up.
    }

    await sleep(pollMs);
  }

  // Out of time with the window still open on something ordinary. Reported as
  // it was last seen so the watcher and the person can carry on from here.
  return { observation, filled };
}

/**
 * Which step the form is on, and whether it has already been answered.
 *
 * The password field is tested first because it is the more specific of the
 * two: a second step renders it alongside a hidden username input, and matching
 * the username there would retype a name that is already accepted.
 */
async function nextStep(
  page: Page,
  config: CredentialLoopConfig,
  filled: readonly ('username' | 'password')[],
): Promise<'username' | 'password' | 'again' | 'none'> {
  if (await visible(page, config.passwordField)) {
    return filled.includes('password') ? 'again' : 'password';
  }
  if (await visible(page, config.usernameField)) {
    return filled.includes('username') ? 'again' : 'username';
  }
  return 'none';
}

async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector).first();
  await field.fill(value);
  // Both steps advance on Enter. Pressing it in the field beats hunting for a
  // button: more than one is rendered on a login form depending on the account
  // ("Next", "Log in", and a passkey button on some), and picking the wrong
  // one starts a flow nobody asked for.
  await field.press('Enter');
}

/**
 * A local copy rather than an import from `authObserver.ts`.
 *
 * That file is the observer and nothing here should be able to change it by
 * needing something from it. The duplication is four lines.
 */
async function visible(page: Page, selector: string): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: FIELD_MS });
    return true;
  } catch {
    return false;
  }
}
