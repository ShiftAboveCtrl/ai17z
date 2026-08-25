import type { BrowserContext, Page } from 'playwright';

export type { BrowserContext, Page };

/**
 * Which browser build to drive.
 *
 * `chrome` and `msedge` use the real browser already installed on the machine,
 * which is what you want when the agent must act with a session you signed into
 * yourself. `chromium` uses the build Playwright ships, which is what the
 * container has.
 */
export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

export interface SessionConfig {
  accountId: string;
  mode: 'MANAGED' | 'CDP';
  /** Absolute path to a persistent profile. Managed mode only. */
  profileDir: string | null;
  /** e.g. http://127.0.0.1:9222. CDP mode only. */
  cdpUrl: string | null;
  headless: boolean;
  channel?: BrowserChannel | null;
}

export interface LeasedSession {
  context: BrowserContext;
  page: Page;
  mode: 'MANAGED' | 'CDP';
  /** Release the page back. Managed contexts stay warm; CDP stays attached. */
  release(): Promise<void>;
}
