import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions } from '@xbam/shared';
import { fetchLatestRelease } from '@xbam/runtime';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
const shell = ['pwsh', 'powershell.exe', 'powershell'].find((name) =>
  spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0);
const hasBash = spawnSync('bash', ['--version']).status === 0;
const list = (tags: string[]) => tags.map((tag) => ({
  tag_name: tag, draft: false, prerelease: tag.includes('-'),
  assets: [{ name: `a_${tag.replace(/^v/, '')}.deb` }],
}));
const cases = [
  { name: 'numeric beta identifiers', releases: list(['v1.0.0-beta.99', 'v1.0.0-beta.100', 'v1.0.0-beta.98']), want: 'v1.0.0-beta.100' },
  { name: 'release candidates', releases: list(['v1.0.0-beta.100', 'v1.0.0-rc.1', 'v1.0.0-beta.9']), want: 'v1.0.0-rc.1' },
  { name: 'stable releases', releases: list(['v1.0.0-rc.1', 'v1.0.0', 'v1.0.0-beta.100']), want: 'v1.0.0' },
  { name: 'draft exclusion', releases: [{ ...list(['v2.0.0'])[0]!, draft: true }, ...list(['v1.0.0-beta.99', 'v1.0.0-beta.100'])], want: 'v1.0.0-beta.100' },
  { name: 'build metadata', releases: list(['v1.0.0-beta.99+new', 'v1.0.0-beta.100+old']), want: 'v1.0.0-beta.100+old' },
  { name: 'numeric before text', releases: list(['v1.0.0-2', 'v1.0.0-10a']), want: 'v1.0.0-10a' },
  { name: 'hyphenated prerelease identifiers', releases: list(['v1.0.0-beta-a.9', 'v1.0.0-beta-b.1']), want: 'v1.0.0-beta-b.1' },
];
afterEach(() => vi.unstubAllGlobals());

describe('the TypeScript update check channel filter', () => {
  it.each([
    ['1.0.0-beta.98', 'v1.0.0-beta.100'],
    ['0.9.0', 'v0.9.1'],
  ])('offers %s the highest eligible version', async (current, wanted) => {
    const releases = [...cases[0]!.releases, ...list(['v0.9.1']), { ...list(['v2.0.0'])[0]!, draft: true }];
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
  it.each(['packaging/unix/ai17z-paths.sh', 'install-ai17z-ubuntu.sh', 'install-ai17z-macos.sh'])('%s picks by precedence and package', (file) => {
    const text = read(file);
    const helper = file.includes('/unix/');
    const start = text.indexOf(helper ? 'ai17z_latest_release_tag() {' : 'pick_tag() {');
    const end = text.indexOf('\n}\n', start);
    const code = text.slice(start, end + 3);
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
      ...cases[0]!.releases,
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
    expect(releases.filter((r) => !r.draft).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0]?.tag_name).toBe(want);
  });
  it('ignores build metadata and orders numeric identifiers before text', () => {
    expect(compareVersions('1.0.0-beta.100+abc', '1.0.0-beta.100+xyz')).toBe(0);
    expect(compareVersions('1.0.0-2', '1.0.0-10a')).toBeLessThan(0);
  });
});
