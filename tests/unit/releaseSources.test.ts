/**
 * Where a release is fetched from, held the same everywhere it is written.
 *
 * GitHub first and AI17Z Code second is one decision written six times: once
 * in TypeScript, once in each PowerShell file, once in the shared Unix helper
 * and once in each standalone Unix installer, which is downloaded on its own
 * and cannot source the helper. A copy that drifts is an installer that asks
 * a host nothing else asks, or that refuses one everything else allows, and
 * neither shows until a stranger runs it. So every copy is held against
 * `RELEASE_SOURCES` and `DOWNLOAD_HOSTS` here, and the fallback itself is
 * driven with a fake `curl` rather than reasoned about.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DOWNLOAD_HOSTS, GITHUB_SOURCE, RELEASE_SOURCES, forgejoSource } from '@xbam/shared';

const root = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const hasBash = !spawnSync('bash', ['--version']).error;
const room = mkdtempSync(join(tmpdir(), 'ai17z-sources-'));
afterAll(() => rmSync(room, { recursive: true, force: true }));
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

const paths = read('packaging/unix/ai17z-paths.sh');
const block = paths.slice(
  paths.indexOf('# Where a release is fetched from, in order: GitHub, then AI17Z Code.'),
  paths.indexOf("# The newest release's tag, from the first source whose list answers."),
);

describe('the order', () => {
  it('is GitHub, then AI17Z Code', () => {
    expect(RELEASE_SOURCES.map((source) => source.name)).toEqual(['GitHub', 'AI17Z Code']);
    expect(RELEASE_SOURCES[0]).toBe(GITHUB_SOURCE);
  });

  it('puts every address a source composes on a declared host', () => {
    for (const source of [GITHUB_SOURCE, forgejoSource()]) {
      for (const url of [source.releasesApi(), source.assetUrl('v1.0.0', 'SHA256SUMS.txt'), source.pageUrl('v1.0.0')]) {
        expect(DOWNLOAD_HOSTS, `${url} is on a host nothing allows`).toContain(new URL(url).host);
      }
    }
  });

  it('names GitHub and AI17Z Code addresses the same way GitHub and Forgejo serve them', () => {
    expect(GITHUB_SOURCE.assetUrl('v1.0.0-beta.87', 'SHA256SUMS.txt')).toBe(
      'https://github.com/ShiftAboveCtrl/ai17z/releases/download/v1.0.0-beta.87/SHA256SUMS.txt',
    );
    expect(forgejoSource().assetUrl('v1.0.0-beta.87', 'SHA256SUMS.txt')).toBe(
      'https://code.ai17z.io/AI17Z/ai17z/releases/download/v1.0.0-beta.87/SHA256SUMS.txt',
    );
  });
});

describe('every copy of the list', () => {
  const quoted = DOWNLOAD_HOSTS.map((host) => `'${host}'`).join(', ');

  it.each(['install.ps1', 'packaging/windows/Setup-AI17Z.ps1'])('%s allows exactly the declared hosts', (file) => {
    expect(read(file)).toContain(`AllowedHosts = @(${quoted})`);
  });

  it('the Unix helper allows exactly the declared hosts', () => {
    expect(paths).toContain(`AI17Z_DOWNLOAD_HOSTS="${DOWNLOAD_HOSTS.join(' ')}"`);
  });

  it.each(['install-ai17z-ubuntu.sh', 'install-ai17z-macos.sh'])('%s carries the helper\'s block byte for byte', (file) => {
    expect(block.length).toBeGreaterThan(500);
    expect(read(file)).toContain(block);
  });

  it.each([
    ['install.ps1', "Api = 'https://api.github.com/repos/ShiftAboveCtrl/ai17z'", "Api = 'https://code.ai17z.io/api/v1/repos/AI17Z/ai17z'"],
    ['packaging/windows/Setup-AI17Z.ps1', GITHUB_SOURCE.releasesApi(), forgejoSource().releasesApi()],
    ['packaging/unix/ai17z-paths.sh', GITHUB_SOURCE.releasesApi(10), forgejoSource().releasesApi(10)],
  ])('%s asks GitHub before AI17Z Code', (file, first, second) => {
    const text = read(file);
    expect(text.indexOf(first), `${file} does not ask GitHub`).toBeGreaterThan(0);
    expect(text.indexOf(second), `${file} asks AI17Z Code first`).toBeGreaterThan(text.indexOf(first));
  });
});

/**
 * A curl that serves files from a table of URLs, and reports the address it
 * "landed on" the way `-w '%{url_effective}'` does. A row's value is either a
 * body, or `{ body, landed }` for a redirect.
 */
function fakeCurl(table: Record<string, string | { body: string; landed: string }>): string {
  const cases = Object.entries(table)
    .map(([url, row]) => {
      const body = typeof row === 'string' ? row : row.body;
      const landed = typeof row === 'string' ? url : row.landed;
      return `    '${url}') body='${body}'; landed='${landed}' ;;`;
    })
    .join('\n');
  return `curl() {
  local out='' url='' effective=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) out="$2"; shift 2 ;;
      -w) effective=1; shift 2 ;;
      --proto|--proto-redir|--retry|--max-redirs) shift 2 ;;
      -*) shift ;;
      *) url="$1"; shift ;;
    esac
  done
  local body='' landed=''
  case "$url" in
${cases}
    *) return 22 ;;
  esac
  if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
  [ "$effective" = 1 ] && printf '%s' "$landed"
  return 0
}`;
}

describe.skipIf(!hasBash)('the Unix helper, driven', () => {
  const helper = posix(join(root, 'packaging/unix/ai17z-paths.sh'));
  const run = (curl: string, script: string) =>
    spawnSync('bash', ['-c', `${curl}\n. "${helper}" >/dev/null 2>&1\n${script}`], { cwd: room, encoding: 'utf8' });
  const GH = 'https://github.com/ShiftAboveCtrl/ai17z/releases/download/v1.0.0';
  const FJ = 'https://code.ai17z.io/AI17Z/ai17z/releases/download/v1.0.0';

  it('takes every file from GitHub when GitHub has them all', () => {
    const curl = fakeCurl({ [`${GH}/a.deb`]: 'gh-deb', [`${GH}/SHA256SUMS.txt`]: 'gh-sums', [`${FJ}/a.deb`]: 'fj-deb', [`${FJ}/SHA256SUMS.txt`]: 'fj-sums' });
    const out = run(curl, 'd=$(mktemp -d); ai17z_fetch_release_files "$d" v1.0.0 a.deb SHA256SUMS.txt; cat "$d/a.deb" "$d/SHA256SUMS.txt"');
    expect(out.stdout).toBe('GitHub\ngh-debgh-sums');
  });

  it('takes every file from AI17Z Code when GitHub lacks one, never a mix', () => {
    // GitHub has the package and not the checksums: a mix would check GitHub's
    // package against AI17Z Code's sums, which works and explains nothing.
    const curl = fakeCurl({ [`${GH}/a.deb`]: 'gh-deb', [`${FJ}/a.deb`]: 'fj-deb', [`${FJ}/SHA256SUMS.txt`]: 'fj-sums' });
    const out = run(curl, 'd=$(mktemp -d); ai17z_fetch_release_files "$d" v1.0.0 a.deb SHA256SUMS.txt; cat "$d/a.deb" "$d/SHA256SUMS.txt"');
    expect(out.stdout).toBe('AI17Z Code\nfj-debfj-sums');
  });

  it('says nothing and fails when no source has them', () => {
    const out = run(fakeCurl({}), 'd=$(mktemp -d); ai17z_fetch_release_files "$d" v1.0.0 a.deb; echo "status $?"; ls "$d" | wc -l');
    expect(out.stdout.trim().split('\n')).toEqual(['status 1', '0']);
  });

  it('follows a redirect to GitHub\'s storage host and refuses one anywhere else', () => {
    const storage = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2';
    const good = run(fakeCurl({ [`${GH}/a.deb`]: { body: 'gh', landed: storage } }), 'd=$(mktemp -d); ai17z_fetch "$d/a" "' + GH + '/a.deb"; echo "status $?"; cat "$d/a"');
    expect(good.stdout).toBe('status 0\ngh');
    const bad = run(fakeCurl({ [`${GH}/a.deb`]: { body: 'evil', landed: 'https://example.net/a.deb' } }), 'd=$(mktemp -d); ai17z_fetch "$d/a" "' + GH + '/a.deb"; echo "status $?"; ls "$d" | wc -l');
    expect(bad.stdout.trim().split('\n')).toEqual(['status 2', '0']);
  });

  it('refuses a host before asking it, including one that only ends like GitHub', () => {
    const out = run(fakeCurl({}), [
      'ai17z_url_allowed https://github.com.example.net/x; echo $?',
      'ai17z_url_allowed http://github.com/x; echo $?',
      'ai17z_url_allowed https://code.ai17z.io/x; echo $?',
    ].join('\n'));
    expect(out.stdout.trim().split('\n')).toEqual(['1', '1', '0']);
  });

  it('asks AI17Z Code for the newest tag when GitHub refuses', () => {
    const list = JSON.stringify([{ tag_name: 'v1.0.0', assets: [{ name: 'a_1.0.0.deb' }] }]);
    const curl = fakeCurl({ 'https://code.ai17z.io/api/v1/repos/AI17Z/ai17z/releases?limit=10': list });
    const out = run(curl, "ai17z_latest_release_tag 'a_<version>.deb'");
    expect(out.stdout.trim()).toBe('v1.0.0');
  });
});
