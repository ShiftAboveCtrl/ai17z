import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { PipelineError, createLogger, envBool, errorMessage } from '@xbam/shared';
import type { LeasedSession, SessionConfig } from './types';

const log = createLogger('browser');

interface Entry {
  context: BrowserContext;
  mode: 'MANAGED' | 'CDP';
  createdAt: number;
  lastUsedAt: number;
  closing: boolean;
}

/** Recycle a context after this long without a successful operation. */
const STALE_MS = 15 * 60_000;

const contexts = new Map<string, Entry>();

export function browserEnabled(): boolean {
  return envBool('XBAM_BROWSER_ENABLED', true);
}

async function loadPlaywright() {
  try {
    // Imported lazily so the API process and browser-free deployments never pay
    // for Playwright, and so a missing install produces a clear message.
    return await import('playwright');
  } catch (error) {
    throw PipelineError.permanent(
      'playwright_missing',
      'Playwright is not installed in this environment. Run: npx playwright install chromium',
      {},
      error,
    );
  }
}

async function openContext(config: SessionConfig): Promise<Entry> {
  const { chromium } = await loadPlaywright();

  if (config.mode === 'CDP') {
    if (!config.cdpUrl) {
      throw PipelineError.permanent('cdp_url_missing', 'This account is in CDP mode but has no CDP URL configured.');
    }
    try {
      const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 15_000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      return { context, mode: 'CDP', createdAt: Date.now(), lastUsedAt: Date.now(), closing: false };
    } catch (error) {
      throw PipelineError.retryable(
        'cdp_connect_failed',
        `Could not attach to Chrome at ${config.cdpUrl}. Is it running with --remote-debugging-port?`,
        { cdpUrl: config.cdpUrl },
        error,
      );
    }
  }

  if (!config.profileDir) {
    throw PipelineError.permanent('profile_dir_missing', 'Managed browser mode requires a profile directory.');
  }
  await mkdir(config.profileDir, { recursive: true });
  try {
    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    return { context, mode: 'MANAGED', createdAt: Date.now(), lastUsedAt: Date.now(), closing: false };
  } catch (error) {
    throw PipelineError.retryable(
      'browser_launch_failed',
      `Could not launch the managed browser: ${errorMessage(error)}`,
      { profileDir: config.profileDir },
      error,
    );
  }
}

/**
 * Leases a page for one operation. Contexts are kept warm per account and
 * recycled when stale, which is what the legacy system achieved with a manual
 * CDP-reconnect timer, except here it is owned by the application.
 */
export async function leaseSession(config: SessionConfig): Promise<LeasedSession> {
  if (!browserEnabled()) {
    throw PipelineError.permanent(
      'browser_disabled',
      'Browser automation is disabled (XBAM_BROWSER_ENABLED=0). Use the mock channel or enable it.',
    );
  }

  let entry = contexts.get(config.accountId);
  if (entry && (entry.closing || Date.now() - entry.lastUsedAt > STALE_MS)) {
    await closeSession(config.accountId);
    entry = undefined;
  }
  if (entry) {
    // A context whose browser died still looks alive in the map until touched.
    try {
      entry.context.pages();
    } catch {
      await closeSession(config.accountId);
      entry = undefined;
    }
  }
  if (!entry) {
    entry = await openContext(config);
    contexts.set(config.accountId, entry);
    log.info('browser context opened', { accountId: config.accountId, mode: entry.mode });
  }

  const context = entry.context;
  const existing = context.pages();
  const page: Page = existing.length > 0 ? existing[0]! : await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  const current = entry;
  return {
    context,
    page,
    mode: current.mode,
    async release() {
      current.lastUsedAt = Date.now();
    },
  };
}

export async function closeSession(accountId: string): Promise<void> {
  const entry = contexts.get(accountId);
  if (!entry) return;
  contexts.delete(accountId);
  entry.closing = true;
  try {
    if (entry.mode === 'MANAGED') await entry.context.close();
    else await entry.context.browser()?.close();
  } catch (error) {
    log.warn('failed to close browser context cleanly', { accountId, message: errorMessage(error) });
  }
}

export async function closeAllSessions(): Promise<void> {
  await Promise.all([...contexts.keys()].map((id) => closeSession(id)));
}

export function defaultProfileDir(accountId: string): string {
  const base = process.env.XBAM_BROWSER_PROFILE_DIR || './storage/browser-profiles';
  return resolve(base, accountId);
}

export function activeSessionCount(): number {
  return contexts.size;
}
