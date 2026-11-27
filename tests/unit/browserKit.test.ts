import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  observeAuthWith,
  runCredentialSignIn,
  type AuthSignals,
  type InPageJsonAnswer,
} from '../../packages/channels/src/browserKit';

/**
 * The browser machinery every network shares, proved against a network that is
 * not X. Nothing here mentions X's selectors: if the kit were still secretly
 * X-shaped, a page that uses different ones would not read correctly.
 *
 * The rule these exist to hold is the one `CLAUDE.md` calls structural: a
 * CHALLENGE verdict stops and types nothing, and it does so because of the order
 * the observation ranks things in, not because a caller remembered to check.
 */

const NETWORK: AuthSignals = {
  loggedIn: '#home-nav',
  challenge: [
    { kind: 'code', describe: 'The network wants a code.', text: /enter the code we sent/i },
    { kind: 'captcha', describe: 'The network is showing a CAPTCHA.', selector: 'iframe.captcha' },
  ],
  usernameField: '#user',
  passwordField: '#pass',
  readHandle: async () => 'someone',
};

type Screen = 'username' | 'password' | 'challenge' | 'challengeWithBox' | 'captcha' | 'signedIn' | 'between';

const VISIBLE: Record<Screen, string[]> = {
  username: ['#user'],
  password: ['#pass'],
  challenge: [],
  challengeWithBox: ['#user'],
  captcha: ['iframe.captcha', '#user'],
  signedIn: ['#home-nav'],
  between: [],
};

const BODY: Record<Screen, string> = {
  username: 'Log in',
  password: 'Your password',
  challenge: 'Enter the code we sent you',
  challengeWithBox: 'Enter the code we sent you',
  captcha: '',
  signedIn: 'Home',
  between: 'one moment',
};

function fakePage(start: Screen, advance: (from: Screen) => Screen = (screen) => screen) {
  let screen = start;
  const typed: string[] = [];
  const touched: string[] = [];
  const reads = { count: 0 };
  const page = {
    typed,
    touched,
    reads,
    isClosed: () => false,
    locator(selector: string) {
      return {
        first() {
          return this;
        },
        async waitFor() {
          if (!VISIBLE[screen].includes(selector)) throw new Error('not visible');
        },
        async innerText() {
          if (selector === 'body') {
            reads.count += 1;
            return BODY[screen];
          }
          throw new Error('no text');
        },
        async click() {
          touched.push(`click ${selector}`);
        },
        async fill(value: string) {
          typed.push(value);
        },
        async press() {
          screen = advance(screen);
        },
      };
    },
  };
  return page as unknown as Parameters<typeof observeAuthWith>[0] & { typed: string[]; touched: string[]; reads: { count: number } };
}

const CREDENTIALS = { loginUsername: 'owner@example.test', loginPassword: 'correct-horse-battery' };
const FAST = { pollMs: 1, deadlineMs: 2_000 };

describe('reading a sign-in window on any network', () => {
  const observe = (page: ReturnType<typeof fakePage>) => observeAuthWith(page, NETWORK);

  it('reads the signed-in marker and the handle from the network’s own signals', async () => {
    const seen = await observe(fakePage('signedIn'));
    expect(seen).toMatchObject({ state: 'SIGNED_IN', handle: 'someone' });
  });

  it('reads the login form from the network’s own field selectors', async () => {
    expect((await observe(fakePage('username'))).state).toBe('AWAITING_LOGIN');
    expect((await observe(fakePage('password'))).state).toBe('AWAITING_LOGIN');
  });

  it('treats a page it does not recognise mid-flow as in progress', async () => {
    expect((await observe(fakePage('between'))).state).toBe('AUTHENTICATING');
  });

  it('ranks a challenge above a login form on the same page', async () => {
    const seen = await observe(fakePage('challengeWithBox'));
    expect(seen).toMatchObject({ state: 'CHALLENGE', challengeKind: 'code' });
  });

  it('recognises a challenge by its selector alone', async () => {
    const seen = await observe(fakePage('captcha'));
    expect(seen).toMatchObject({ state: 'CHALLENGE', challengeKind: 'captcha' });
  });

  it('never touches the page while it looks', async () => {
    const page = fakePage('challengeWithBox');
    await observe(page);
    expect(page.touched).toEqual([]);
    expect(page.typed).toEqual([]);
  });
});

describe('typing stored details on any network', () => {
  const config = (extra: object = {}) => ({
    observe: (page: Parameters<typeof observeAuthWith>[0]) => observeAuthWith(page, NETWORK),
    usernameField: NETWORK.usernameField,
    passwordField: NETWORK.passwordField,
    networkName: 'Elsewhere',
    ...FAST,
    ...extra,
  });

  it('types nothing and reads once when the page is a challenge, even with a box on it', async () => {
    for (const screen of ['challenge', 'challengeWithBox', 'captcha'] as const) {
      const page = fakePage(screen);
      const result = await runCredentialSignIn(page, CREDENTIALS, config());
      expect(result.observation.state).toBe('CHALLENGE');
      expect(result.filled).toEqual([]);
      expect(page.typed).toEqual([]);
      expect(page.touched).toEqual([]);
      expect(page.reads.count).toBe(1);
    }
  });

  it('stops where it is when a challenge appears after the first step', async () => {
    const page = fakePage('username', (from) => (from === 'username' ? 'challengeWithBox' : from));
    const result = await runCredentialSignIn(page, CREDENTIALS, config());
    expect(result.observation.state).toBe('CHALLENGE');
    // The username went in before anything was shown; the password never does.
    expect(page.typed).toEqual([CREDENTIALS.loginUsername]);
    expect(result.filled).toEqual(['username']);
  });

  it('fills both steps of an ordinary form and finishes signed in', async () => {
    const page = fakePage('username', (from) => (from === 'username' ? 'password' : 'signedIn'));
    const result = await runCredentialSignIn(page, CREDENTIALS, config());
    expect(result.observation.state).toBe('SIGNED_IN');
    expect(page.typed).toEqual([CREDENTIALS.loginUsername, CREDENTIALS.loginPassword]);
  });

  it('hands the window over, in the network’s name, rather than retrying a rejected step', async () => {
    const page = fakePage('username');
    const result = await runCredentialSignIn(page, CREDENTIALS, config());
    expect(result.observation.state).toBe('AWAITING_LOGIN');
    expect(result.observation.detail).toBe('Elsewhere did not accept the stored sign-in details. The window is open for you to finish.');
    expect(page.typed).toEqual([CREDENTIALS.loginUsername]);
  });
});

describe('typing into a composer', () => {
  it('compares what was sent with what a page renders by letters and digits only', () => {
    expect(fingerprint("Hello, @someone... it's 9am!")).toBe(fingerprint('hello @someone  -its 9AM'));
    expect(fingerprint('one two')).not.toBe(fingerprint('one two three'));
  });
});

describe('asking a same-origin JSON endpoint from the page', () => {
  it('can only hand back the answer: no field a credential could travel in', () => {
    // The shape is the contract. A fifth field carrying a token would have to be
    // added to this type first, and `packagedEnvironment.test.ts` holds the X
    // reader to the same four.
    const answer: InPageJsonAnswer = { ok: true, status: 200, error: null, json: {} };
    expect(Object.keys(answer).sort()).toEqual(['error', 'json', 'ok', 'status']);
    const source = readFileSync(join(__dirname, '../../packages/channels/src/browserKit/pageJson.ts'), 'utf8');
    const shape = source.slice(source.indexOf('export interface InPageJsonAnswer'), source.indexOf('export async function'));
    for (const leak of ['csrf', 'bearer', 'cookie', 'token']) expect(shape.toLowerCase()).not.toContain(leak);
  });
});

describe('the kit stays free of any one network', () => {
  const folder = join(__dirname, '../../packages/channels/src/browserKit');
  const files = readdirSync(folder).filter((name) => name.endsWith('.ts'));

  it('has files to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('imports nothing from a network’s folder', () => {
    for (const name of files) {
      const source = readFileSync(join(folder, name), 'utf8');
      expect(source, name).not.toMatch(/from ['"]\.\.\/(x|bluesky|farcaster|telegram|mock)\//);
    }
  });

  it('names no X selector, address or test id', () => {
    for (const name of files) {
      const code = readFileSync(join(folder, name), 'utf8')
        // Prose may explain where an idea came from; only code is held to this.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, name).not.toMatch(/x\.com|twitter|data-testid|tweet/i);
    }
  });

  it('keeps the observer unable to act: it imports no way to type or click', () => {
    const source = readFileSync(join(folder, 'authObserver.ts'), 'utf8');
    expect(source).not.toMatch(/\.(fill|click|type|press|check|dispatchEvent)\(/);
  });
});
