import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PipelineError, createLogger, errorMessage } from '@xbam/shared';

const run = promisify(execFile);
const log = createLogger('chrome');

/**
 * Finding, starting and identifying the real Google Chrome.
 *
 * The distinction this file exists to enforce: Playwright's `chromium` API can
 * drive several browsers, and the fact that code says `chromium.connectOverCDP`
 * says nothing about which binary is running. AI17Z picks the executable
 * itself, records the path, and verifies afterwards what it actually got.
 *
 * There is no fallback. If Google Chrome was asked for and is not there, that
 * is an error with instructions, never a quiet substitution of Chromium.
 */

import type { BrowserEngine } from './types';

export interface ChromeInstallation {
  executable: string;
  /** "Google Chrome" as the binary reports itself. */
  product: string;
  version: string;
  /** Where it was found, for diagnostics. */
  source: string;
}

/**
 * Where Chrome installs itself on Windows, in the order worth trying.
 *
 * Per-machine installs come first because they are what a normal install
 * produces; the per-user location is the fallback for installs without admin
 * rights. Never only one path.
 */
function windowsCandidates(): { path: string; source: string }[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';

  return [
    { path: join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'), source: 'Program Files' },
    { path: join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'), source: 'Program Files (x86)' },
    ...(localAppData
      ? [{ path: join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'), source: 'per-user install' }]
      : []),
  ];
}

function windowsEdgeCandidates(): { path: string; source: string }[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return [
    { path: join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'), source: 'Program Files (x86)' },
    { path: join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'), source: 'Program Files' },
  ];
}

function posixCandidates(engine: BrowserEngine): { path: string; source: string }[] {
  if (engine === 'MICROSOFT_EDGE') {
    return [
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', source: 'Applications' },
      { path: '/usr/bin/microsoft-edge', source: 'usr/bin' },
    ];
  }
  return [
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', source: 'Applications' },
    { path: '/usr/bin/google-chrome', source: 'usr/bin' },
    { path: '/usr/bin/google-chrome-stable', source: 'usr/bin' },
    { path: '/opt/google/chrome/chrome', source: 'opt' },
  ];
}

/** Asks Windows where it thinks Chrome is, for installs in unusual places. */
async function fromWindowsRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', '/ve'],
      { timeout: 5_000 },
    );
    const match = stdout.match(/REG_SZ\s+(.+chrome\.exe)/i);
    const path = match?.[1]?.trim();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Reads the product name and version out of the binary itself. */
async function identify(executable: string): Promise<{ product: string; version: string } | null> {
  if (process.platform === 'win32') {
    try {
      // The binary is the authority on what it is. A path containing "Chrome"
      // proves nothing; the version resource does.
      const { stdout } = await run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$i = (Get-Item -LiteralPath '${executable.replace(/'/g, "''")}').VersionInfo; ` +
            `Write-Output ($i.ProductName + '|' + $i.ProductVersion)`,
        ],
        { timeout: 10_000 },
      );
      const [product, version] = stdout.trim().split('|');
      if (product && version) return { product: product.trim(), version: version.trim() };
    } catch {
      // Fall through to asking the binary directly.
    }
  }

  try {
    const { stdout } = await run(executable, ['--version'], { timeout: 10_000 });
    const text = stdout.trim();
    const version = text.match(/([\d.]+)\s*$/)?.[1] ?? text;
    return { product: text.replace(/[\d.]+\s*$/, '').trim() || 'Chromium-family', version };
  } catch {
    return null;
  }
}

/** True when what was found really is Google Chrome rather than something else. */
function isGoogleChrome(product: string, executable: string): boolean {
  const p = product.toLowerCase();
  if (p.includes('chromium') && !p.includes('google chrome')) return false;
  return p.includes('google chrome') || /[\\/]google[\\/]chrome[\\/]/i.test(executable);
}

/**
 * Finds the requested browser, or explains why it could not.
 *
 * Never returns a different engine than the one asked for.
 */
export async function findBrowser(engine: BrowserEngine): Promise<ChromeInstallation> {
  if (engine === 'PLAYWRIGHT_CHROMIUM' || engine === 'CUSTOM_CDP') {
    throw new Error(`findBrowser is for real installs; ${engine} is resolved elsewhere.`);
  }

  const override = process.env.AI17Z_CHROME_PATH?.trim();
  const candidates =
    process.platform === 'win32'
      ? engine === 'MICROSOFT_EDGE'
        ? windowsEdgeCandidates()
        : windowsCandidates()
      : posixCandidates(engine);

  const registry = engine === 'GOOGLE_CHROME' ? await fromWindowsRegistry() : null;
  const ordered = [
    ...(override ? [{ path: override, source: 'AI17Z_CHROME_PATH' }] : []),
    ...(registry ? [{ path: registry, source: 'Windows registry' }] : []),
    ...candidates,
  ];

  const looked: string[] = [];
  for (const candidate of ordered) {
    looked.push(candidate.path);
    if (!existsSync(candidate.path)) continue;

    const identity = await identify(candidate.path);
    if (!identity) continue;

    if (engine === 'GOOGLE_CHROME' && !isGoogleChrome(identity.product, candidate.path)) {
      // Found something at a Chrome-shaped path that is not Chrome. Keep
      // looking rather than accepting it, because the whole point of this mode
      // is knowing what is running.
      log.warn('skipping a binary that is not Google Chrome', {
        path: candidate.path,
        product: identity.product,
      });
      continue;
    }

    return {
      executable: candidate.path,
      product: identity.product,
      version: identity.version,
      source: candidate.source,
    };
  }

  const name = engine === 'MICROSOFT_EDGE' ? 'Microsoft Edge' : 'Google Chrome';
  throw PipelineError.permanent(
    'browser_not_installed',
    `${name} could not be found. AI17Z did not fall back to Chromium. ` +
      `Looked in: ${looked.join('; ')}. ` +
      `Set AI17Z_CHROME_PATH to the executable if it is installed somewhere else, ` +
      `or choose the Playwright Chromium engine deliberately.`,
    { engine, looked },
  );
}

/** Finds a free loopback port. One Chrome per account means one port each. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    // Port 0 lets the OS choose one that is genuinely free, which beats
    // probing a fixed range and racing whatever else is starting up.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not find a free port.'))));
    });
  });
}

export interface LaunchedChrome {
  installation: ChromeInstallation;
  cdpUrl: string;
  port: number;
  pid: number | null;
  profileDir: string;
  process: ChildProcess;
}

/**
 * Starts real Chrome with remote debugging, the way the legacy system did.
 *
 * The flag set is AI4YI's, which is the one refinement it made over AI4CZ:
 * loopback-only debugging, and no first-run or default-browser prompts landing
 * on top of the page being driven.
 *
 * Detached on purpose. Chrome outliving the worker is the property that lets a
 * person finish signing in while the worker restarts underneath them, and it is
 * how the legacy system behaved when a script was stopped and started again.
 */
/**
 * Stops a Chrome that AI17Z started, and waits until the profile is free.
 *
 * Two things make this less obvious than it looks. On Windows the process that
 * was spawned is not the whole browser — renderers are children, and killing
 * only the parent leaves the profile locked. And the pid is the wrong thing to
 * wait on anyway: what matters is whether the debugging port has stopped
 * answering, because that is what says the profile lock has been released.
 *
 * Starting a second Chrome against a locked profile does not fail loudly. The
 * new process hands off to the running copy and exits, so no port ever opens
 * and the error is about a missing port rather than a held lock.
 */
export async function closeChrome(
  launched: { pid: number | null; cdpUrl: string },
  timeoutMs = 20_000,
): Promise<boolean> {
  // Ask Chrome to quit first. This matters beyond politeness: cookies and
  // local storage are flushed on a clean shutdown, so force-killing a browser
  // somebody just signed in with can lose the session that was the whole point.
  const graceful = await requestBrowserClose(launched.cdpUrl).catch(() => false);
  if (graceful && (await waitForCdpGone(launched.cdpUrl, Math.min(timeoutMs, 10_000)))) return true;

  if (launched.pid) {
    if (process.platform === 'win32') {
      // /T for the child renderers: killing only the parent leaves the profile
      // locked and the next launch hands off to it instead of starting.
      await run('taskkill', ['/PID', String(launched.pid), '/T', '/F'], { timeout: 10_000 }).catch(() => undefined);
    } else {
      try {
        process.kill(launched.pid);
      } catch {
        // Already gone.
      }
    }
  }
  return waitForCdpGone(launched.cdpUrl, timeoutMs);
}

/** Sends the CDP command that asks the browser to shut down cleanly. */
async function requestBrowserClose(cdpUrl: string): Promise<boolean> {
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 8_000 });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    const session = await context.newCDPSession(page);
    await session.send('Browser.close');
    return true;
  } catch {
    return false;
  } finally {
    // The connection is already going away with the browser; failing to close
    // it cleanly is not worth reporting.
    await browser.close().catch(() => undefined);
  }
}

/** Waits until the debugging port stops answering, which frees the profile. */
export async function waitForCdpGone(cdpUrl: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await cdpIdentity(cdpUrl, 1_500);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function launchChrome(input: {
  engine: BrowserEngine;
  profileDir: string;
  /** Opened immediately, so the window lands somewhere useful. */
  startUrl?: string | null;
  headless?: boolean;
}): Promise<LaunchedChrome> {
  const installation = await findBrowser(input.engine);
  await mkdir(input.profileDir, { recursive: true });
  const port = await freePort();

  const args = [
    `--remote-debugging-port=${port}`,
    // Loopback only. Without this the debug port can be reachable from the
    // network, and anything that reaches it drives a signed-in browser.
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${input.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(input.headless ? ['--headless=new'] : ['--start-maximized']),
    ...(input.startUrl ? [input.startUrl] : []),
  ];

  log.info('starting Chrome', {
    executable: installation.executable,
    product: installation.product,
    version: installation.version,
    port,
    profileDir: input.profileDir,
  });

  const child = spawn(installation.executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  const cdpUrl = `http://127.0.0.1:${port}`;
  await waitForCdp(cdpUrl, 30_000);

  return {
    installation,
    cdpUrl,
    port,
    pid: child.pid ?? null,
    profileDir: input.profileDir,
    process: child,
  };
}

export interface CdpIdentity {
  /** What the running browser calls itself: "Chrome/151.0.7922.175". */
  product: string;
  revision: string;
  userAgent: string;
  webSocketDebuggerUrl: string | null;
}

/**
 * Asks the running browser what it is, over CDP.
 *
 * The second of two independent signals. The first is the executable AI17Z
 * chose; this is what actually answered on the port, and a diagnostic that
 * shows both is one nobody has to take on trust.
 */
export async function cdpIdentity(cdpUrl: string, timeoutMs = 10_000): Promise<CdpIdentity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, string>;
    return {
      product: body.Browser ?? 'unknown',
      revision: body['WebKit-Version'] ?? '',
      userAgent: body['User-Agent'] ?? '',
      webSocketDebuggerUrl: body.webSocketDebuggerUrl ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits for the debug port to answer.
 *
 * The legacy scraper did this as a fatal pre-flight before connecting, because
 * `connectOverCDP` against a port that is not up yet fails in a way that reads
 * like a broken browser rather than one that is still starting.
 */
export async function waitForCdp(cdpUrl: string, timeoutMs = 30_000): Promise<CdpIdentity> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      return await cdpIdentity(cdpUrl, 3_000);
    } catch (error) {
      last = errorMessage(error);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw PipelineError.retryable(
    'cdp_not_ready',
    `The browser did not open its debugging port within ${Math.round(timeoutMs / 1000)}s (${cdpUrl}). ` +
      'The usual cause is the profile still being held by a previous instance: Chrome hands off to the running ' +
      'copy and exits rather than opening a second port. Close any window using this profile and try again. ' +
      `Last error: ${last}`,
  );
}

/** True when the browser on this endpoint reports itself as Google Chrome. */
export function cdpIsGoogleChrome(identity: CdpIdentity): boolean {
  const product = identity.product.toLowerCase();
  // Chrome reports "Chrome/151.0.0.0"; headless shell and Chromium report
  // "HeadlessChrome/..." and "Chromium/...". Only the first is Google Chrome.
  return product.startsWith('chrome/');
}
