import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Packages for processors AI17Z Code has no runner of are assembled elsewhere
 * and proved against natively built references, and a machine whose package a
 * release lacks takes the newest release that has one. Both are shell, run
 * here as shipped.
 */

const root = resolve(__dirname, '..', '..');
const hasBash = !spawnSync('bash', ['--version']).error;
const room = mkdtempSync(join(tmpdir(), 'ai17z-natives-'));
afterAll(() => rmSync(room, { recursive: true, force: true }));

const bash = (script: string, cwd = room) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8' });
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

// The first bytes are what make a file native to the prover, never its name.
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

/** A macOS-shaped package: AI17Z/runtime and AI17Z/app, as build-tarball.sh lays it out. */
function tarball(name: string, files: Record<string, Buffer | string>): string {
  const dir = join(room, `${name}-tree`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, 'AI17Z', path, '..'), { recursive: true });
    writeFileSync(join(dir, 'AI17Z', path), body);
  }
  const made = bash(`tar -czf ${name}.tar.gz -C ${name}-tree AI17Z`);
  expect(made.status, made.stderr).toBe(0);
  return `${name}.tar.gz`;
}

const prove = (candidate: string, reference: string) =>
  bash(`bash "${posix(join(root, '.forgejo/scripts/prove-natives.sh'))}" ${candidate} ${reference}`);

const native = (tag: string) => Buffer.concat([MACHO, Buffer.from(tag)]);
const reference = {
  'runtime/node/bin/node': native('node 22.23.2'),
  'app/node_modules/@esbuild/darwin-arm64/bin/esbuild': native('esbuild 0.28.2'),
  'app/server.js': 'console.log("not native")',
};

describe.skipIf(!hasBash)('prove-natives.sh', () => {
  const ref = tarball('reference', reference);

  it('passes a package whose native files are the reference\'s, whatever else changed', () => {
    const candidate = tarball('same', { ...reference, 'app/server.js': 'console.log("a newer release")' });
    const run = prove(candidate, ref);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('all 2 native files are byte for byte the reference');
  });

  it('refuses a native file that differs, with its own exit code', () => {
    const candidate = tarball('differs', { ...reference, 'runtime/node/bin/node': native('node 22.24.0') });
    const run = prove(candidate, ref);
    expect(run.status).toBe(3);
    expect(run.stdout).toContain('runtime/node/bin/node differs from the reference');
    expect(run.stdout).toContain('Nothing was published');
  });

  it('refuses a native file the reference never had, whatever it is called', () => {
    const candidate = tarball('extra', { ...reference, 'app/node_modules/new/readme.txt': native('a binary named like text') });
    const run = prove(candidate, ref);
    expect(run.status).toBe(3);
    expect(run.stdout).toContain('app/node_modules/new/readme.txt is new');
  });

  it('refuses a package missing one the reference has', () => {
    const { ['app/node_modules/@esbuild/darwin-arm64/bin/esbuild']: _gone, ...rest } = reference;
    const run = prove(tarball('missing', rest), ref);
    expect(run.status).toBe(3);
    expect(run.stdout).toContain('is in the reference and missing here');
  });

  it('pins the references it is given by hash', () => {
    const refs = JSON.parse(readFileSync(join(root, '.forgejo/native-references.json'), 'utf8')) as Record<string, { sha256: string }>;
    const job = readFileSync(join(root, '.forgejo/scripts/package-assembled.sh'), 'utf8');
    expect(Object.keys(refs).filter((key) => key !== '_').sort()).toEqual(['macos-arm64', 'macos-x64', 'ubuntu-arm64']);
    expect(job).toContain('[ "$got" = "$REF_SHA" ]');
  });
});

// Forgejo's list, newest first. The newest has no Mac package, and its body
// names one inside a quotation, which must not count as publishing it.
const releases = JSON.stringify([
  {
    tag_name: 'v1.0.0-beta.86',
    body: 'The next one will carry "AI17Z-macos-arm64-1.0.0-beta.86.tar.gz" again.',
    assets: [{ name: 'ai17z_1.0.0-beta.86_amd64.deb' }, { name: 'SHA256SUMS.txt' }],
  },
  {
    tag_name: 'v1.0.0-beta.85',
    body: '',
    assets: [{ name: 'AI17Z-macos-arm64-1.0.0-beta.85.tar.gz' }, { name: 'ai17z_1.0.0-beta.85_arm64.deb' }, { name: 'SHA256SUMS.txt' }],
  },
]);
writeFileSync(join(room, 'releases.json'), releases);

describe.skipIf(!hasBash)('the newest release this machine can install', () => {
  const helper = posix(join(root, 'packaging/unix/ai17z-paths.sh'));
  const ask = (template: string) =>
    bash(`curl() { cat releases.json; }; . "${helper}" >/dev/null 2>&1; ai17z_latest_release_tag ${template}`);

  it('is the newest release when nothing narrower is asked', () => {
    expect(ask('').stdout.trim()).toBe('v1.0.0-beta.86');
  });

  it('skips a release published without this machine\'s package, for the updaters', () => {
    expect(ask("'AI17Z-macos-arm64-<version>.tar.gz'").stdout.trim()).toBe('v1.0.0-beta.85');
    expect(ask("'ai17z_<version>_arm64.deb'").stdout.trim()).toBe('v1.0.0-beta.85');
    expect(ask("'ai17z_<version>_amd64.deb'").stdout.trim()).toBe('v1.0.0-beta.86');
  });

  it('says nothing, rather than guessing, when no release has one', () => {
    expect(ask("'AI17Z-macos-x64-<version>.tar.gz'").stdout.trim()).toBe('');
  });

  it.each(['install-ai17z-macos.sh', 'install-ai17z-ubuntu.sh'])('%s chooses the same way, and a named release is that release', (installer) => {
    const text = readFileSync(join(root, installer), 'utf8');
    const start = text.indexOf('pick_tag() {');
    const end = text.indexOf('\n}\n', start);
    expect(start, `${installer} has no pick_tag`).toBeGreaterThan(-1);
    writeFileSync(join(room, 'pick.sh'), text.slice(start, end + 3));
    const pick = (release: string, template: string) =>
      bash(`. ./pick.sh; RELEASE='${release}'; pick_tag "$(cat releases.json)" '${template}'`).stdout.trim();
    expect(pick('', 'AI17Z-macos-arm64-<version>.tar.gz')).toBe('v1.0.0-beta.85');
    expect(pick('', 'ai17z_<version>_amd64.deb')).toBe('v1.0.0-beta.86');
    expect(pick('v1.0.0-beta.86', 'AI17Z-macos-arm64-<version>.tar.gz')).toBe('v1.0.0-beta.86');
  });
});
