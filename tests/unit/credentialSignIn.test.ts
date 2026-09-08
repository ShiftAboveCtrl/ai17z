import { describe, expect, it } from 'vitest';
import { signInWithStoredCredentials } from '@xbam/channels';

/**
 * The opt-in credential path, and the boundary it must not cross.
 *
 * `tests/unit/authObservation.test.ts` proves the observer never touches a
 * page. This file is its counterpart: it proves that the one path that *does*
 * touch a page still stops dead at a security challenge, and that it stops
 * before typing rather than after.
 *
 * The guard being tested is the ordering inside `observeAuthPage` -- challenge
 * signals are ranked above the login form, because several challenge screens
 * also carry an input box. Remove that ordering and "a challenge that also
 * shows an input box" below fails by typing a stored password into a security
 * prompt, which is exactly the accident the ordering exists to prevent.
 */

const LOGGED_IN = '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]';
const USERNAME = 'input[autocomplete="username"]';
const PASSWORD = 'input[name="password"], input[autocomplete="current-password"]';

const CREDENTIALS = { loginUsername: 'owner@example.test', loginPassword: 'correct-horse-battery' };

type Screen = 'username' | 'password' | 'challenge' | 'challengeWithBox' | 'signedIn' | 'between';

function visibleOn(screen: Screen): string[] {
  if (screen === 'signedIn') return [LOGGED_IN];
  if (screen === 'username') return [USERNAME];
  if (screen === 'password') return [PASSWORD];
  // A challenge screen that also renders an input box. X does this: the
  // two-factor step is a text field with a heading above it.
  if (screen === 'challengeWithBox') return [USERNAME];
  return [];
}

function bodyOn(screen: Screen): string {
  if (screen === 'challenge' || screen === 'challengeWithBox') return 'We sent you a code. Check your email to continue.';
  if (screen === 'username') return 'Sign in to X';
  if (screen === 'password') return 'Enter your password';
  if (screen === 'signedIn') return 'Home';
  return 'one moment';
}

/**
 * A fake Playwright page that records every value typed into it.
 *
 * `advance` decides what the page becomes when a field is submitted, which is
 * how a two-step form, a rejected password and a challenge appearing mid-flow
 * are all expressed without a browser.
 */
function fakePage(start: Screen, advance: (from: Screen) => Screen = (s) => s) {
  let screen: Screen = start;
  const typed: { selector: string; value: string }[] = [];
  const clicked: string[] = [];
  /** How many times the page has been read. One read is one observation. */
  const reads = { count: 0 };

  const page = {
    typed,
    clicked,
    reads,
    get screen() {
      return screen;
    },
    isClosed: () => false,
    locator(selector: string) {
      return {
        first() {
          return this;
        },
        async waitFor() {
          if (!visibleOn(screen).includes(selector)) throw new Error('not visible');
        },
        async innerText() {
          if (selector === 'body') {
            reads.count += 1;
            return bodyOn(screen);
          }
          throw new Error('no text');
        },
        async getAttribute() {
          return '/someone';
        },
        async click() {
          clicked.push(selector);
        },
        async fill(value: string) {
          typed.push({ selector, value });
        },
        async press() {
          screen = advance(screen);
        },
      };
    },
  };
  return page as unknown as Parameters<typeof signInWithStoredCredentials>[0] & {
    typed: { selector: string; value: string }[];
    clicked: string[];
    reads: { count: number };
    screen: Screen;
  };
}

/** Fast enough that a multi-step case is not a multi-second test. */
const FAST = { pollMs: 1, deadlineMs: 3_000 };

describe('a security challenge stops the credential path', () => {
  it('types nothing when the page is a challenge, even though details are stored', async () => {
    const page = fakePage('challenge');
    const result = await signInWithStoredCredentials(page, CREDENTIALS, FAST);

    expect(result.observation.state).toBe('CHALLENGE');
    expect(result.observation.challengeKind).toBe('email_verification');
    expect(result.filled).toEqual([]);
    expect(page.typed).toEqual([]);
    expect(page.clicked).toEqual([]);
  });

  it('stops reading the page the moment it sees a challenge', async () => {
    // Not just "types nothing": it must also stop looking. Somebody is typing a
    // code into that window, and a loop that keeps reading it for ninety
    // seconds is the same defect `CHALLENGE_REQUIRES_USER` being outside
    // ACCOUNT_STATUSES_IN_PROGRESS exists to prevent. One read, then gone.
    const page = fakePage('challenge');
    await signInWithStoredCredentials(page, CREDENTIALS, { pollMs: 1, deadlineMs: 3_000 });

    expect(page.reads.count).toBe(1);
  });

  it('stops at a challenge that also shows an input box', async () => {
    // The regression this whole ordering exists for. The screen has a visible
    // field matching the username selector *and* challenge wording. Read as a
    // login form, the stored password goes into a security prompt.
    const page = fakePage('challengeWithBox');
    const result = await signInWithStoredCredentials(page, CREDENTIALS, FAST);

    expect(result.observation.state).toBe('CHALLENGE');
    expect(result.filled).toEqual([]);
    expect(page.typed).toEqual([]);
  });

  it('stops when a challenge appears after the details were accepted', async () => {
    // Two-factor is the normal case for an account with it switched on: the
    // password is accepted and then X asks for a code. Nothing answers it.
    const page = fakePage('username', (from) => (from === 'username' ? 'password' : 'challenge'));
    const result = await signInWithStoredCredentials(page, CREDENTIALS, FAST);

    expect(result.observation.state).toBe('CHALLENGE');
    expect(result.filled).toEqual(['username', 'password']);
    // It typed the two things it was given and then stopped. Nothing was typed
    // into the challenge screen itself.
    expect(page.typed).toHaveLength(2);
  });
});

describe('signing in with stored details', () => {
  it('answers each step of a plain login form and reports being signed in', async () => {
    const page = fakePage('username', (from) => (from === 'username' ? 'password' : 'signedIn'));
    const result = await signInWithStoredCredentials(page, CREDENTIALS, FAST);

    expect(result.observation.state).toBe('SIGNED_IN');
    expect(result.filled).toEqual(['username', 'password']);
    expect(page.typed).toEqual([
      { selector: USERNAME, value: CREDENTIALS.loginUsername },
      { selector: PASSWORD, value: CREDENTIALS.loginPassword },
    ]);
  });

  it('hands the window over rather than retrying details X did not accept', async () => {
    // The password step comes back after the password was submitted. Trying
    // again is how an account gets locked, so this gives up and says so.
    const page = fakePage('password', () => 'password');
    const result = await signInWithStoredCredentials(page, CREDENTIALS, FAST);

    expect(result.observation.state).toBe('AWAITING_LOGIN');
    expect(result.observation.detail).toMatch(/did not accept/i);
    expect(result.filled).toEqual(['password']);
    // Exactly once. A retry loop here is the failure mode.
    expect(page.typed).toHaveLength(1);
  });

  it('waits through a page that shows nothing recognisable rather than giving up', async () => {
    const page = fakePage('between');
    const result = await signInWithStoredCredentials(page, CREDENTIALS, { pollMs: 1, deadlineMs: 60 });

    expect(result.observation.state).toBe('AUTHENTICATING');
    expect(result.filled).toEqual([]);
    expect(page.typed).toEqual([]);
  });

  it('does nothing at all when the session is already signed in', async () => {
    const page = fakePage('signedIn');
    const result = await signInWithStoredCredentials(page, CREDENTIALS, FAST);

    expect(result.observation.state).toBe('SIGNED_IN');
    expect(page.typed).toEqual([]);
  });
});
