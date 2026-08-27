import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { PipelineError, createLogger, envBool, errorMessage } from '@xbam/shared';
import type { BrowserChannel, LeasedSession, SessionConfig } from './types';

const log = createLogger('browser');

interface Entry {
  context: BrowserContext;
  mode: 'MANAGED' | 'CDP';
  createdAt: number;
  lastUsedAt: number;
  closing: boolean;
  /**
   * Set when the browser goes away underneath us — usually because a person
   * closed the window we opened for them to sign in.
   *
   * This has to be tracked explicitly. A closed persistent context does not
   * throw from `pages()`; it returns an empty array, so the cache looks healthy
   * right up until `newPage()` fails and every later attempt fails the same way.
   */
  dead: boolean;
}

/** Recycle a context after this long without a successful operation. */
const STALE_MS = 15 * 60_000;

/**
 * Marks the entry dead the moment the browser goes, so the next lease reopens
 * instead of handing out a handle to something that is no longer there.
 */
function watchForClose(accountId: string, entry: Entry): void {
  entry.context.on('close', () => {
    entry.dead = true;
    log.info('browser closed outside AI17Z', { accountId });
  });
}

/** True while the context still has a live browser behind it. */
function isUsable(context: BrowserContext): boolean {
  try {
    const browser = context.browser();
    // A persistent context reports no browser; falling back to pages() is the
    // only signal available, and it throws only once the context is disposed.
    if (browser) return browser.isConnected();
    context.pages();
    return true;
  } catch {
    return false;
  }
}

async function acquirePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages();
  return existing.length > 0 ? existing[0]! : await context.newPage();
}

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
      return { context, mode: 'CDP', createdAt: Date.now(), lastUsedAt: Date.now(), closing: false, dead: false };
    } catch (error) {
      throw explainCdpFailure(error, config.cdpUrl);
    }
  }

  if (!config.profileDir) {
    throw PipelineError.permanent('profile_dir_missing', 'Managed browser mode requires a profile directory.');
  }
  await mkdir(config.profileDir, { recursive: true });
  try {
    // Driving the real installed browser rather than the bundled Chromium is the
    // point when an account has to act with a session a person signed into: the
    // profile carries that session, and it persists across restarts.
    const channel: BrowserChannel | undefined =
      config.channel && config.channel !== 'chromium' ? config.channel : undefined;

    const context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      ...(channel ? { channel } : {}),
      viewport: { width: 1280, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    return { context, mode: 'MANAGED', createdAt: Date.now(), lastUsedAt: Date.now(), closing: false, dead: false };
  } catch (error) {
    throw explainLaunchFailure(error, config);
  }
}

/**
 * Attaching from a container to a browser on the host is the common way this
 * goes wrong, and the raw error does not say so. Chrome binds the debug port to
 * loopback and rejects requests whose Host header is not localhost, so a
 * container reaching host.docker.internal is refused even when the port is open.
 */
function explainCdpFailure(error: unknown, cdpUrl: string): PipelineError {
  const message = errorMessage(error);
  const inContainer = existsSync('/.dockerenv');
  const loopback = (() => {
    try {
      const host = new URL(cdpUrl).hostname;
      return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    } catch {
      return false;
    }
  })();

  if (inContainer && loopback) {
    return PipelineError.permanent(
      'cdp_unreachable_from_container',
      `This worker runs in a container, so ${cdpUrl} is the container itself, not your machine. Run the worker on the same machine as the browser (npm run dev:worker) and it will attach to this URL directly.`,
      { cdpUrl },
      error,
    );
  }

  if (inContainer) {
    return PipelineError.permanent(
      'cdp_unreachable_from_container',
      `The worker is containerised and could not attach to ${cdpUrl}. Chrome only accepts debug connections whose Host header is localhost, so reaching it from a container is refused even when the port is reachable. Run the worker on the machine where the browser is.`,
      { cdpUrl },
      error,
    );
  }

  if (/ECONNREFUSED|connect ECONNREFUSED|fetch failed/i.test(message)) {
    return PipelineError.retryable(
      'cdp_connect_refused',
      `Nothing is listening at ${cdpUrl}. Start the browser with --remote-debugging-port first (scripts/launch-chrome-cdp.ps1 does this), then try again.`,
      { cdpUrl },
      error,
    );
  }

  return PipelineError.retryable(
    'cdp_connect_failed',
    `Could not attach to the browser at ${cdpUrl}: ${message}`,
    { cdpUrl },
    error,
  );
}

/**
 * Playwright reports a version mismatch and a missing browser as the same thing:
 * a path that does not exist. Both are configuration problems with different
 * fixes, so they are separated here rather than passed through raw.
 */
function explainLaunchFailure(error: unknown, config: SessionConfig): PipelineError {
  const message = errorMessage(error);
  const channel = config.channel ?? 'chromium';

  if (/Please update docker image|was just updated to/i.test(message)) {
    const required = message.split('required:')[1]?.trim().split(' ')[0]?.trim() || 'the matching tag';
    return PipelineError.permanent(
      'playwright_image_mismatch',
      `The worker image ships different browser binaries than the installed Playwright. Rebuild the worker image against ${required}, or pin Playwright to the version the image carries. The two must match exactly.`,
      { required },
      error,
    );
  }

  if (channel !== 'chromium' && /Executable doesn't exist|Chromium distribution.*is not found/i.test(message)) {
    return PipelineError.permanent(
      'browser_channel_missing',
      `This account is set to drive real ${channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'}, which is not installed where the worker runs. Install it on that machine, or switch the account to the bundled Chromium.`,
      { channel },
      error,
    );
  }

  if (/Executable doesn't exist/i.test(message)) {
    return PipelineError.permanent(
      'browser_not_installed',
      'The worker has no browser binaries. Run "npx playwright install chromium" where the worker runs.',
      {},
      error,
    );
  }

  if (/ProcessSingleton|profile appears to be in use|Failed to create a ProcessSingleton/i.test(message)) {
    return PipelineError.permanent(
      'profile_in_use',
      `Another browser is already using the profile at ${config.profileDir}. Close it, or give this account its own profile directory.`,
      { profileDir: config.profileDir },
      error,
    );
  }

  return PipelineError.retryable(
    'browser_launch_failed',
    `Could not launch the browser: ${message}`,
    { profileDir: config.profileDir, channel },
    error,
  );
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
  if (entry && (entry.closing || entry.dead || Date.now() - entry.lastUsedAt > STALE_MS)) {
    await closeSession(config.accountId);
    entry = undefined;
  }
  if (entry && !isUsable(entry.context)) {
    await closeSession(config.accountId);
    entry = undefined;
  }
  if (!entry) {
    entry = await openContext(config);
    watchForClose(config.accountId, entry);
    contexts.set(config.accountId, entry);
    log.info('browser context opened', { accountId: config.accountId, mode: entry.mode });
  }

  let page: Page;
  try {
    page = await acquirePage(entry.context);
  } catch (error) {
    // The context died between the check above and here, which is exactly what
    // happens when somebody closes the window at the wrong moment. Reopen once
    // rather than making the account unusable until the process restarts.
    log.info('reopening a browser context that had gone away', { accountId: config.accountId });
    await closeSession(config.accountId);
    entry = await openContext(config);
    watchForClose(config.accountId, entry);
    contexts.set(config.accountId, entry);
    try {
      page = await acquirePage(entry.context);
    } catch (secondError) {
      throw explainLaunchFailure(secondError, config);
    }
    void error;
  }

  const context = entry.context;
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
    if (entry.mode === 'MANAGED') {
      // We launched it, so we close it.
      await entry.context.close();
    } else {
      // CDP browsers belong to the person who started them. Playwright detaches
      // here rather than terminating the process, and it must stay that way:
      // XBAM closing someone's signed-in browser would be a genuine harm.
      await entry.context.browser()?.close();
    }
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
