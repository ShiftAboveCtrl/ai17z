import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  /**
   * The spawned process, when AI17Z started it. Null when it attached to a
   * Chrome that was already open, which it does not own and must not kill.
   */
  process: ChildProcess | null;
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
  launched: { pid: number | null; cdpUrl: string; profileDir?: string | null },
  timeoutMs = 20_000,
): Promise<boolean> {
  // The recorded endpoint is forgotten first, so a launch that races this close
  // cannot attach to a browser on its way out.
  if (launched.profileDir) await forgetEndpoint(launched.profileDir);
  // Ask Chrome to quit first. This matters beyond politeness: cookies and
  // local storage are flushed on a clean shutdown, so force-killing a browser
  // somebody just signed in with can lose the session that was the whole point.
  const graceful = await requestBrowserClose(launched.cdpUrl).catch(() => false);
  if (graceful && (await waitForCdpGone(launched.cdpUrl, Math.min(timeoutMs, 10_000)))) return true;

  if (launched.pid) {
    if (process.platform === 'win32') {
      // /T for the child renderers: killing only the parent leaves the profile
      // locked and the next launch hands off to it instead of starting.
      //
      // Thirty seconds, not ten. A Chrome with twenty-odd renderers on a busy
      // machine takes longer than ten to come down, and a taskkill cut short by
      // its own timeout leaves the browser running while this reports success.
      // The next launch then fails with "the debugging port did not open",
      // which describes a symptom three steps removed from the cause.
      await run('taskkill', ['/PID', String(launched.pid), '/T', '/F'], { timeout: 30_000 }).catch((error) =>
        // Not swallowed. Whether the kill worked decides whether the profile is
        // free, and the caller is about to act on that.
        log.warn('could not force the browser to close', { pid: launched.pid, message: errorMessage(error) }),
      );
    } else {
      try {
        process.kill(launched.pid);
      } catch {
        // Already gone.
      }
    }
  }
  const gone = await waitForCdpGone(launched.cdpUrl, timeoutMs);
  if (!gone) log.warn('the browser is still answering after being told to close', { pid: launched.pid });
  return gone;
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

/**
 * Where a Chrome that AI17Z started recorded its debugging port.
 *
 * Kept beside the profile rather than in the database, because it describes the
 * profile and has to be readable by a process that has only a path. Written on
 * every launch and read on the next one.
 */
function endpointFile(profileDir: string): string {
  return join(profileDir, 'ai17z-cdp.json');
}

/**
 * The Chrome holding this profile, found without a record of it.
 *
 * The record file is written beside the profile and can go missing -- a tidy-up
 * script, a half-finished stop, somebody clearing a directory. When it does, a
 * perfectly healthy signed-in Chrome becomes invisible: the launcher finds no
 * record, starts a second Chrome on the same profile, and Chrome hands off to
 * the running copy and exits without ever opening the new port. Every poll then
 * fails with "the browser did not open its debugging port" while the browser it
 * describes is sitting on screen, signed in and working.
 *
 * A profile directory can only be held by one Chrome at a time, and AI17Z
 * derives that directory from the account id. So the directory *is* the
 * identity, and a browser holding it can be found by asking the operating
 * system which process has it open -- no record required.
 *
 * Returns the port that browser was started with. Everything after this still
 * has to prove the port answers and accepts a connection; this only finds a
 * candidate.
 */
async function chromeHoldingProfile(profileDir: string): Promise<{ port: number; pid: number } | null> {
  const wanted = profileDir.replace(/[/\\]+$/, '').toLowerCase();

  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
            `Where-Object { $_.CommandLine -like '*--remote-debugging-port=*' } | ` +
            `ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
        ],
        // Chrome command lines are enormous and there can be dozens of
        // processes, so the default 1MB buffer is not enough to see them all.
        // Enumerating processes is slow when a lot of Chrome is open.
        { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return firstMatch(stdout, wanted, (line) => line.split('|')[0]);
    }

    const { stdout } = await run('ps', ['-eo', 'pid=,args='], { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 });
    return firstMatch(stdout, wanted, (line) => line.trim().split(/\s+/)[0]);
  } catch {
    // Not being able to ask is the same as not finding one: launch instead.
    return null;
  }
}

function firstMatch(
  stdout: string,
  wantedProfile: string,
  pidOf: (line: string) => string | undefined,
): { port: number; pid: number } | null {
  for (const line of stdout.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!lower.includes(`--user-data-dir=${wantedProfile}`)) continue;
    const port = Number(line.match(/--remote-debugging-port=(\d+)/)?.[1]);
    const pid = Number(pidOf(line));
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid)) continue;
    return { port, pid };
  }
  return null;
}

/**
 * The Chrome already serving this profile, if there is one.
 *
 * Chrome outliving the worker is deliberate — restarting AI17Z must not close a
 * window somebody is signing into. But a restarted worker had no way back to it
 * and would spawn a second Chrome on the same profile, at which point Chrome
 * hands off to the running copy and exits without ever opening the new port. The
 * result was every poll failing with "the browser did not open its debugging
 * port", on an account whose browser was sitting there working.
 *
 * So the port is remembered, and a launch attaches to a live one instead.
 */
export async function existingChrome(profileDir: string): Promise<{ cdpUrl: string; port: number; pid: number | null } | null> {
  let recorded: { cdpUrl?: unknown; port?: unknown; pid?: unknown } = {};
  try {
    recorded = JSON.parse(await readFile(endpointFile(profileDir), 'utf8')) as typeof recorded;
  } catch {
    // No file, or nothing readable in it.
  }

  const cdpUrl = typeof recorded.cdpUrl === 'string' ? recorded.cdpUrl : null;
  if (!cdpUrl) return null;

  // Short timeout on purpose: this is a guess, and a wrong guess must not cost
  // anything. A port nothing answers on means the browser is gone.
  const identity = await cdpIdentity(cdpUrl, 2_500).catch(() => null);
  if (!identity) return null;

  // A browser with hundreds of tabs answers /json/version perfectly well and
  // then times out the CDP handshake, because attaching means attaching to
  // every target. That is not a hypothetical: a single-page predecessor leaked
  // one tab per poll and reached 253, at which point the account looked broken
  // for a reason nothing reported. Refusing here says what is actually wrong.
  const recordedPid = typeof recorded.pid === 'number' ? recorded.pid : null;

  const pages = await countPages(cdpUrl);
  if (pages > MAX_ATTACHABLE_PAGES) {
    log.warn('the open Chrome has too many tabs to attach to; replacing it', { cdpUrl, pages });
    await replaceUnusable(cdpUrl, recordedPid, profileDir);
    return null;
  }

  // Answering /json/version is not the same as accepting a connection. A Chrome
  // that has been up for days reaches a state where the HTTP endpoint replies
  // instantly and the CDP handshake never completes, which stranded a live
  // account behind a browser that looked perfectly healthy from outside.
  //
  // So the probe is the thing that will actually be done. It costs one short
  // connect on a path that would otherwise wait twenty seconds and fail.
  if (!(await canAttach(cdpUrl))) {
    log.warn('the open Chrome is not accepting connections; replacing it', { cdpUrl, pid: recordedPid });
    await replaceUnusable(cdpUrl, recordedPid, profileDir);
    return null;
  }

  return {
    cdpUrl,
    port: typeof recorded.port === 'number' ? recorded.port : 0,
    pid: typeof recorded.pid === 'number' ? recorded.pid : null,
  };
}

/**
 * Beyond this many open tabs, `connectOverCDP` reliably exceeds its timeout.
 * The runtime keeps three, so anything near this is a leak, not a workload.
 */
const MAX_ATTACHABLE_PAGES = 40;

/**
 * Whether a real CDP session can be opened, which is the only useful question.
 *
 * Short timeout on purpose: this is a health check on a browser AI17Z is about
 * to replace if the answer is no, and a slow no costs the same as a fast one
 * except in patience.
 */
async function canAttach(cdpUrl: string, timeoutMs = 6_000): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
    await browser.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** How many pages a browser has, without opening a CDP session to find out. */
async function countPages(cdpUrl: string): Promise<number> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/list`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return 0;
    const targets = (await response.json()) as { type?: string }[];
    return targets.filter((t) => t.type === 'page').length;
  } catch {
    // Not being able to count is not a reason to refuse; the attach itself will
    // report whatever is actually wrong.
    return 0;
  }
}

/**
 * Closes a browser that cannot be used, so a fresh one can have the profile.
 *
 * Returning null is not enough on its own: the unusable Chrome still holds the
 * profile, and the next launch would hand off to it and exit without ever
 * opening a port. That is the failure this whole path exists to avoid.
 *
 * Only ever called for a browser AI17Z started, which is what the endpoint file
 * records. Closed gracefully first, so the signed-in session is flushed to disk
 * and comes back with the replacement.
 */
async function replaceUnusable(cdpUrl: string, pid: number | null, profileDir: string): Promise<boolean> {
  const closed = await closeChrome({ pid, cdpUrl, profileDir }, 20_000).catch(() => false);
  await forgetEndpoint(profileDir);
  return closed;
}

/** True when that process is still alive and still holding this profile. */
async function stillHoldingProfile(profileDir: string, pid: number): Promise<boolean> {
  const holder = await chromeHoldingProfile(profileDir);
  return holder?.pid === pid;
}

/** Forgets the recorded endpoint, after closing the browser it described. */
export async function forgetEndpoint(profileDir: string): Promise<void> {
  await rm(endpointFile(profileDir), { force: true }).catch(() => undefined);
}

export async function launchChrome(input: {
  engine: BrowserEngine;
  profileDir: string;
  /** Opened immediately, so the window lands somewhere useful. */
  startUrl?: string | null;
  headless?: boolean;
  /**
   * Internal. Set once when a launch has already failed to a Chrome holding the
   * profile, so recovery is attempted exactly once and cannot loop.
   */
  afterRecovery?: boolean;
}): Promise<LaunchedChrome> {
  const installation = await findBrowser(input.engine);
  await mkdir(input.profileDir, { recursive: true });

  // A Chrome this account already has open is the one to use. Spawning a second
  // on the same profile does not produce a second browser; it produces a failed
  // launch and an account that looks broken.
  const alive = await existingChrome(input.profileDir);
  if (alive) {
    log.info('attaching to the Chrome already open for this profile', {
      cdpUrl: alive.cdpUrl,
      pid: alive.pid,
      profileDir: input.profileDir,
    });
    return {
      installation,
      cdpUrl: alive.cdpUrl,
      port: alive.port,
      pid: alive.pid,
      profileDir: input.profileDir,
      process: null,
    };
  }

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
  try {
    await waitForCdp(cdpUrl, 30_000);
  } catch (error) {
    // The port never opened. By far the most common reason is that a Chrome is
    // already holding this profile: Chrome hands the arguments to the running
    // copy and exits, so the new port belongs to a process that is gone.
    //
    // Asking the operating system which process holds the profile is slow --
    // enumerating processes takes tens of seconds on a machine with a lot of
    // Chrome open -- so it is not worth doing before every launch. Here it is:
    // thirty seconds have already been spent failing, and the alternative is an
    // account that stays broken while its browser sits there signed in.
    if (input.afterRecovery) throw error;

    const holder = await chromeHoldingProfile(input.profileDir);
    if (!holder) throw error;

    const recovered = `http://127.0.0.1:${holder.port}`;
    log.warn('the profile was already held by a running Chrome', {
      wanted: cdpUrl,
      found: recovered,
      pid: holder.pid,
    });

    // Recorded, then handed to `existingChrome`, which is where the judgement
    // about whether a browser is actually usable already lives: too many tabs
    // to attach to, or answering /json/version while never completing a
    // handshake. Writing the record and returning it here would skip all of
    // that and hand back a browser nothing can drive.
    await writeFile(
      endpointFile(input.profileDir),
      JSON.stringify(
        { cdpUrl: recovered, port: holder.port, pid: holder.pid, startedAt: new Date().toISOString(), recovered: true },
        null,
        2,
      ),
      'utf8',
    ).catch(() => undefined);

    const usable = await existingChrome(input.profileDir);
    if (usable) {
      return {
        installation,
        cdpUrl: usable.cdpUrl,
        port: usable.port,
        pid: usable.pid,
        profileDir: input.profileDir,
        process: child,
      };
    }

    // `existingChrome` found it unusable and tried to close it. If it is still
    // there the profile is still locked, and relaunching would fail again with
    // a message about a port, three steps removed from the cause. Say what is
    // actually wrong and name the process, so somebody can end it.
    if (await stillHoldingProfile(input.profileDir, holder.pid)) {
      throw PipelineError.review(
        'profile_locked',
        `A Chrome (pid ${holder.pid}) is holding this account's profile and will not close, so a new one cannot ` +
          `start: Chrome hands its arguments to the running copy and exits. Close that window, or end process ` +
          `${holder.pid} and its children, then connect again.`,
        { pid: holder.pid, cdpUrl: recovered, profileDir: input.profileDir },
      );
    }

    log.warn('the Chrome holding the profile could not be driven; launching a fresh one', { found: recovered });
    return launchChrome({ ...input, afterRecovery: true });
  }

  // Written only once the port is answering, so the file never points at a
  // browser that failed to start.
  await writeFile(
    endpointFile(input.profileDir),
    JSON.stringify({ cdpUrl, port, pid: child.pid ?? null, startedAt: new Date().toISOString() }, null, 2),
    'utf8',
  ).catch((error) => log.warn('could not record the debugging port', { message: errorMessage(error) }));

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
