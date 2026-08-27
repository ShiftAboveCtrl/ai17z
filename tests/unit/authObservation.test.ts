import { describe, expect, it } from 'vitest';
import { CHALLENGE_SIGNALS, observeAuthPage } from '@xbam/channels';
import { ACCOUNT_STATUSES, ACCOUNT_STATUSES_IN_PROGRESS, ACCOUNT_STATUSES_NEEDING_PERSON } from '@xbam/shared/contracts';

/**
 * A fake Playwright page. Only the four calls observeAuthPage makes are
 * implemented, and every one of them records that it happened, so a test can
 * assert the observer looked and did not touch anything.
 */
function fakePage(options: { visible?: string[]; body?: string; closed?: boolean } = {}) {
  const visible = new Set(options.visible ?? []);
  const touched: string[] = [];
  const page = {
    touched,
    isClosed: () => options.closed ?? false,
    locator(selector: string) {
      return {
        first() {
          return this;
        },
        async waitFor() {
          if (!visible.has(selector)) throw new Error('not visible');
        },
        async innerText() {
          // A closed page throws here, which is the only way the observer can
          // tell "gone" from "showing something I do not recognise".
          if (options.closed) throw new Error('Target page, context or browser has been closed');
          if (selector === 'body') return options.body ?? '';
          throw new Error('no text');
        },
        async getAttribute() {
          return '@someone';
        },
        // Anything that would change the page records itself and fails the test.
        async click() {
          touched.push(`click ${selector}`);
        },
        async fill(value: string) {
          touched.push(`fill ${selector} ${value}`);
        },
        async press(key: string) {
          touched.push(`press ${selector} ${key}`);
        },
      };
    },
  };
  return page as unknown as Parameters<typeof observeAuthPage>[0] & { touched: string[] };
}

const LOGGED_IN = '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]';
const USERNAME = 'input[autocomplete="username"]';

describe('reading a sign-in window', () => {
  it('reports a signed-in session and reads the handle', async () => {
    const seen = await observeAuthPage(fakePage({ visible: [LOGGED_IN] }));
    expect(seen.state).toBe('SIGNED_IN');
    expect(seen.handle).toBe('someone');
  });

  it('reports waiting when the login form is showing', async () => {
    const seen = await observeAuthPage(fakePage({ visible: [USERNAME], body: 'Sign in to X' }));
    expect(seen.state).toBe('AWAITING_LOGIN');
  });

  it('treats an unrecognisable page mid-flow as still in progress, not a failure', async () => {
    const seen = await observeAuthPage(fakePage({ body: 'one moment' }));
    expect(seen.state).toBe('AUTHENTICATING');
  });

  it('reports unreachable only when the page is actually gone', async () => {
    const seen = await observeAuthPage(fakePage({ closed: true }));
    expect(seen.state).toBe('UNREACHABLE');
  });
});

describe('security challenges stop the sign-in', () => {
  const cases: [string, string, string][] = [
    ['two_factor', 'Enter your two-factor authentication code', 'two_factor'],
    ['emailed code', 'We sent you a code. Check your email to continue.', 'email_verification'],
    ['phone', 'Enter your phone number to continue', 'phone_verification'],
    ['captcha wording', 'Solve this puzzle to prove you are human', 'captcha'],
    ['suspicious login', 'We noticed unusual login activity on your account', 'suspicious_login'],
    ['locked account', 'Your account has been locked', 'account_locked'],
    ['hardware key', 'Insert your security key to continue', 'hardware_key'],
  ];

  for (const [name, body, kind] of cases) {
    it(`recognises ${name} and asks for the owner`, async () => {
      const seen = await observeAuthPage(fakePage({ body }));
      expect(seen.state).toBe('CHALLENGE');
      expect(seen.challengeKind).toBe(kind);
    });
  }

  it('recognises a CAPTCHA frame even with no matching text', async () => {
    const seen = await observeAuthPage(
      fakePage({ visible: ['iframe[src*="recaptcha"], iframe[src*="arkoselabs"], iframe[title*="challenge" i]'], body: '' }),
    );
    expect(seen.state).toBe('CHALLENGE');
    expect(seen.challengeKind).toBe('captcha');
  });

  it('prefers the challenge when a challenge screen also carries an input box', async () => {
    // Several challenge screens look like a login form. Reading it as one is how
    // an automated flow would end up typing into a security prompt.
    const seen = await observeAuthPage(
      fakePage({ visible: [USERNAME], body: 'Enter the verification code we sent you' }),
    );
    expect(seen.state).toBe('CHALLENGE');
  });

  it('never clicks, fills, or presses anything while observing', async () => {
    for (const [, body] of cases) {
      const page = fakePage({ body });
      await observeAuthPage(page);
      expect(page.touched).toEqual([]);
    }
    const signedIn = fakePage({ visible: [LOGGED_IN] });
    await observeAuthPage(signedIn);
    expect(signedIn.touched).toEqual([]);
  });

  it('describes every challenge without repeating its content', () => {
    for (const signal of CHALLENGE_SIGNALS) {
      expect(signal.describe.length).toBeGreaterThan(10);
      expect(signal.kind).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('the account state vocabulary', () => {
  it('separates states that need a person from steps that are under way', () => {
    for (const status of ACCOUNT_STATUSES_NEEDING_PERSON) {
      expect(ACCOUNT_STATUSES_IN_PROGRESS).not.toContain(status);
    }
    for (const status of [...ACCOUNT_STATUSES_NEEDING_PERSON, ...ACCOUNT_STATUSES_IN_PROGRESS]) {
      expect(ACCOUNT_STATUSES).toContain(status);
    }
  });

  it('keeps a challenge out of the in-progress set, so nothing keeps polling it', () => {
    expect(ACCOUNT_STATUSES_IN_PROGRESS).not.toContain('CHALLENGE_REQUIRES_USER');
    expect(ACCOUNT_STATUSES_NEEDING_PERSON).toContain('CHALLENGE_REQUIRES_USER');
  });
});
