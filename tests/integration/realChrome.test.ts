import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cdpIdentity,
  cdpIsGoogleChrome,
  closeChrome,
  closeSession,
  existingChrome,
  findBrowser,
  launchChrome,
  leaseSession,
  sessionTabs,
  profilePathIsLocal,
  resolveProfileDir,
} from '@xbam/browser';

/**
 * Proof that AI17Z drives real Google Chrome, not the bundled Chromium.
 *
 * This is deliberately a separate file from every other browser test. The rest
 * of the suite uses Playwright's Chromium for generic DOM work, which is fine
 * and says nothing about Chrome support. Only this file may be cited as
 * evidence that real Chrome works.
 *
 * Skips itself where Chrome is not installed rather than failing, and says so:
 * a skip is not a pass, and CI on Linux should not be able to claim one.
 */

let chromeAvailable = false;
let installation: Awaited<ReturnType<typeof findBrowser>> | null = null;
const started: { pid: number | null }[] = [];
let profileRoot = '';

beforeAll(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'ai17z-chrome-test-'));
  try {
    installation = await findBrowser('GOOGLE_CHROME');
    chromeAvailable = true;
  } catch {
    chromeAvailable = false;
  }
});

afterAll(async () => {
  // Everything launched here is detached, so it has to be cleaned up by pid.
  for (const proc of started) {
    if (proc.pid) {
      try {
        process.kill(proc.pid);
      } catch {
        // Already gone. Nothing to do, and nothing worth failing a test over.
      }
    }
  }
  if (profileRoot) await rm(profileRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('finding real Google Chrome', () => {
  it('locates an installation and reads its identity from the binary', () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }
    expect(installation!.executable).toMatch(/chrome(\.exe)?$/i);
    expect(existsSync(installation!.executable)).toBe(true);
    // The path proves nothing; the version resource is the authority.
    expect(installation!.product.toLowerCase()).toContain('chrome');
    expect(installation!.product.toLowerCase()).not.toBe('chromium');
    expect(installation!.version).toMatch(/^\d+\./);
  });

  it('never resolves to a Playwright-managed binary', () => {
    if (!chromeAvailable) return;
    // The exact failure this whole change exists to prevent.
    expect(installation!.executable).not.toMatch(/ms-playwright/i);
    expect(installation!.executable).not.toMatch(/playwright/i);
  });
});

describe('no silent fallback to Chromium', () => {
  it('fails explicitly when the requested Chrome does not exist', async () => {
    const originalPath = process.env.AI17Z_CHROME_PATH;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    // Pretend to be a machine with no Chrome. Reported as linux rather than
    // win32 on purpose: the Windows path consults the registry, which finds a
    // real installation regardless of what the environment variables say, so
    // forcing win32 here tests nothing. The posix candidates are absolute
    // paths that do not exist on this machine, which is the state under test.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.AI17Z_CHROME_PATH = join(profileRoot, 'nowhere', 'chrome');

    try {
      await expect(findBrowser('GOOGLE_CHROME')).rejects.toThrow(/could not be found/i);
      await expect(findBrowser('GOOGLE_CHROME')).rejects.toThrow(/did not fall back to Chromium/i);
      // The message has to tell somebody what to do next, not just that it failed.
      await expect(findBrowser('GOOGLE_CHROME')).rejects.toThrow(/AI17Z_CHROME_PATH/);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (originalPath === undefined) delete process.env.AI17Z_CHROME_PATH;
      else process.env.AI17Z_CHROME_PATH = originalPath;
    }
  });

  it('refuses to resolve an engine that is not a real install', async () => {
    await expect(findBrowser('PLAYWRIGHT_CHROMIUM')).rejects.toThrow();
    await expect(findBrowser('CUSTOM_CDP')).rejects.toThrow();
  });
});

describe('launching real Chrome and proving what it is', () => {
  it('starts it, attaches over CDP, and both signals agree', async () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }

    const profileDir = join(profileRoot, 'identity');
    const launched = await launchChrome({
      engine: 'GOOGLE_CHROME',
      profileDir,
      // A local file rather than a website: this test proves the browser, and
      // reaching the network is somebody else's problem.
      startUrl: null,
      headless: true,
    });
    started.push({ pid: launched.pid });

    // Signal one: the executable AI17Z chose.
    expect(launched.installation.executable).toMatch(/chrome(\.exe)?$/i);
    expect(launched.installation.executable).not.toMatch(/ms-playwright/i);
    expect(launched.installation.product.toLowerCase()).toContain('chrome');

    // Signal two: what actually answered on the port.
    const seen = await cdpIdentity(launched.cdpUrl);
    expect(seen.product).toMatch(/^(Headless)?Chrome\//);
    expect(seen.product).not.toMatch(/^Chromium\//);

    // Together, and only together, they are proof.
    expect(cdpIsGoogleChrome(seen) || seen.product.startsWith('HeadlessChrome/')).toBe(true);
    expect(launched.pid).toBeGreaterThan(0);
    expect(launched.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    console.log('REAL CHROME EVIDENCE', {
      engine: 'GOOGLE_CHROME',
      executable: launched.installation.executable,
      product: launched.installation.product,
      version: launched.installation.version,
      pid: launched.pid,
      cdpProduct: seen.product,
      cdpUrl: launched.cdpUrl,
      profile: profileDir,
      bundledChromiumUsed: false,
    });
  }, 90_000);

  it('binds the debugging port to loopback only', async () => {
    if (!chromeAvailable) return;
    const launched = await launchChrome({
      engine: 'GOOGLE_CHROME',
      profileDir: join(profileRoot, 'loopback'),
      startUrl: null,
      headless: true,
    });
    started.push({ pid: launched.pid });
    // AI4YI's one real refinement. A debug port reachable from the network is
    // a signed-in browser anyone can drive.
    expect(launched.cdpUrl.startsWith('http://127.0.0.1:')).toBe(true);
  }, 90_000);

  it('gives each account its own port', async () => {
    if (!chromeAvailable) return;
    const a = await launchChrome({ engine: 'GOOGLE_CHROME', profileDir: join(profileRoot, 'a'), startUrl: null, headless: true });
    started.push({ pid: a.pid });
    const b = await launchChrome({ engine: 'GOOGLE_CHROME', profileDir: join(profileRoot, 'b'), startUrl: null, headless: true });
    started.push({ pid: b.pid });
    // The legacy system hard-coded 9222 and 9223 and told the operator not to
    // reuse them. Allocating instead means two accounts never collide.
    expect(a.port).not.toBe(b.port);
  }, 120_000);
});

describe('the profile persists between launches', () => {
  it('keeps browser state written in one run and read in the next', async () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }

    const profileDir = join(profileRoot, 'persist');
    const { chromium } = await import('playwright');

    // A real http origin, served locally. file:// has its own storage rules and
    // Chrome does not persist localStorage for it, so testing there would
    // measure the wrong thing.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>persist</title><body>ok</body>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const pageUrl = `http://127.0.0.1:${port}/`;

    try {
      const first = await launchChrome({ engine: 'GOOGLE_CHROME', profileDir, startUrl: null, headless: true });
      started.push({ pid: first.pid });
      const browserA = await chromium.connectOverCDP(first.cdpUrl, { timeout: 20_000 });
      const pageA = await (browserA.contexts()[0] ?? (await browserA.newContext())).newPage();
      await pageA.goto(pageUrl);
      await pageA.evaluate("window.localStorage.setItem('ai17z-persist', 'survived')");
      // Closing through CDP lets Chrome shut down properly and flush the
      // profile. Killing the process instead loses exactly what is being tested.
      await browserA.close();
      // Waiting on the port rather than the pid: the spawned process is not the
      // whole browser, and the port going quiet is what says the profile lock
      // has actually been released.
      const freed = await closeChrome(first, 25_000);
      expect(freed).toBe(true);

      const second = await launchChrome({ engine: 'GOOGLE_CHROME', profileDir, startUrl: null, headless: true });
      started.push({ pid: second.pid });
      const browserB = await chromium.connectOverCDP(second.cdpUrl, { timeout: 20_000 });
      const pageB = await (browserB.contexts()[0] ?? (await browserB.newContext())).newPage();
      await pageB.goto(pageUrl);
      const survived = await pageB.evaluate<string | null>("window.localStorage.getItem('ai17z-persist')");
      await browserB.close();

      // The property the whole design rests on: sign in once, and the profile
      // carries the session from then on.
      expect(survived).toBe('survived');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 180_000);
});

describe('a profile path from another machine is not trusted', () => {
  it('rejects a container path on Windows and a Windows path on posix', () => {
    // The containerised worker writes /app/storage/...; the native Windows one
    // cannot use that, and Chrome would silently create C:\app\... instead —
    // a second, empty profile with none of the session in it.
    const posixPath = '/app/storage/browser-profiles/abc';
    const windowsPath = 'C:\Users\someone\storage\browser-profiles\abc';
    const expected = process.platform === 'win32' ? posixPath : windowsPath;
    expect(profilePathIsLocal(expected)).toBe(false);
  });

  it('accepts a path that belongs to this machine', () => {
    const local = process.platform === 'win32' ? 'C:\Users\someone\profiles\abc' : '/home/someone/profiles/abc';
    expect(profilePathIsLocal(local)).toBe(true);
  });

  it('falls back to the account-derived path when the stored one is foreign', () => {
    const foreign = process.platform === 'win32' ? '/app/storage/browser-profiles/abc' : 'C:\app\abc';
    const resolved = resolveProfileDir('abc-123', foreign);
    expect(resolved).not.toBe(foreign);
    expect(resolved).toContain('abc-123');
  });

  it('treats a missing path as foreign rather than using it', () => {
    expect(profilePathIsLocal(null)).toBe(false);
    expect(resolveProfileDir('abc-123', null)).toContain('abc-123');
  });
});

describe('concurrent callers share one browser', () => {
  it('opens a single Chrome when several leases arrive together', async () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }

    const accountId = `concurrent-${Date.now()}`;
    const profileDir = join(profileRoot, 'concurrent');
    const config = {
      accountId,
      engine: 'GOOGLE_CHROME' as const,
      mode: 'CDP' as const,
      profileDir,
      cdpUrl: null,
      headless: true,
    };

    try {
      // Three at once, one per role. Before the launch lock this opened three
      // browsers, two of which could not have the profile. Leasing three
      // different roles rather than the same one three times is deliberate:
      // same-role leases now queue behind each other, which is the point.
      const leases = await Promise.all([
        leaseSession(config, 'ACTION'),
        leaseSession(config, 'MENTIONS'),
        leaseSession(config, 'NOTIFICATIONS'),
      ]);
      const ports = new Set(leases.map((l) => l.identity.cdpUrl));
      expect(ports.size).toBe(1);
      expect(leases[0]!.identity.verifiedGoogleChrome).toBe(true);

      // Three roles means three distinct pages in the one browser.
      const pages = new Set(leases.map((l) => l.page));
      expect(pages.size).toBe(3);
      expect(leases.map((l) => l.role)).toEqual(['ACTION', 'MENTIONS', 'NOTIFICATIONS']);

      for (const lease of leases) await lease.release();
    } finally {
      await closeSession(accountId).catch(() => undefined);
    }
  }, 120_000);

  it('reuses the tab for a role instead of opening another, and reports all three', async () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }

    const accountId = `roles-${Date.now()}`;
    const config = {
      accountId,
      engine: 'GOOGLE_CHROME' as const,
      mode: 'CDP' as const,
      profileDir: join(profileRoot, 'roles'),
      cdpUrl: null,
      headless: true,
    };

    try {
      const first = await leaseSession(config, 'MENTIONS');
      const firstPage = first.page;
      await first.release();

      const second = await leaseSession(config, 'MENTIONS');
      // The same tab, not a fourth one. This is what stops a poller opening a
      // notifications tab every tick until the browser has seventeen of them.
      expect(second.page).toBe(firstPage);
      await second.release();

      await (await leaseSession(config, 'ACTION')).release();
      await (await leaseSession(config, 'NOTIFICATIONS')).release();

      const health = sessionTabs(accountId);
      expect(health.map((t) => t.role)).toEqual(['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH']);
      // Research is reported alongside the others but is only opened when
      // something actually needs looking up, so it is missing here.
      expect(health.filter((t) => t.role !== 'RESEARCH').every((t) => t.state === 'READY')).toBe(true);
      expect(health.find((t) => t.role === 'RESEARCH')?.state).toBe('MISSING');
    } finally {
      await closeSession(accountId).catch(() => undefined);
    }
  }, 120_000);

  it('recreates one tab without disturbing the others', async () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }

    const accountId = `recover-${Date.now()}`;
    const config = {
      accountId,
      engine: 'GOOGLE_CHROME' as const,
      mode: 'CDP' as const,
      profileDir: join(profileRoot, 'recover'),
      cdpUrl: null,
      headless: true,
    };

    try {
      const action = await leaseSession(config, 'ACTION');
      const actionPage = action.page;
      await action.release();

      const mentions = await leaseSession(config, 'MENTIONS');
      const closedPage = mentions.page;
      await mentions.release();

      // Somebody closes the mentions tab. The account must keep working.
      await closedPage.close();
      expect(sessionTabs(accountId).find((t) => t.role === 'MENTIONS')?.state).toBe('MISSING');

      const reopened = await leaseSession(config, 'MENTIONS');
      expect(reopened.page).not.toBe(closedPage);
      expect(reopened.page.isClosed()).toBe(false);
      await reopened.release();

      // The action tab was never touched.
      const again = await leaseSession(config, 'ACTION');
      expect(again.page).toBe(actionPage);
      await again.release();
    } finally {
      await closeSession(accountId).catch(() => undefined);
    }
  }, 120_000);

  it('serialises two operations on the same tab', async () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }

    const accountId = `serial-${Date.now()}`;
    const config = {
      accountId,
      engine: 'GOOGLE_CHROME' as const,
      mode: 'CDP' as const,
      profileDir: join(profileRoot, 'serial'),
      cdpUrl: null,
      headless: true,
    };

    try {
      const order: string[] = [];
      const first = await leaseSession(config, 'ACTION');
      order.push('first-acquired');

      // Starts waiting; must not proceed while the first lease is held.
      const secondPending = leaseSession(config, 'ACTION').then((lease) => {
        order.push('second-acquired');
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(order).toEqual(['first-acquired']);

      order.push('first-released');
      await first.release();
      const second = await secondPending;
      expect(order).toEqual(['first-acquired', 'first-released', 'second-acquired']);
      await second.release();
    } finally {
      await closeSession(accountId).catch(() => undefined);
    }
  }, 120_000);
});

describe('a Chrome that outlived the worker', () => {
  it('is attached to rather than spawned over', async () => {
    if (!chromeAvailable) {
      console.log('SKIPPED: Google Chrome is not installed here. This is not a pass.');
      return;
    }

    // The failure this reproduces: Chrome outliving the worker is deliberate, but
    // a restarted worker had no way back to it. It would launch again on the same
    // profile, Chrome would hand off to the running copy and exit without opening
    // the new port, and every poll failed with "the browser did not open its
    // debugging port" on an account whose browser was sitting there working.
    const profileDir = join(profileRoot, 'outlived');

    const first = await launchChrome({ engine: 'GOOGLE_CHROME', profileDir, startUrl: null, headless: true });
    started.push({ pid: first.pid });
    expect(first.process).not.toBeNull();

    // A second launch, as a restarted worker would make. Same browser, no spawn.
    const second = await launchChrome({ engine: 'GOOGLE_CHROME', profileDir, startUrl: null, headless: true });
    expect(second.cdpUrl).toBe(first.cdpUrl);
    expect(second.pid).toBe(first.pid);
    // Null is what says "AI17Z did not start this one and must not kill it".
    expect(second.process).toBeNull();

    // And it is the same live browser, not a recorded guess.
    const identity = await cdpIdentity(second.cdpUrl);
    expect(identity.product).toMatch(/^Chrome\//);

    await closeChrome({ ...first, profileDir }, 25_000);

    // Once it is gone the record goes with it, so the next launch really launches.
    expect(await existingChrome(profileDir)).toBeNull();
    const third = await launchChrome({ engine: 'GOOGLE_CHROME', profileDir, startUrl: null, headless: true });
    started.push({ pid: third.pid });
    expect(third.process).not.toBeNull();
    expect(third.cdpUrl).not.toBe(first.cdpUrl);
  }, 180_000);

  it('ignores a recorded endpoint that nothing answers on', async () => {
    // A browser somebody closed by hand leaves the file behind. Probing must be
    // cheap and wrong-guess-proof, not a 30-second wait on a dead port.
    const profileDir = join(profileRoot, 'stale');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'ai17z-cdp.json'),
      JSON.stringify({ cdpUrl: 'http://127.0.0.1:1', port: 1, pid: 999999 }),
      'utf8',
    );

    const began = Date.now();
    expect(await existingChrome(profileDir)).toBeNull();
    expect(Date.now() - began).toBeLessThan(10_000);
  }, 30_000);
});
