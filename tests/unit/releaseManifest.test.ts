import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSTALL_LAYOUT_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  bareVersion,
  compareVersionNumbers,
  debArchitecture,
  installerScriptAsset,
  macosPackageAsset,
  nodeArchiveName,
  parseReleaseManifest,
  preflight,
  trustInstallRecord,
  ubuntuPackageAsset,
  upgradeInstallRecord,
  windowsInstallerAsset,
  windowsPackageAsset,
  windowsSetupAsset,
  type ReleaseManifest,
} from '@xbam/shared';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/**
 * One place names an asset, and everything else is held to it.
 *
 * The installers are shell scripts in three languages and cannot import this
 * module, which is the entire reason these exist: the only thing keeping a
 * PowerShell pattern and a bash pattern and a TypeScript function in step is a
 * test that fails when one of them moves.
 */
describe('asset names come from one place', () => {
  const VERSION = '9.9.9-beta.1';

  it('derives every published name from the version', () => {
    expect(windowsPackageAsset(VERSION)).toBe('AI17Z-App-9.9.9-beta.1.zip');
    expect(windowsSetupAsset(VERSION)).toBe('Install-AI17Z-9.9.9-beta.1.ps1');
    expect(windowsInstallerAsset(VERSION)).toBe('AI17Z-Setup-9.9.9-beta.1.exe');
    expect(macosPackageAsset(VERSION, 'arm64')).toBe('AI17Z-macos-arm64-9.9.9-beta.1.tar.gz');
    expect(macosPackageAsset(VERSION, 'x64')).toBe('AI17Z-macos-x64-9.9.9-beta.1.tar.gz');
    expect(ubuntuPackageAsset(VERSION, 'x64')).toBe('ai17z_9.9.9-beta.1_amd64.deb');
    expect(ubuntuPackageAsset(VERSION, 'arm64')).toBe('ai17z_9.9.9-beta.1_arm64.deb');
  });

  it('strips a leading v wherever a tag arrives instead of a version', () => {
    expect(bareVersion('v1.2.3')).toBe('1.2.3');
    expect(windowsPackageAsset('v1.2.3')).toBe(windowsPackageAsset('1.2.3'));
    expect(ubuntuPackageAsset('v1.2.3', 'x64')).toBe('ai17z_1.2.3_amd64.deb');
  });

  it('names the readable installer each platform is told to download', () => {
    // The one a person fetches, looks at, and then runs. Named per platform so
    // a macOS instruction can never hand somebody the Ubuntu script.
    expect(installerScriptAsset('macos')).toBe('install-ai17z-macos.sh');
    expect(installerScriptAsset('ubuntu')).toBe('install-ai17z-ubuntu.sh');
  });

  it('spells the architecture the way each ecosystem spells it', () => {
    // Debian says amd64 and nothing will accept a package that says x64.
    expect(debArchitecture('x64')).toBe('amd64');
    expect(debArchitecture('arm64')).toBe('arm64');
    // Node says darwin, and x64 rather than amd64.
    expect(nodeArchiveName('v22.23.2', 'macos', 'arm64')).toBe('node-v22.23.2-darwin-arm64.tar.gz');
    expect(nodeArchiveName('22.23.2', 'ubuntu', 'x64')).toBe('node-v22.23.2-linux-x64.tar.gz');
  });

  it('agrees with the pattern install.ps1 carries', () => {
    // PowerShell cannot import this file, so the string it formats is held here.
    const install = read('install.ps1');
    const pattern = /\$SetupAssetPattern = '([^']+)'/.exec(install)?.[1] ?? '';
    expect(pattern.replace('{0}', VERSION)).toBe(windowsSetupAsset(VERSION));

    const setup = read('packaging/windows/Setup-AI17Z.ps1');
    const packagePattern = /Package\s*=\s*'([^']+)'/.exec(setup)?.[1] ?? '';
    expect(packagePattern.replace('{0}', VERSION)).toBe(windowsPackageAsset(VERSION));
  });
});

/** A manifest good enough to reason about, without inventing a real release. */
function manifestFixture(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    version: '9.9.9',
    tag: 'v9.9.9',
    commit: 'abcdef1234567890',
    builtAt: '2026-01-01T00:00:00.000Z',
    signed: { windows: false, macos: false, ubuntu: false },
    minimumUpdaterSchema: 1,
    installLayoutSchema: INSTALL_LAYOUT_SCHEMA,
    platforms: {
      ubuntu: {
        supported: true,
        architectures: ['x64', 'arm64'],
        methods: ['UBUNTU_DEB'],
        requirements: {
          minimumDocker: '26.0.0',
          minimumChromeMajor: 120,
          bundledNode: 'v22.23.2',
          os: { releases: ['22.04', '24.04', '26.04'] },
        },
      },
      macos: {
        supported: true,
        architectures: ['arm64', 'x64'],
        methods: ['MACOS_PKG'],
        requirements: {
          minimumDocker: '26.0.0',
          minimumChromeMajor: 120,
          bundledNode: 'v22.23.2',
          os: { minimumMajor: 13 },
        },
      },
    },
    artifacts: [],
    migrations: { latest: '0071_feed_subscriptions.sql', count: 71 },
    ...overrides,
  } as ReleaseManifest;
}

describe('preflight decides before anything is stopped', () => {
  const ubuntu = { platform: 'ubuntu', arch: 'x64', osVersion: '24.04', dockerVersion: '27.0.0', chromeMajor: 140 } as const;

  it('passes a machine that meets everything', () => {
    const verdict = preflight(manifestFixture(), ubuntu);
    expect(verdict.ok).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it('refuses an unsupported Ubuntu rather than half-installing on it', () => {
    const verdict = preflight(manifestFixture(), { ...ubuntu, osVersion: '20.04' });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers[0]).toContain('Ubuntu 22.04, 24.04, 26.04');
  });

  it('refuses an architecture the release does not build', () => {
    const manifest = manifestFixture();
    manifest.platforms.ubuntu!.architectures = ['x64'];
    const verdict = preflight(manifest, { ...ubuntu, arch: 'arm64' });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers[0]).toContain('no arm64 build');
  });

  it('refuses a Docker older than the release needs, and says who updates it', () => {
    const verdict = preflight(manifestFixture(), { ...ubuntu, dockerVersion: '20.10.7' });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers[0]).toContain('Docker 26.0.0 or newer');
    // The rule that stops an AI17Z update surprising somebody with a Docker one.
    expect(verdict.blockers[0]).toContain('will not update it for you');
  });

  it('treats a missing Chrome as a smaller thing than a broken install', () => {
    // A headless server has no Chrome and must still take updates. Refusing
    // here would strand every Ubuntu Server installation on the version it has.
    const verdict = preflight(manifestFixture(), { ...ubuntu, chromeMajor: null });
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(' ')).toContain('stays unavailable');
  });

  it('holds macOS to the floor Chrome actually sets', () => {
    const older = preflight(manifestFixture(), {
      platform: 'macos',
      arch: 'arm64',
      osVersion: '12.7',
      dockerVersion: '27.0.0',
      chromeMajor: 140,
    });
    expect(older.ok).toBe(false);
    expect(older.blockers[0]).toContain('macOS 13 or newer');
  });

  it('refuses a platform the release does not publish at all', () => {
    const verdict = preflight(manifestFixture(), { ...ubuntu, platform: 'windows' });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockers[0]).toContain('does not publish a windows build');
  });
});

describe('version comparison, on the strings vendors actually print', () => {
  it('orders the shapes docker and chrome report', () => {
    expect(compareVersionNumbers('27.4.0', '26.0.0')).toBe(1);
    expect(compareVersionNumbers('26.0.0', '26.0.0')).toBe(0);
    expect(compareVersionNumbers('20.10.7', '26.0.0')).toBe(-1);
    // A prerelease of what is needed is not what is needed.
    expect(compareVersionNumbers('26.0.0-rc.1', '26.0.0')).toBe(0);
    expect(compareVersionNumbers('v27.1', '27.0.9')).toBe(1);
  });
});

describe('an old installation record is read forward, never refused', () => {
  const context = {
    foundInAppRoot: 'C:\\L\\Programs\\AI17Z',
    platform: 'windows',
    arch: 'x64',
    dataRootHint: 'C:\\L\\AI17Z',
    versionHint: '1.0.0-beta.9',
  } as const;

  it('reads the Inno installer schema 1', () => {
    const record = upgradeInstallRecord(
      { schema: 1, channel: 'INSTALLER', instance: 'AI17Z', programDir: 'C:\\L\\Programs\\AI17Z', dataDir: 'C:\\L\\AI17Z', version: '1.0.0-beta.15' },
      context,
    );
    expect(record?.schema).toBe(INSTALL_LAYOUT_SCHEMA);
    expect(record?.installMethod).toBe('INSTALLER');
    expect(record?.appVersion).toBe('1.0.0-beta.15');
    expect(record?.dataRoot).toBe('C:\\L\\AI17Z');
  });

  it('reads the terminal route schema 2', () => {
    const record = upgradeInstallRecord(
      { schema: 2, channel: 'BOOTSTRAP', instance: 'AI17Z-test', programDir: 'C:\\L\\Programs\\AI17Z', dataDir: 'C:\\L\\AI17Z', version: '1.0.0-beta.16' },
      context,
    );
    expect(record?.installMethod).toBe('BOOTSTRAP');
    expect(record?.instance).toBe('AI17Z-test');
    // Schema 2 had no private runtime. Null is the honest answer.
    expect(record?.runtimeRoot).toBeNull();
  });

  it('assumes the route that actually made markerless installations', () => {
    // Everything from before the marker existed came from the Windows
    // installer. Guessing a third answer is how one of them stops updating.
    const record = upgradeInstallRecord({ instance: 'AI17Z', dataDir: 'C:\\L\\AI17Z' }, context);
    expect(record?.installMethod).toBe('INSTALLER');
  });

  it('needs somewhere for the data, and says so by returning nothing', () => {
    expect(upgradeInstallRecord({ schema: 2 }, { ...context, dataRootHint: null })).toBeNull();
    expect(upgradeInstallRecord(null, context)).toBeNull();
  });

  it('rebuilds a record too broken to parse rather than stranding it', () => {
    const record = upgradeInstallRecord({ schema: 3, instance: 'AI17Z', dataDir: 'C:\\L\\AI17Z' }, context);
    expect(record?.schema).toBe(INSTALL_LAYOUT_SCHEMA);
    expect(record?.appRoot).toBe(context.foundInAppRoot);
  });
});

describe('a record says how a copy was installed, never where one is', () => {
  it('refuses a record describing a different folder', () => {
    // The Beta 1.0.0 (14) defect as a rule: an installation named one thing,
    // its files written into another, and an uninstaller registered to delete a
    // directory belonging to something else.
    const verdict = trustInstallRecord(
      { appRoot: 'C:\\L\\Programs\\AI17Z-test' },
      'C:\\L\\Programs\\AI17Z',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('AI17Z-test');
  });

  it('accepts the same folder however it is spelled', () => {
    for (const claimed of ['C:\\L\\AI17Z', 'C:\\L\\AI17Z\\', 'c:\\l\\ai17z', 'C:/L/AI17Z']) {
      expect(trustInstallRecord({ appRoot: claimed }, 'C:\\L\\AI17Z').ok, claimed).toBe(true);
    }
  });

  it('still reads the schema 1 spelling of the same field', () => {
    const verdict = trustInstallRecord(
      { programDir: 'C:\\L\\Programs\\Other' } as never,
      'C:\\L\\Programs\\AI17Z',
    );
    expect(verdict.ok).toBe(false);
  });

  it('has nothing to disagree with when there is no record', () => {
    expect(trustInstallRecord(null, 'C:\\L\\AI17Z').ok).toBe(true);
  });
});

describe('the manifest is parsed or refused, never half-read', () => {
  it('refuses text that is not JSON', () => {
    const result = parseReleaseManifest('<html>404</html>');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not JSON');
  });

  it('refuses a document missing what an updater has to know', () => {
    const result = parseReleaseManifest(JSON.stringify({ schemaVersion: 1, version: '1.0.0' }));
    expect(result.ok).toBe(false);
  });

  it('accepts a complete one', () => {
    const result = parseReleaseManifest(JSON.stringify(manifestFixture()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.version).toBe('9.9.9');
  });
});
