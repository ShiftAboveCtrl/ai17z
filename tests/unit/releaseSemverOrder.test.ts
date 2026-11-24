import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions } from '@xbam/shared';
import { fetchLatestRelease, releasesFromApi } from '@xbam/runtime';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
const bashPath = (file: string) => resolve(root, file).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
const shell = ['pwsh', 'powershell.exe', 'powershell'].find((name) =>
  spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0);
const hasBash = spawnSync('bash', ['--version']).status === 0;
const list = (tags: string[]) => tags.map((tag) => ({
  tag_name: tag, draft: false, prerelease: tag.includes('-'),
  assets: [{ name: `a_${tag.replace(/^v/, '')}.deb` }],
}));
// Hand-ordered once, then consumed by both PowerShell resolvers, all three
// Unix resolvers and TypeScript. Each prefix proves the next precedence step.
const orderedTags = [
  'v0.9.9', 'v1.0.0-2', 'v1.0.0-10', 'v1.0.0-alpha',
  'v1.0.0-beta.9', 'v1.0.0-beta.99', 'v1.0.0-beta.100',
  'v1.0.0-rc.1', 'v1.0.0-rc.1.1', 'v1.0.0', 'v1.0.1', 'v1.1.0', 'v2.0.0',
];
const cases = [
  { name: 'malformed tags cannot win', releases: list(['v99x.0.0', 'v2.0.0-', 'v1.0.0']), want: 'v1.0.0' },
  { name: 'numeric beta identifiers', releases: list(['v1.0.0-beta.99', 'v1.0.0-beta.100', 'v1.0.0-beta.98']), want: 'v1.0.0-beta.100' },
  { name: 'release candidates', releases: list(['v1.0.0-beta.100', 'v1.0.0-rc.1', 'v1.0.0-beta.9']), want: 'v1.0.0-rc.1' },
  { name: 'stable releases', releases: list(['v1.0.0-rc.1', 'v1.0.0', 'v1.0.0-beta.100']), want: 'v1.0.0' },
  { name: 'draft exclusion', releases: [{ ...list(['v2.0.0'])[0]!, draft: true }, ...list(['v1.0.0-beta.99', 'v1.0.0-beta.100'])], want: 'v1.0.0-beta.100' },
  { name: 'build metadata', releases: list(['v1.0.0-beta.99+new', 'v1.0.0-beta.100+old']), want: 'v1.0.0-beta.100+old' },
  { name: 'numeric before text', releases: list(['v1.0.0-2', 'v1.0.0-10a']), want: 'v1.0.0-10a' },
  { name: 'hyphenated prerelease identifiers', releases: list(['v1.0.0-beta-a.9', 'v1.0.0-beta-b.1']), want: 'v1.0.0-beta-b.1' },
  ...orderedTags.map((want, index) => ({ name: `shared ordering through ${want}`,
    releases: list(['v99x.0.0', ...orderedTags.slice(0, index + 1).reverse()]), want })),
];
afterEach(() => vi.unstubAllGlobals());

describe('the TypeScript update check channel filter', () => {
  it('requires complete semver tags, including nonempty identifiers', () => {
    const invalid = ['v99x.0.0', 'v2.0.0-', 'v2.0.0+', 'v02.0.0',
      'v2.0.0-beta..1', 'v2.0.0-beta.01', 'v2.0.0+build..1', 'v2.0.0\n'];
    expect(releasesFromApi(list(invalid))).toEqual([]);
  });
  it('skips malformed tags before fetching the chosen manifest', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      if (url.endsWith('/release-manifest.json')) return Response.json({ version: '1.0.0' });
      if (url.endsWith('/release-notes.md')) return new Response('Release notes');
      return Response.json(cases[0]!.releases);
    });
    expect(await fetchLatestRelease('0.9.0-beta.1')).toMatchObject({ version: '1.0.0' });
    expect(requests.some((url) => url.includes('/v1.0.0/release-manifest.json'))).toBe(true);
    expect(requests.some((url) => url.includes('/v99x.0.0/') || url.includes('/v2.0.0-/'))).toBe(false);
  });
  it.each([
    ['1.0.0-beta.98', 'v1.0.0-beta.100'],
    ['0.9.0', 'v0.9.1'],
  ])('offers %s the highest eligible version', async (current, wanted) => {
    const releases = [...cases[1]!.releases, ...list(['v0.9.1']), { ...list(['v2.0.0'])[0]!, draft: true }];
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      if (url.endsWith('/release-manifest.json')) return Response.json({ version: wanted.replace(/^v/, '') });
      if (url.endsWith('/release-notes.md')) return new Response('Release notes');
      return Response.json(releases);
    });
    expect(await fetchLatestRelease(current)).toMatchObject({ version: wanted.replace(/^v/, '') });
    expect(requests.some((url) => url.includes(`/${wanted}/release-manifest.json`))).toBe(true);
  });
});

describe.skipIf(!shell)('the shipped PowerShell release resolvers', () => {
  it.each(['install.ps1', 'packaging/windows/Setup-AI17Z.ps1'])('%s picks by precedence', (file) => {
    // Load function declarations only, so stage zero never runs its installer.
    const driver = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${resolve(root, file).replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$Release = ''; $SetupAssetPattern = 'Install-AI17Z-{0}.ps1'; $ChecksumAsset = 'SHA256SUMS.txt'
$script:Ai17zAssets = @{ Package = 'a_{0}.deb'; Checksums = 'SHA256SUMS.txt' }
$rows = [Console]::In.ReadToEnd() | ConvertFrom-Json
$answers = @()
foreach ($row in $rows) {
  $script:body = ConvertTo-Json -InputObject @($row.releases) -Depth 8 -Compress
  function Get-Text { return $script:body }
  function Get-Ai17zText { return [pscustomobject]@{ Ok = $true; Body = $script:body } }
  if ('${file}' -eq 'install.ps1') { $answers += (Get-FromSource ([pscustomobject]@{ Name = 'fixture'; Api = ''; ListQuery = '' })).Tag }
  else { $answers += (Get-Ai17zRelease '' ([pscustomobject]@{ Name = 'fixture'; Releases = ''; Downloads = '' })).Release.tag_name }
}
ConvertTo-Json -InputObject @($answers) -Compress`;
    const output = execFileSync(shell!, ['-NoProfile', '-NonInteractive', '-Command', driver], {
      input: JSON.stringify(cases), encoding: 'utf8', timeout: 30_000,
    });
    expect(JSON.parse(output.trim())).toEqual(cases.map((row) => row.want));
  });
});

describe.skipIf(!hasBash)('the shipped Unix release resolvers', () => {
  it.each(['install-ai17z-ubuntu.sh', 'install-ai17z-macos.sh'])('%s loads the shared helper for a standalone download', (file) => {
    const text = read(file);
    const start = text.indexOf('pick_tag() {');
    const code = text.slice(start, text.indexOf('\n}\n', start) + 3);
    const room = mkdtempSync(resolve(tmpdir(), 'ai17z-semver-'));
    try {
      const out = spawnSync('bash', ['-s'], { cwd: room, encoding: 'utf8', input: `
WORK="$PWD"; AI17Z_DOWNLOAD_HOSTS='code.ai17z.io'
ai17z_fetch() {
  case "$2" in
    https://raw.githubusercontent.com/*) return 1 ;;
    https://code.ai17z.io/*/ai17z-release.sh) cp '${bashPath('packaging/unix/ai17z-release.sh')}' "$1" ;;
    *) return 2 ;;
  esac
}
${code}
RELEASE='decoy'; pick_tag '${JSON.stringify(cases[1]!.releases)}' 'a_<version>.deb' ''
pick_tag '${JSON.stringify(cases[1]!.releases)}' 'a_<version>.deb' 'v1.0.0-beta.99'
` });
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout.trim()).toBe('v1.0.0-beta.100\nv1.0.0-beta.99');
    } finally { rmSync(room, { recursive: true, force: true }); }
  });
  it('latest ignores ambient RELEASE and leaves an existing pick_tag alone', () => {
    const code = `. '${bashPath('packaging/unix/ai17z-paths.sh')}'`;
    const json = JSON.stringify(cases[1]!.releases);
    const out = spawnSync('bash', ['-s'], { input: `${code}\nAI17Z_SOURCE_LISTS=(fixture)\ncurl() { printf '%s' '${json}'; }\npick_tag() { printf 'sentinel'; }\nexport RELEASE=v1.0.0-beta.99\nai17z_latest_release_tag 'a_<version>.deb'\npick_tag`, encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe('v1.0.0-beta.100\nsentinel');
  });
  it.each(['packaging/unix/ai17z-paths.sh', 'install-ai17z-ubuntu.sh', 'install-ai17z-macos.sh'])('%s picks by precedence and package', (file) => {
    const text = read(file);
    const helper = file.includes('/unix/');
    const start = text.indexOf(helper ? 'ai17z_latest_release_tag() {' : 'pick_tag() {');
    const end = text.indexOf('\n}\n', start);
    const code = helper ? `. '${bashPath(file)}'` : text.slice(start, end + 3);
    for (const row of cases) {
      const json = JSON.stringify(row.releases);
      const driver = helper
        ? `AI17Z_SOURCE_LISTS=(fixture); curl() { printf '%s' '${json}'; }; ${code}\nai17z_latest_release_tag 'a_<version>.deb'`
        : `${code}\nRELEASE=''; pick_tag '${json}' 'a_<version>.deb'`;
      const out = spawnSync('bash', ['-s'], { input: driver, encoding: 'utf8' });
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout.trim(), row.name).toBe(row.want);
    }
    const json = JSON.stringify([
      { ...list(['v2.0.0'])[0]!, assets: [], body: 'A future "a_2.0.0.deb" package' },
      ...cases[1]!.releases,
    ]);
    const driver = helper
      ? `AI17Z_SOURCE_LISTS=(fixture); curl() { printf '%s' '${json}'; }; ${code}\nai17z_latest_release_tag 'a_<version>.deb'`
      : `${code}\nRELEASE=''; pick_tag '${json}' 'a_<version>.deb'`;
    const out = spawnSync('bash', ['-s'], { input: driver, encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe('v1.0.0-beta.100');
  });
});

describe('the TypeScript semver comparator used by the update resolver', () => {
  it.each(cases)('orders $name', ({ releases, want }) => {
    expect(releasesFromApi(releases).sort((a, b) => compareVersions(b.tag, a.tag))[0]?.tag).toBe(want);
  });
  it('ignores build metadata and orders numeric identifiers before text', () => {
    expect(compareVersions('1.0.0-beta.100+abc', '1.0.0-beta.100+xyz')).toBe(0);
    expect(compareVersions('1.0.0-2', '1.0.0-10a')).toBeLessThan(0);
  });
});
