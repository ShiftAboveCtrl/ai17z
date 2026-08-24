import type { BrowserContext, Page } from 'playwright';

export type { BrowserContext, Page };

export interface SessionConfig {
  accountId: string;
  mode: 'MANAGED' | 'CDP';
  /** Absolute path to a persistent Chromium profile. Managed mode only. */
  profileDir: string | null;
  /** e.g. http://127.0.0.1:9222. CDP mode only. */
  cdpUrl: string | null;
  headless: boolean;
}

export interface LeasedSession {
  context: BrowserContext;
  page: Page;
  mode: 'MANAGED' | 'CDP';
  /** Release the page back. Managed contexts stay warm; CDP stays attached. */
  release(): Promise<void>;
}
