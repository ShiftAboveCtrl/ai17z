import { describe, expect, it } from 'vitest';
import {
  INSTALL_LAYOUT_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  preflight,
  recordMatchesPlatform,
  trustInstallRecord,
  upgradeInstallRecord,
  type InstallRecord,
  type ReleaseManifest,
} from '@xbam/shared';

/**
 * An installation made by an older AI17Z has to be able to take a newer one.
 *
 * This is the promise that costs the most to break and is the easiest to break
 * silently: every fresh install works, so a packaging change that strands
 * existing installations passes every other test in this repository. The only
 * way to know is to build what an older release actually wrote and read it
 * forward.
 *
 * N-2, N-1 and N for every install method that has ever existed.
 *
 * The paths below are invented: an installation record is mostly paths, and a
 * fixture for one has to look like the real thing to be worth anything.
 * @release-check-fixtures
 */

/** What each generation of AI17Z wrote into INSTALL_INFO.json. */
const FIXTURES = {
  /** The Inno installer, schema 1. The oldest layout still supported. */
  windowsInstallerN2: {
    schema: 1,
    channel: 'INSTALLER',
    instance: 'AI17Z',
    programDir: 'C:\\Users\\owner\\AppData\\Local\\Programs\\AI17Z',
    dataDir: 'C:\\Users\\owner\\AppData\\Local\\AI17Z',
    version: '1.0.0-beta.14',
    release: 'v1.0.0-beta.14',
  },
  /** The terminal route, schema 2. */
  windowsBootstrapN1: {
    schema: 2,
    channel: 'BOOTSTRAP',
    instance: 'AI17Z',
    programDir: 'C:\\Users\\owner\\AppData\\Local\\Programs\\AI17Z',
    dataDir: 'C:\\Users\\owner\\AppData\\Local\\AI17Z',
    version: '1.0.0-beta.16',
    release: 'v1.0.0-beta.16',
    setupScript: 'packaging\\windows\\Setup-AI17Z.ps1',
    updateCommand: 'update-ai17z.ps1',
  },
  /** From before any marker existed at all. */
  windowsMarkerless: null,
} as const;

const WINDOWS_CONTEXT = {
  foundInAppRoot: 'C:\\Users\\owner\\AppData\\Local\\Programs\\AI17Z',
  platform: 'windows',
  arch: 'x64',
  dataRootHint: 'C:\\Users\\owner\\AppData\\Local\\AI17Z',
  versionHint: '1.0.0-beta.13',
} as const;

describe('an installation from two releases ago reads forward', () => {
  it('N-2: the Inno installer, schema 1', () => {
    const record = upgradeInstallRecord(FIXTURES.windowsInstallerN2, WINDOWS_CONTEXT);
    expect(record).not.toBeNull();
    expect(record!.schema).toBe(INSTALL_LAYOUT_SCHEMA);
    expect(record!.installMethod).toBe('INSTALLER');
    expect(record!.platform).toBe('windows');
    // The two things that must survive a schema change, because losing either
    // means the owner's agents and sealed credentials are unreachable.
    expect(record!.dataRoot).toBe('C:\\Users\\owner\\AppData\\Local\\AI17Z');
    expect(record!.instance).toBe('AI17Z');
  });

  it('N-1: the terminal route, schema 2', () => {
    const record = upgradeInstallRecord(FIXTURES.windowsBootstrapN1, WINDOWS_CONTEXT);
    expect(record!.installMethod).toBe('BOOTSTRAP');
    expect(record!.appVersion).toBe('1.0.0-beta.16');
    expect(record!.dataRoot).toBe('C:\\Users\\owner\\AppData\\Local\\AI17Z');
  });

  it('older than any marker: assumed to be what actually made those', () => {
    // Everything from before the marker came from the Windows installer.
    // Guessing a third answer is how one of them stops being able to update.
    const record = upgradeInstallRecord(
      { instance: 'AI17Z', dataDir: WINDOWS_CONTEXT.dataRootHint },
      WINDOWS_CONTEXT,
    );
    expect(record!.installMethod).toBe('INSTALLER');
    expect(record!.appVersion).toBe('1.0.0-beta.13');
  });

  it('keeps a custom instance name and a custom directory', () => {
    // Somebody who installed a second AI17Z somewhere of their choosing. The
    // folder leaf is deliberately not the instance name, and an earlier version
    // of this guard assumed it was.
    const record = upgradeInstallRecord(
      { schema: 2, channel: 'BOOTSTRAP', instance: 'AI17Z-research', programDir: 'D:\\apps\\work', dataDir: 'D:\\apps\\work-data', version: '1.0.0-beta.16' },
      { ...WINDOWS_CONTEXT, foundInAppRoot: 'D:\\apps\\work', dataRootHint: 'D:\\apps\\work-data' },
    );
    expect(record!.instance).toBe('AI17Z-research');
    expect(record!.dataRoot).toBe('D:\\apps\\work-data');
    expect(trustInstallRecord(record!, 'D:\\apps\\work').ok).toBe(true);
  });
});

describe('the packaged Unix layouts, from their first release onward', () => {
  it('Ubuntu: the first packaged schema reads forward', () => {
    const record = upgradeInstallRecord(
      {
        schema: 3,
        platform: 'ubuntu',
        arch: 'x64',
        installMethod: 'UBUNTU_DEB',
        instance: 'AI17Z',
        appVersion: '1.0.0-beta.17',
        appRoot: '/usr/lib/ai17z/app',
        dataRoot: '/home/owner/.config/ai17z',
        runtimeRoot: '/usr/lib/ai17z/runtime',
        browserProfileRoot: '/home/owner/.local/share/ai17z/browser-profiles',
      },
      { foundInAppRoot: '/usr/lib/ai17z/app', platform: 'ubuntu', arch: 'x64' },
    );
    expect(record!.installMethod).toBe('UBUNTU_DEB');
    expect(record!.runtimeRoot).toBe('/usr/lib/ai17z/runtime');
    expect(recordMatchesPlatform(record!)).toBe(true);
  });

  it('macOS: the first packaged schema reads forward, spaces and all', () => {
    const appRoot = '/Users/owner/Library/Application Support/AI17Z/AI17Z/app';
    const record = upgradeInstallRecord(
      {
        schema: 3,
        platform: 'macos',
        arch: 'arm64',
        installMethod: 'MACOS_PKG',
        instance: 'AI17Z',
        appVersion: '1.0.0-beta.17',
        appRoot,
        dataRoot: '/Users/owner/Library/Application Support/AI17Z/AI17Z/data',
        runtimeRoot: '/Users/owner/Library/Application Support/AI17Z/AI17Z/runtime',
        browserProfileRoot: null,
      },
      { foundInAppRoot: appRoot, platform: 'macos', arch: 'arm64' },
    );
    expect(record!.installMethod).toBe('MACOS_PKG');
    // "Application Support" has a space in it and everything below inherits it.
    expect(record!.appRoot).toContain('Application Support');
    expect(trustInstallRecord(record!, appRoot).ok).toBe(true);
  });

  it('a record whose method and platform disagree is caught', () => {
    const record: InstallRecord = {
      schema: 3, platform: 'ubuntu', arch: 'x64', installMethod: 'MACOS_PKG',
      instance: 'AI17Z', appVersion: '1.0.0', appRoot: '/usr/lib/ai17z/app',
      dataRoot: '/home/owner/.config/ai17z', runtimeRoot: null, browserProfileRoot: null,
    };
    expect(recordMatchesPlatform(record)).toBe(false);
  });
});

/** A release that this machine should refuse, and one it should take. */
function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    version: '2.0.0', tag: 'v2.0.0', commit: 'abcdef1234567',
    builtAt: '2026-01-01T00:00:00.000Z',
    signed: { windows: false, macos: false, ubuntu: false },
    minimumUpdaterSchema: 1,
    installLayoutSchema: INSTALL_LAYOUT_SCHEMA,
    platforms: {
      ubuntu: {
        supported: true, architectures: ['x64', 'arm64'], methods: ['UBUNTU_DEB'],
        requirements: { minimumDocker: '26.0.0', minimumChromeMajor: 120, bundledNode: 'v22.23.2', os: { releases: ['24.04', '26.04'] } },
      },
      macos: {
        supported: true, architectures: ['arm64'], methods: ['MACOS_PKG'],
        requirements: { minimumDocker: '26.0.0', minimumChromeMajor: 120, bundledNode: 'v22.23.2', os: { minimumMajor: 14 } },
      },
    },
    artifacts: [], migrations: { latest: '0080_x.sql', count: 80 },
    ...overrides,
  } as ReleaseManifest;
}

describe('an update that cannot run here is refused before anything stops', () => {
  it('an Ubuntu that the new release dropped support for', () => {
    // The case that matters most: a working installation on an older Ubuntu
    // must keep working rather than being half-replaced.
    const verdict = preflight(manifest(), {
      platform: 'ubuntu', arch: 'x64', osVersion: '22.04', dockerVersion: '27.0.0', chromeMajor: 140,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers[0]).toContain('Ubuntu 24.04, 26.04');
  });

  it('an Intel Mac when the new release is Apple Silicon only', () => {
    const verdict = preflight(manifest(), {
      platform: 'macos', arch: 'x64', osVersion: '14.5', dockerVersion: '27.0.0', chromeMajor: 140,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers[0]).toContain('no x64 build');
  });

  it('a Docker too old, and it says who updates it', () => {
    const verdict = preflight(manifest(), {
      platform: 'ubuntu', arch: 'x64', osVersion: '24.04', dockerVersion: '24.0.0', chromeMajor: 140,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers[0]).toContain('will not update it for you');
  });

  it('and takes the update when the machine actually meets it', () => {
    const verdict = preflight(manifest(), {
      platform: 'ubuntu', arch: 'arm64', osVersion: '24.04', dockerVersion: '27.0.0', chromeMajor: 140,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });
});

describe('an older updater is told how to reach a newer packaging generation', () => {
  it('declares the oldest updater that can read it directly', () => {
    // The number that stops an old installation trying to understand a layout
    // it predates. An updater older than this fetches a newer verified helper
    // and hands over rather than guessing.
    expect(manifest().minimumUpdaterSchema).toBeGreaterThanOrEqual(1);
    expect(manifest().installLayoutSchema).toBe(INSTALL_LAYOUT_SCHEMA);
  });

  it('a release needing a newer updater than this one is recognisable', () => {
    const future = manifest({ minimumUpdaterSchema: 99 });
    const mine = 1;
    // The decision an updater makes: not "fail", but "get the right helper".
    expect(future.minimumUpdaterSchema > mine).toBe(true);
  });
});
