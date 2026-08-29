export type BrowserEngine = 'GOOGLE_CHROME' | 'MICROSOFT_EDGE' | 'PLAYWRIGHT_CHROMIUM' | 'CUSTOM_CDP';

import type { BrowserContext, Page } from 'playwright';
import type { TabRole } from './tabs';

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
  /**
   * Which browser binary to use. Named after the binary rather than after the
   * arrangement, because "managed" told nobody what was actually running.
   */
  engine: BrowserEngine;
  mode: 'MANAGED' | 'CDP';
  /** Absolute path to a persistent profile. Not used by CUSTOM_CDP. */
  profileDir: string | null;
  /** e.g. http://127.0.0.1:9222. CUSTOM_CDP only. */
  cdpUrl: string | null;
  headless: boolean;
  channel?: BrowserChannel | null;
}

/** Everything known about the browser actually serving a session. */
export interface BrowserIdentity {
  engine: BrowserEngine;
  /** Absolute path AI17Z chose. Null when attaching to something it did not start. */
  executablePath: string | null;
  /** Product name from the binary: "Google Chrome". */
  product: string | null;
  version: string | null;
  pid: number | null;
  /** What the running browser reported over CDP: "Chrome/151.0.7922.175". */
  cdpProduct: string | null;
  cdpUrl: string | null;
  profileDir: string | null;
  connection: 'CDP' | 'PLAYWRIGHT';
  /** True only when both signals agree it is Google Chrome. */
  verifiedGoogleChrome: boolean;
}

export interface LeasedSession {
  /** What is actually running behind this session. */
  identity: BrowserIdentity;
  context: BrowserContext;
  page: Page;
  /** Which of the account's three tabs this page is. */
  role: TabRole;
  mode: 'MANAGED' | 'CDP';
  /** Release the tab back. Managed contexts stay warm; CDP stays attached. */
  release(): Promise<void>;
  /**
   * Release after a failure, recording it against this tab.
   *
   * Kept separate from `release` so a monitor that keeps failing shows as one
   * unhealthy surface rather than as an unhealthy account.
   */
  releaseFailed(message: string): Promise<void>;
}
