import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { PipelineError, createLogger, envBool, errorMessage } from '@xbam/shared';
import type { BrowserChannel, BrowserIdentity, LeasedSession, SessionConfig } from './types';
import {
  cdpIdentity,
  cdpIsGoogleChrome,
  closeChrome,
  existingChrome,
  launchChrome,
  waitForCdp,
  type LaunchedChrome,
} from './chrome';
import {
  acquireTab,
  adoptOpenTabs,
  lockTab,
  retagIfLost,
  tabHealth,
  type TabHealth,
  type TabMap,
  type TabRole,
} from './tabs';

const log = createLogger('browser');

interface Entry {
  context: BrowserContext;
  mode: 'MANAGED' | 'CDP';
  /** What is actually running, recorded at launch and shown in diagnostics. */
  identity: BrowserIdentity;
  /** Set when AI17Z started the browser itself and can report its pid. */
  launched: LaunchedChrome | null;
  createdAt: number;
  lastUsedAt: number;
  closing: boolean;
  /** The three role-bound tabs. Populated on first use of each role. */
  tabs: TabMap;
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


const contexts = new Map<string, Entry>();

/**
 * One launch at a time per account.
 *
 * Without this, two callers arriving together both find no cached context and
 * both start a browser. That was survivable when a launch was a Playwright
 * Chromium; now that it spawns real Chrome it means several windows opening on
 * somebody's desktop and two of them holding a profile that only one can have.
 */
const opening = new Map<string, Promise<Entry>>();

async function openOnce(config: SessionConfig): Promise<Entry> {
  const inFlight = opening.get(config.accountId);
  if (inFlight) return inFlight;

  // Claim whatever the browser already has open before anybody asks for a tab.
  // Attaching to a Chrome this process did not start finds the previous
  // worker's tabs, and adopting them here means health reports the truth from
  // the first snapshot rather than from the first action.
  const started = openContext(config)
    .then(async (entry) => {
      await adoptOpenTabs(entry.context, entry.tabs).catch(() => undefined);
      return entry;
    })
    .finally(() => opening.delete(config.accountId));
  opening.set(config.accountId, started);
  return started;
}

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

/**
 * Opens a browser for an account, by engine.
 *
 * Each engine resolves to exactly one binary and there is no path between them.
 * Asking for Google Chrome and getting Chromium because Chrome was missing is
 * the failure this function exists to make impossible.
 */
async function openContext(config: SessionConfig): Promise<Entry> {
  const { chromium } = await loadPlaywright();
  const now = Date.now();

  // ── Custom CDP: attach to something somebody else started ───────────────
  if (config.engine === 'CUSTOM_CDP') {
    if (!config.cdpUrl) {
      throw PipelineError.permanent('cdp_url_missing', 'This account uses a custom CDP endpoint but has none configured.');
    }
    try {
      const seen = await cdpIdentity(config.cdpUrl, 10_000);
      const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 15_000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      return {
        context,
        mode: 'CDP',
        identity: {
          engine: 'CUSTOM_CDP',
          // AI17Z did not start it, so it cannot claim to know the path.
          executablePath: null,
          product: seen.product,
          version: seen.product.split('/')[1] ?? null,
          pid: null,
          cdpProduct: seen.product,
          cdpUrl: config.cdpUrl,
          profileDir: null,
          connection: 'CDP',
          verifiedGoogleChrome: cdpIsGoogleChrome(seen),
        },
        launched: null,
        createdAt: now,
        lastUsedAt: now,
        closing: false,
        dead: false,
        tabs: new Map(),
      };
    } catch (error) {
      throw explainCdpFailure(error, config.cdpUrl);
    }
  }

  // ── Playwright Chromium: the bundled build, chosen deliberately ─────────
  if (config.engine === 'PLAYWRIGHT_CHROMIUM') {
    if (!config.profileDir) {
      throw PipelineError.permanent('profile_missing', 'This account has no profile directory configured.');
    }
    await mkdir(config.profileDir, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(config.profileDir, {
        headless: config.headless,
        viewport: { width: 1280, height: 900 },
        args: ['--no-first-run', '--no-default-browser-check'],
      });
      return {
        context,
        mode: 'MANAGED',
        identity: {
          engine: 'PLAYWRIGHT_CHROMIUM',
          executablePath: chromium.executablePath(),
          product: 'Playwright Chromium',
          version: null,
          pid: null,
          cdpProduct: null,
          cdpUrl: null,
          profileDir: config.profileDir,
          connection: 'PLAYWRIGHT',
          verifiedGoogleChrome: false,
        },
        launched: null,
        createdAt: now,
        lastUsedAt: now,
        closing: false,
        dead: false,
        tabs: new Map(),
      };
    } catch (error) {
      throw explainLaunchFailure(error, config);
    }
  }

  // ── Real Chrome or Edge: AI17Z starts the binary, then attaches ─────────
  //
  // The legacy system that worked on this account for months started Chrome
  // externally and attached over CDP. Two properties follow from that and both
  // matter: the browser outlives the worker, so restarting AI17Z does not close
  // a window somebody is signing in to; and AI17Z picks the executable itself,
  // so it can say which binary is running rather than trusting a resolver.
  if (!config.profileDir) {
    throw PipelineError.permanent('profile_missing', 'This account has no profile directory configured.');
  }

  const launched = await launchChrome({
    engine: config.engine,
    profileDir: config.profileDir,
    startUrl: 'https://x.com/home',
    headless: config.headless,
  });

  try {
    const seen = await waitForCdp(launched.cdpUrl, 30_000);
    const browser = await chromium.connectOverCDP(launched.cdpUrl, { timeout: 20_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());

    const verified = config.engine === 'GOOGLE_CHROME' ? cdpIsGoogleChrome(seen) : true;
    if (config.engine === 'GOOGLE_CHROME' && !verified) {
      // The executable said Google Chrome and the running browser says
      // something else. Refuse rather than proceed on a half-verified claim.
      throw PipelineError.permanent(
        'not_google_chrome',
        `Started ${launched.installation.executable} but the running browser reports "${seen.product}". ` +
          'AI17Z did not fall back to Chromium; it stopped instead.',
      );
    }

    log.info('real browser attached', {
      engine: config.engine,
      executable: launched.installation.executable,
      product: seen.product,
      pid: launched.pid,
      cdpUrl: launched.cdpUrl,
    });

    return {
      context,
      mode: 'CDP',
      identity: {
        engine: config.engine,
        executablePath: launched.installation.executable,
        product: launched.installation.product,
        version: launched.installation.version,
        pid: launched.pid,
        cdpProduct: seen.product,
        cdpUrl: launched.cdpUrl,
        profileDir: config.profileDir,
        connection: 'CDP',
        verifiedGoogleChrome: config.engine === 'GOOGLE_CHROME' && verified,
      },
      launched,
      createdAt: now,
      lastUsedAt: now,
      closing: false,
      dead: false,
      tabs: new Map(),
    };
  } catch (error) {
    // A browser that started but could not be attached to is left running
    // rather than killed: a person may already be typing in it, and a stray
    // window is a smaller problem than a lost sign-in.
    if (error instanceof PipelineError) throw error;
    throw explainCdpFailure(error, launched.cdpUrl);
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
 * Leases one role-bound tab for one operation.
 *
 * Contexts stay warm per account and are recycled when stale, which is what the
 * legacy system achieved with a manual CDP-reconnect timer, except owned by the
 * application. What is new is the role: the caller says whether it is acting,
 * looking for mentions, or reading notifications, and gets the tab that belongs
 * to that job. Operations on different roles run at the same time; operations
 * on the same role queue behind each other.
 *
 * The default is ACTION because a caller that has not thought about roles is
 * doing something to the account, and that is the tab it is safe to disturb.
 */
export async function leaseSession(config: SessionConfig, role: TabRole = 'ACTION'): Promise<LeasedSession> {
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
    entry = await openOnce(config);
    // A concurrent caller may have won the race and cached its own entry while
    // this one was waiting; keeping the first avoids two live contexts.
    const existing = contexts.get(config.accountId);
    if (existing && existing !== entry && !existing.dead) {
      entry = existing;
    } else {
      watchForClose(config.accountId, entry);
      contexts.set(config.accountId, entry);
      log.info('browser context opened', { accountId: config.accountId, mode: entry.mode });
    }
  }

  let tab;
  try {
    tab = await acquireTab(entry.context, entry.tabs, role);
  } catch (error) {
    // The context died between the check above and here, which is exactly what
    // happens when somebody closes the window at the wrong moment. Reopen once
    // rather than making the account unusable until the process restarts.
    log.info('reopening a browser context that had gone away', { accountId: config.accountId, role });
    await closeSession(config.accountId);
    entry = await openOnce(config);
    watchForClose(config.accountId, entry);
    contexts.set(config.accountId, entry);
    try {
      tab = await acquireTab(entry.context, entry.tabs, role);
    } catch (secondError) {
      throw explainLaunchFailure(secondError, config);
    }
    void error;
  }

  // Held until release(). Different roles never wait on each other; this is the
  // only thing stopping two operations sharing one tab and interleaving their
  // navigations.
  const unlock = await lockTab(tab);

  // Re-assert the role tag now that nothing else is driving the page. A tab
  // that navigated off x.com and back lost it, and an untagged tab is one a
  // restarted worker would abandon and replace.
  await retagIfLost(tab.page, role);

  const context = entry.context;
  const page = tab.page;
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  const current = entry;
  let released = false;
  return {
    context,
    page,
    role,
    identity: current.identity,
    mode: current.mode,
    async release() {
      if (released) return;
      released = true;
      current.lastUsedAt = Date.now();
      tab.lastError = null;
      unlock();
    },
    async releaseFailed(message: string) {
      if (released) return;
      released = true;
      current.lastUsedAt = Date.now();
      // Recorded on the tab rather than on the account, so a monitor that keeps
      // failing shows up as one unhealthy surface instead of an unhealthy
      // account with two working monitors.
      tab.lastError = message.slice(0, 300);
      unlock();
    },
  };
}

/**
 * What each of an account's three tabs is doing.
 *
 * Reads the live cache and never opens anything, so asking is always safe.
 */
export function sessionTabs(accountId: string): TabHealth[] {
  const entry = contexts.get(accountId);
  return entry ? tabHealth(entry.tabs) : tabHealth(new Map());
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

/**
 * Whether a stored profile path makes sense on this machine.
 *
 * The path is written by whichever worker last touched the account, and the
 * containerised worker and the native one do not share a filesystem. A Linux
 * path handed to Chrome on Windows produces C:\app\... — a second, empty
 * profile, and a session that silently is not there.
 */
export function profilePathIsLocal(profileDir: string | null | undefined): boolean {
  if (!profileDir) return false;
  const looksPosixAbsolute = profileDir.startsWith('/');
  const looksWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(profileDir);
  return process.platform === 'win32' ? !looksPosixAbsolute : !looksWindowsAbsolute || looksPosixAbsolute;
}

/**
 * Where this account's profile lives on this machine.
 *
 * Derived from the account id rather than read from the row, because the id is
 * the identity and the path is a local detail. The stored path is kept for
 * diagnostics only.
 */
export function resolveProfileDir(accountId: string, stored: string | null | undefined): string {
  return profilePathIsLocal(stored) ? (stored as string) : defaultProfileDir(accountId);
}

/**
 * The name of this installation, for anything two of them could collide over.
 *
 * Two checkouts already have separate `./storage` directories, so the default
 * needs nothing. It matters when somebody points several installations at one
 * absolute path -- a shared drive, a big disk, a deliberate layout -- because
 * two Chromes on one profile directory is the one thing the profile lock
 * cannot save you from: the lock is per account id, and the same account id in
 * two databases is two different accounts that happen to look alike.
 */
export function instanceName(): string {
  // Dots go too, not only slashes. A name is a label, and a label with dots in
  // it is one `resolve` away from being a path.
  const cleaned = (process.env.AI17Z_INSTANCE || 'default').trim().replace(/[^A-Za-z0-9_-]/g, '-');
  return cleaned || 'default';
}

export function defaultProfileDir(accountId: string): string {
  const base = process.env.XBAM_BROWSER_PROFILE_DIR || './storage/browser-profiles';
  // Only named instances get their own subdirectory, so an existing
  // installation keeps the paths its sessions already live in.
  const instance = instanceName();
  return instance === 'default' ? resolve(base, accountId) : resolve(base, instance, accountId);
}

export function activeSessionCount(): number {
  return contexts.size;
}

/** Accounts with a browser open in this process, for the tab-health heartbeat. */
export function activeSessionAccountIds(): string[] {
  return [...contexts.keys()];
}

/**
 * What is currently running for an account, if anything.
 *
 * Read from the live cache rather than re-launching, so asking "what browser is
 * this?" never starts one.
 */
export function sessionIdentity(accountId: string): BrowserIdentity | null {
  return contexts.get(accountId)?.identity ?? null;
}

/**
 * Closes an account's browser, rather than merely letting go of it.
 *
 * `closeSession` detaches: for a CDP-attached browser Playwright drops the
 * connection and Chrome carries on. That is right when somebody else started
 * the browser and wrong when AI17Z did, and "stop this agent" has to mean the
 * window and its process tree actually go away.
 *
 * Which of the two applies is answered by the endpoint file AI17Z writes beside
 * the profile when it spawns Chrome. No file means AI17Z did not start this
 * browser and must not kill it — a custom CDP endpoint belongs to whoever
 * opened it, and closing somebody's own browser would be a genuine harm.
 *
 * Chrome is asked to quit before it is killed, because cookies and local
 * storage are flushed on a clean shutdown and the signed-in session is the
 * whole point of the profile.
 */
export async function shutdownBrowser(
  accountId: string,
  profileDir: string | null,
): Promise<{ closed: boolean; detail: string }> {
  const entry = contexts.get(accountId);
  const identity = entry?.identity ?? null;
  await closeSession(accountId);

  if (!profileDir) {
    return { closed: false, detail: 'Detached from the browser. AI17Z has no profile recorded for this account.' };
  }

  const owned = await existingChrome(profileDir).catch(() => null);
  if (!owned) {
    return {
      closed: false,
      detail: 'Detached. This browser was not started by AI17Z, so it has been left running.',
    };
  }

  const gone = await closeChrome(
    { pid: owned.pid ?? identity?.pid ?? null, cdpUrl: owned.cdpUrl, profileDir },
    25_000,
  );
  log.info('browser shut down', { accountId, cdpUrl: owned.cdpUrl, pid: owned.pid, gone });

  return gone
    ? { closed: true, detail: 'Browser closed. The signed-in session is kept in the profile on disk.' }
    : {
        closed: false,
        detail: `Asked the browser at ${owned.cdpUrl} to close and it is still answering. It may need closing by hand.`,
      };
}
