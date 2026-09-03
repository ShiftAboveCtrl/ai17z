import { access, constants, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createLogger, errorMessage } from '@xbam/shared';
import type { BrowserChannel } from './types';
import { SHARED_CHROME_ARGS } from './chrome';
import { browserEnabled, defaultProfileDir } from './session';

const run = promisify(execFile);
const log = createLogger('browser-preflight');

export interface PreflightCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  platform: string;
  playwrightVersion: string | null;
  checks: PreflightCheck[];
  /** Channels that would actually launch right now. */
  availableChannels: BrowserChannel[];
}

/** Where each real browser usually lives, per platform. */
const CHROME_PATHS: Record<string, string[]> = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
};

const EDGE_PATHS: Record<string, string[]> = {
  win32: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
};

export function findInstalledBrowser(kind: 'chrome' | 'msedge'): string | null {
  const table = kind === 'chrome' ? CHROME_PATHS : EDGE_PATHS;
  for (const candidate of table[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function browserVersion(executable: string): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      // Chrome on Windows does not print --version to stdout reliably, so the
      // file version is read from the shell instead.
      const { stdout } = await run(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Item '${executable}').VersionInfo.ProductVersion`],
        { timeout: 10_000 },
      );
      return stdout.trim() || null;
    }
    const { stdout } = await run(executable, ['--version'], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Verifies the browser runtime before anything tries to use it.
 *
 * The failure this exists to prevent: an owner clicks Connect, waits, and gets a
 * missing-file path that never mentions a version mismatch. Every problem below
 * is reported by name with the action that fixes it.
 */
export async function runBrowserPreflight(): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const availableChannels: BrowserChannel[] = [];
  let playwrightVersion: string | null = null;

  if (!browserEnabled()) {
    checks.push({
      name: 'Browser automation',
      status: 'warn',
      detail: 'Disabled by configuration (AI17Z_BROWSER_ENABLED=0). Browser channels will decline work.',
    });
    return { ok: false, platform: process.platform, playwrightVersion: null, checks, availableChannels };
  }

  // Playwright itself
  let chromium: typeof import('playwright').chromium | null = null;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
    const pkg = await import('playwright/package.json', { with: { type: 'json' } }).catch(() => null);
    playwrightVersion = (pkg as { default?: { version?: string } } | null)?.default?.version ?? null;
    checks.push({
      name: 'Playwright',
      status: 'ok',
      detail: playwrightVersion ? `version ${playwrightVersion}` : 'installed',
    });
  } catch (error) {
    checks.push({
      name: 'Playwright',
      status: 'fail',
      detail: `Not installed here: ${errorMessage(error)}. Run: npx playwright install chromium`,
    });
    return { ok: false, platform: process.platform, playwrightVersion, checks, availableChannels };
  }

  // Bundled Chromium
  try {
    const executable = chromium.executablePath();
    if (existsSync(executable)) {
      checks.push({ name: 'Playwright Chromium', status: 'ok', detail: executable });
      availableChannels.push('chromium');
    } else {
      checks.push({
        name: 'Playwright Chromium',
        status: 'fail',
        detail: `Expected at ${executable} but it is not there. If this is a container, its image ships binaries for a different Playwright release: rebuild it against v${playwrightVersion ?? 'the installed version'}. Otherwise run: npx playwright install chromium`,
      });
    }
  } catch (error) {
    checks.push({ name: 'Playwright Chromium', status: 'fail', detail: errorMessage(error) });
  }

  // Real browsers
  for (const kind of ['chrome', 'msedge'] as const) {
    const label = kind === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    const executable = findInstalledBrowser(kind);
    if (!executable) {
      checks.push({
        name: label,
        status: 'warn',
        detail: `Not installed where this worker runs (${process.platform}). Accounts set to drive it will fail here.`,
      });
      continue;
    }
    const version = await browserVersion(executable);
    checks.push({ name: label, status: 'ok', detail: version ? `${version} at ${executable}` : executable });
    availableChannels.push(kind);
  }

  // Profile directory
  const probeDir = resolve(defaultProfileDir('preflight-probe'));
  try {
    await mkdir(probeDir, { recursive: true });
    await access(probeDir, constants.W_OK);
    checks.push({ name: 'Profile directory', status: 'ok', detail: `writable: ${resolve(probeDir, '..')}` });
    await rm(probeDir, { recursive: true, force: true });
  } catch (error) {
    checks.push({
      name: 'Profile directory',
      status: 'fail',
      detail: `Not writable: ${errorMessage(error)}. Browser profiles cannot persist, so sessions will not survive a restart.`,
    });
  }

  // Can a context actually open? This is the check that catches everything else.
  if (availableChannels.length > 0) {
    const launchDir = resolve(defaultProfileDir('preflight-launch'));
    try {
      await mkdir(launchDir, { recursive: true });
      const context = await chromium.launchPersistentContext(launchDir, {
        headless: true,
        args: [...SHARED_CHROME_ARGS],
      });
      await context.close();
      checks.push({ name: 'Browser launch', status: 'ok', detail: 'A browser context opened and closed cleanly.' });
    } catch (error) {
      checks.push({
        name: 'Browser launch',
        status: 'fail',
        detail: `A browser could not be started: ${errorMessage(error)}`,
      });
    } finally {
      await rm(launchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const ok = checks.every((c) => c.status !== 'fail');
  log.info('browser preflight complete', { ok, channels: availableChannels });
  return { ok, platform: process.platform, playwrightVersion, checks, availableChannels };
}
