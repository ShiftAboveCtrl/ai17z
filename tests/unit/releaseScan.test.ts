/**
 * @release-check-fixtures
 *
 * The release asset scan accepts an installer only through a hash-proven
 * exemption: its extracted contents must match the application zip byte for
 * byte, and a hit in third-party bytes is excused only when the exact bytes are
 * proved to have come from upstream. Everything below is invented and assembled
 * at run time, exactly like the scanner it tests: `blartwick` stands for a
 * username and `fizzbin-node` for a machine, and neither names anybody.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { entryPoints, PRUNED_DIRECTORIES, PRUNED_FILE, pruneDependencies, referenced } from '../../tools/pruneDependencies.mjs';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const NAME = 'blart' + 'wick';
const HOST = 'fizz' + 'bin-node';
const leaks = (value: unknown) => new RegExp(`${NAME}|${HOST}`, 'i').test(JSON.stringify(value));

/** An interpreter, asked to run, because on Windows `python3` is often a stub that prints an error. */
function find(candidates: string[], probe: string[]): string | undefined {
  for (const candidate of candidates) {
    if (spawnSync(candidate, probe, { encoding: 'utf8' }).status === 0) return candidate;
  }
  return undefined;
}
const python = find(['python3', 'python'], ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']);
if (!python) console.warn('releaseScan.test: no Python 3, so the scanner tests below are SKIPPED, which is not a pass');

const room = () => mkdtempSync(join(tmpdir(), 'release-scan-'));
const py = (script: string, ...args: string[]) => {
  const done = spawnSync(python!, ['-c', script, ...args], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`python helper failed: ${done.stderr}`);
};

describe('the installer is unpacked and cross-checked, not waved through', () => {
  const releaseYml = read('.github/workflows/release.yml');
  const identifiers = read('ci/scripts/private-identifiers.sh');

  it('installs the pinned innoextract, not the Ubuntu one that stops at Inno Setup 6.0.5', () => {
    expect(releaseYml).toContain('sudo bash ci/scripts/setup-innoextract.sh');
    expect(releaseYml).not.toMatch(/apt-get install[^\n]* innoextract/);
  });

  it('refuses an installer it cannot unpack, or that unpacks nothing', () => {
    expect(identifiers).toContain('REFUSED: innoextract is not installed');
    expect(identifiers).toContain('REFUSED: innoextract could not unpack the installer');
    expect(identifiers).toContain('REFUSED: innoextract unpacked nothing');
  });

  it('cross-checks every unpacked installer against the application zip released with it', () => {
    expect(identifiers).toContain('installer_matches_zip.py');
    expect(identifiers).toContain('app_zip_for');
    expect(identifiers).toContain('REFUSED: the unpacked installer is not the application zip released with it');
  });

  it('keeps the innoextract log rather than printing it, because file names are what the scan withholds', () => {
    // The log is written to a file and only the count of its warnings is read;
    // the names innoextract lists are never echoed to the release log.
    expect(identifiers).toContain('innoextract-$n.log');
    expect(identifiers).not.toMatch(/cat[^\n]*innoextract-\$n\.log/);
  });

  it('adds the proof flags only when the trust-root files exist, and names the proof cache', () => {
    expect(identifiers).toContain('--proof-cache "$ROOM/proofs"');
    expect(identifiers).toContain('[ -f "$ROOT/package-lock.json" ] && PROVE+=(--prove-npm "$ROOT/package-lock.json")');
    expect(identifiers).toContain('[ -f "$ROOT/packaging/node-runtime.json" ] && PROVE+=(--prove-node "$ROOT/packaging/node-runtime.json")');
  });
});

describe('the innoextract pin is a pinned source archive, verified before it is built', () => {
  const setup = read('ci/scripts/setup-innoextract.sh');

  it('pins a commit and the archive sha256', () => {
    const commit = /^COMMIT=([0-9a-f]{40})$/m.exec(setup)?.[1];
    const sha = /^SOURCE_SHA256=([0-9a-f]{64})$/m.exec(setup)?.[1];
    expect(commit, 'a full commit id is not pinned').toBeTruthy();
    expect(sha, 'an archive sha256 is not pinned').toBeTruthy();
  });

  it('builds from that archive and refuses a mismatch rather than building whatever arrives', () => {
    expect(setup).toContain('curl -fsSL --proto \'=https\' --tlsv1.2');
    expect(setup).toContain('sha256sum -c -');
    expect(setup).toContain('REFUSED: the innoextract source archive does not have the pinned SHA-256');
  });

  it('checks the built binary says what it reads, so a quietly different build is caught', () => {
    expect(setup).toContain('READS="to 7.0.2"');
    expect(setup).toContain('innoextract --version');
    expect(setup).toContain('REFUSED: the built innoextract does not say it reads Inno Setup');
  });
});

describe('installer_matches_zip.py', () => {
  const script = resolve(root, 'ci/scripts/installer_matches_zip.py');

  const zipScript = [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)',
    'z.writestr(sys.argv[2], sys.argv[3])',
    'z.writestr("sub/" + sys.argv[2], "dir file\\n")',
    'z.close()',
  ].join('\n');

  it.skipIf(!python)('accepts a directory holding every zip file byte for byte', () => {
    const dir = room();
    try {
      const zip = join(dir, 'app.zip');
      const app = join(dir, 'app');
      mkdirSync(join(app, 'sub'), { recursive: true });
      const body = 'top file\n';
      writeFileSync(join(app, 'a.txt'), body);
      writeFileSync(join(app, 'sub', 'a.txt'), 'dir file\n');
      py(zipScript, zip, 'a.txt', body);
      const result = spawnSync(python!, [script, zip, app], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('application zip: 2 files');
      expect(result.stdout).toContain('missing from the installer: 0');
      expect(result.stdout).toContain('different: 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)('refuses a file of the zip the installer lacks, or one whose bytes differ', () => {
    const dir = room();
    try {
      const zip = join(dir, 'app.zip');
      const body = 'top file\n';
      py(zipScript, zip, 'a.txt', body);

      const missing = join(dir, 'missing');
      mkdirSync(join(missing, 'sub'), { recursive: true });
      writeFileSync(join(missing, 'a.txt'), body);
      const noSub = spawnSync(python!, [script, zip, missing], { encoding: 'utf8' });
      expect(noSub.status).toBe(1);
      expect(noSub.stdout).toContain('missing from the installer: 1');

      const changed = join(dir, 'changed');
      mkdirSync(join(changed, 'sub'), { recursive: true });
      writeFileSync(join(changed, 'a.txt'), 'different bytes\n');
      writeFileSync(join(changed, 'sub', 'a.txt'), 'dir file\n');
      const diff = spawnSync(python!, [script, zip, changed], { encoding: 'utf8' });
      expect(diff.status).toBe(1);
      expect(diff.stdout).toContain('different: 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)('refuses an installer that unpacked no application directory', () => {
    const dir = room();
    try {
      const zip = join(dir, 'app.zip');
      py(zipScript, zip, 'a.txt', 'top\n');
      const result = spawnSync(python!, [script, zip, join(dir, 'no-app-here')], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('no application directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)('prints counts only, never a file name', () => {
    const dir = room();
    try {
      const zip = join(dir, 'app.zip');
      const named = `a_${NAME}.txt`;
      py(zipScript, zip, named, 'top\n');
      // The directory exists, so the comparison runs and prints counts; the zip
      // member's name is itself an identifier and must never appear in them.
      const app = join(dir, 'app');
      mkdirSync(app, { recursive: true });
      const result = spawnSync(python!, [script, zip, app], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/application zip: \d+ files/);
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)('reports files only in the installer, which the zip does not have', () => {
    const dir = room();
    try {
      const zip = join(dir, 'app.zip');
      const app = join(dir, 'app');
      mkdirSync(join(app, 'sub'), { recursive: true });
      writeFileSync(join(app, 'a.txt'), 'top file\n');
      writeFileSync(join(app, 'sub', 'a.txt'), 'dir file\n');
      writeFileSync(join(app, 'extra.txt'), 'installer only\n');
      py(zipScript, zip, 'a.txt', 'top file\n');
      const result = spawnSync(python!, [script, zip, app], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('installer-only: 1');
      expect(result.stdout).toContain('copies of zip files: 0; unproven: 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)('proves an installer-only file that is a byte for byte copy of a zip file, anywhere in the output', () => {
    const dir = room();
    try {
      const zip = join(dir, 'app.zip');
      const whole = join(dir, 'out');
      const app = join(whole, 'app');
      mkdirSync(join(app, 'sub'), { recursive: true });
      mkdirSync(join(app, 'linked', 'deep'), { recursive: true });
      writeFileSync(join(app, 'a.txt'), 'top file\n');
      writeFileSync(join(app, 'sub', 'a.txt'), 'dir file\n');
      // Inno Setup follows a symlink the zip skipped: a second copy of a zip file.
      writeFileSync(join(app, 'linked', 'deep', 'copy.txt'), 'dir file\n');
      // Outside app/ as well, and one that is nobody's copy.
      writeFileSync(join(whole, 'launcher.cmd'), 'top file\n');
      writeFileSync(join(whole, 'stranger.txt'), 'in neither\n');
      py(zipScript, zip, 'a.txt', 'top file\n');
      const result = spawnSync(python!, [script, zip, app, whole], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('installer-only: 3; copies of zip files: 2; unproven: 1');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a hit in third-party bytes is excused by proof and nothing else', () => {
  const scan = resolve(root, 'ci/scripts/privacy_scan.py');
  const LIST = [`hostname\t(?i)\\b${HOST}\\b`].join('\n');
  const emptyHome = () => {
    const h = mkdtempSync(join(tmpdir(), 'release-scan-home-'));
    return h;
  };

  it.skipIf(!python)('refuses when the proof cannot be made: a source outside the allowed host stays a finding', () => {
    const dir = room();
    const home = emptyHome();
    try {
      const app = join(dir, 'app');
      mkdirSync(join(app, 'node_modules', 'leaky'), { recursive: true });
      writeFileSync(join(app, 'node_modules', 'leaky', 'readme.md'), `built on ${HOST}\n`);
      // A lockfile that pins a tarball on a host the scan refuses to fetch from,
      // so the proof fails without touching the network and the hit must stand.
      const integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
      const lock = {
        lockfileVersion: 3,
        packages: {
          'node_modules/leaky': {
            name: 'leaky',
            version: '1.0.0',
            resolved: 'https://example.invalid/leaky-1.0.0.tgz',
            integrity,
          },
        },
      };
      writeFileSync(join(dir, 'lock.json'), JSON.stringify(lock));
      const result = spawnSync(
        python!,
        [scan, '--ci', '--checks', 'identifiers', '--lenient', 'node_modules=home-path', '--prove-npm', join(dir, 'lock.json'), 'path', app],
        { encoding: 'utf8', env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, HOME: home, USERPROFILE: home } },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('hostname');
      expect(result.stdout).toContain('not proven upstream');
      expect(result.stdout).not.toContain('exempt, proven upstream bytes');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A lockfile link ("link": true) that the stager replaced with a real copy:
  // node_modules/outer/node_modules/leaky is a link to packages/compat, the copy
  // carries its own node_modules/leaky, and that file is the registry package
  // node_modules/leaky, whose tarball is pre-seeded in the proof cache so no
  // network is touched. The same shape as the faker override in Beta 0.94.
  const linkRoom = (opts: { target?: string; withTarget?: boolean; innerPath?: string; bytes?: string }) => {
    const dir = room();
    const home = emptyHome();
    const app = join(dir, 'app');
    const cache = join(dir, 'cache');
    mkdirSync(cache, { recursive: true });
    const inner = opts.innerPath ?? 'node_modules/leaky/readme.md';
    const copy = join(app, 'node_modules', 'outer', 'node_modules', 'leaky');
    mkdirSync(join(copy, ...inner.split('/').slice(0, -1)), { recursive: true });
    const upstream = `built on ${HOST}\n`;
    writeFileSync(join(copy, ...inner.split('/')), opts.bytes ?? upstream);
    writeFileSync(join(dir, 'patterns.txt'), LIST);
    py(
      [
        'import io, sys, json, tarfile, hashlib, base64',
        'dir, host, target, with_target = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"',
        'data = ("built on " + host + "\\n").encode()',
        'buf = io.BytesIO()',
        't = tarfile.open(fileobj=buf, mode="w:gz")',
        'info = tarfile.TarInfo("package/readme.md"); info.size = len(data)',
        't.addfile(info, io.BytesIO(data)); t.close()',
        'raw = buf.getvalue()',
        'digest = hashlib.sha512(raw).digest()',
        'open(dir + "/cache/npm-" + digest.hex() + ".tgz", "wb").write(raw)',
        'packages = {',
        '    "node_modules/leaky": {"name": "leaky", "version": "1.0.0", "resolved": "https://registry.npmjs.org/leaky/-/leaky-1.0.0.tgz", "integrity": "sha512-" + base64.b64encode(digest).decode()},',
        '    "node_modules/outer/node_modules/leaky": {"resolved": target, "link": True},',
        '}',
        'if with_target: packages[target] = {"name": "compat", "version": "1.0.0"}',
        'open(dir + "/lock.json", "w").write(json.dumps({"lockfileVersion": 3, "packages": packages}))',
      ].join('\n'),
      dir, HOST, opts.target ?? 'packages/compat', opts.withTarget === false ? '0' : '1',
    );
    const run = () =>
      spawnSync(
        python!,
        [scan, '--checks', 'identifiers', '--patterns', join(dir, 'patterns.txt'), '--lenient', 'node_modules=home-path', '--prove-npm', join(dir, 'lock.json'), '--proof-cache', cache, 'path', app],
        { encoding: 'utf8', env: { ...process.env, PRIVATE_IDENTIFIERS: '', HOME: home, USERPROFILE: home } },
      );
    return {
      run,
      clean: () => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      },
    };
  };

  it.skipIf(!python)('proves a file inside a materialized link against the registry tarball of the package it really is', () => {
    const r = linkRoom({});
    try {
      const result = r.run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('exempt, proven upstream bytes');
      expect(result.stdout).toContain('leaky@1.0.0');
      expect(result.stdout).toContain('findings 0');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      r.clean();
    }
  });

  it.skipIf(!python)('still refuses the same path inside a materialized link when one byte differs', () => {
    const r = linkRoom({ bytes: `built on ${HOST}\nx` });
    try {
      const result = r.run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('hostname');
      expect(result.stdout).toContain('not proven upstream');
      expect(result.stdout).toContain('differs from leaky@1.0.0');
      expect(result.stdout).not.toContain('exempt, proven upstream bytes');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      r.clean();
    }
  });

  it.skipIf(!python)('still refuses a link whose target the lockfile does not describe', () => {
    const r = linkRoom({ withTarget: false });
    try {
      const result = r.run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('not proven upstream');
      expect(result.stdout).toContain('which package-lock.json does not describe');
      expect(result.stdout).not.toContain('exempt, proven upstream bytes');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      r.clean();
    }
  });

  it.skipIf(!python)('still refuses a link that leaves the repository, however well the bytes would match', () => {
    const r = linkRoom({ target: '../elsewhere' });
    try {
      const result = r.run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('not proven upstream');
      expect(result.stdout).not.toContain('exempt, proven upstream bytes');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      r.clean();
    }
  });

  it.skipIf(!python)('treats the linked package\'s own files as ours: only its dependencies are provable', () => {
    const r = linkRoom({ innerPath: 'readme.md' });
    try {
      const result = r.run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('belongs to that local package');
      expect(result.stdout).not.toContain('exempt, proven upstream bytes');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      r.clean();
    }
  });

  it.skipIf(!python)('excuses a file under runtime/node only when its bytes match the pinned Node tarball', () => {
    const dir = room();
    const home = emptyHome();
    try {
      const dist = join(dir, 'dist');
      const app = join(dir, 'app');
      mkdirSync(dist, { recursive: true });
      mkdirSync(join(app, 'runtime', 'node', 'bin'), { recursive: true });
      const body = `built on ${HOST}\n`;
      writeFileSync(join(app, 'runtime', 'node', 'bin', 'node'), body);
      writeFileSync(join(dir, 'patterns.txt'), LIST);
      writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ version: 'v1.2.3' }));
      py(
        [
          'import io, sys, tarfile, hashlib',
          'dist, hostname = sys.argv[1], sys.argv[2]',
          'data = ("built on " + hostname + "\\n").encode()',
          'buf = io.BytesIO()',
          't = tarfile.open(fileobj=buf, mode="w:gz")',
          'info = tarfile.TarInfo("node-v1.2.3-linux-x64/bin/node"); info.size = len(data)',
          't.addfile(info, io.BytesIO(data)); t.close()',
          'raw = buf.getvalue()',
          'open(dist + "/node-v1.2.3-linux-x64.tar.gz", "wb").write(raw)',
          'open(dist + "/SHASUMS256.txt", "w").write(hashlib.sha256(raw).hexdigest() + "  node-v1.2.3-linux-x64.tar.gz\\n")',
        ].join('\n'),
        dist, HOST,
      );
      const run = (args: string[]) =>
        spawnSync(python!, [scan, '--checks', 'identifiers', ...args, 'path', app], {
          encoding: 'utf8',
          env: { ...process.env, PRIVATE_IDENTIFIERS: '', HOME: home, USERPROFILE: home },
        });

      const clean = run(['--patterns', join(dir, 'patterns.txt'), '--prove-node', join(dir, 'runtime.json'), '--node-dist', dist]);
      expect(clean.status, clean.stderr).toBe(0);
      expect(clean.stdout).toContain('exempt, proven upstream bytes');
      expect(clean.stdout).toContain('findings 0');

      // One byte different is ours, not upstream's, and refuses exactly as before.
      writeFileSync(join(app, 'runtime', 'node', 'bin', 'node'), body + 'x');
      const edited = run(['--patterns', join(dir, 'patterns.txt'), '--prove-node', join(dir, 'runtime.json'), '--node-dist', dist]);
      expect(edited.status).toBe(1);
      expect(edited.stdout).toContain('not proven upstream');
      expect(edited.stdout).not.toContain('exempt, proven upstream bytes');
      expect(leaks(edited.stdout)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)('scans the slack after a proven zip member, not the header claim', () => {
    const dir = room();
    const home = emptyHome();
    try {
      const dist = join(dir, 'dist');
      const app = join(dir, 'app');
      mkdirSync(dist, { recursive: true });
      mkdirSync(app, { recursive: true });
      const zip = join(app, 'app.zip');
      // A Node tarball for the proof, then a zip whose two members carry the
      // tarball's bytes (which themselves carry the hostname, so the proof fires
      // and exempts them) but claim more: a deflate member with slack after its
      // end-of-stream, and a stored member with slack past its file size. The
      // slack also holds the hostname, which is the byte the old span hid.
      py(
        [
          'import io, sys, struct, tarfile, hashlib, zlib, zipfile',
          'dist, zip_path, host = sys.argv[1], sys.argv[2], sys.argv[3]',
          'content = b"built on " + host.encode() + b"\\n"',
          'buf = io.BytesIO()',
          't = tarfile.open(fileobj=buf, mode="w:gz")',
          'for name in ("bin/node", "bin/helper"):',
          '    info = tarfile.TarInfo("node-v1.2.3-linux-x64/" + name); info.size = len(content)',
          '    t.addfile(info, io.BytesIO(content))',
          't.close()',
          'raw = buf.getvalue()',
          'open(dist + "/node-v1.2.3-linux-x64.tar.gz", "wb").write(raw)',
          'open(dist + "/SHASUMS256.txt", "w").write(hashlib.sha256(raw).hexdigest() + "  node-v1.2.3-linux-x64.tar.gz\\n")',
          'le16 = lambda n: struct.pack("<H", n)',
          'le32 = lambda n: struct.pack("<I", n)',
          'LH = b"PK" + le16(0x0403)',
          'CH = b"PK" + le16(0x0201)',
          'EOCD = b"PK" + le16(0x0605)',
          'def member(name, method, data, slack, offset):',
          '    crc = zlib.crc32(data) & 0xffffffff',
          '    if method == zipfile.ZIP_DEFLATED:',
          '        co = zlib.compressobj(9, zlib.DEFLATED, -15)',
          '        comp = co.compress(data) + co.flush()',
          '    else:',
          '        comp = data',
          '    comp += slack',
          '    nb = name.encode()',
          '    lh = LH + le16(20) + le16(0) + le16(method) + le16(0) + le16(0) + le32(crc) + le32(len(comp)) + le32(len(data)) + le16(len(nb)) + le16(0)',
          '    ch = CH + le16(20) + le16(20) + le16(0) + le16(method) + le16(0) + le16(0) + le32(crc) + le32(len(comp)) + le32(len(data)) + le16(len(nb)) + le16(0) + le16(0) + le16(0) + le16(0) + le32(0) + le32(offset) + nb',
          '    return lh + nb + comp, ch',
          'local = b""',
          'central = b""',
          'for name, method, data, slack in [',
          '    ("runtime/node/bin/node", zipfile.ZIP_DEFLATED, content, b"deflate slack built on " + host.encode() + b"\\n"),',
          '    ("runtime/node/bin/helper", zipfile.ZIP_STORED, content, b"stored slack built on " + host.encode() + b"\\n"),',
          ']:',
          '    lh, ch = member(name, method, data, slack, len(local))',
          '    local += lh',
          '    central += ch',
          'open(zip_path, "wb").write(local + central + EOCD + le16(0) + le16(0) + le16(2) + le16(2) + le32(len(central)) + le32(len(local)) + le16(0))',
        ].join('\n'),
        dist, zip, HOST,
      );
      writeFileSync(join(dir, 'patterns.txt'), LIST);
      writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ version: 'v1.2.3' }));
      const result = spawnSync(
        python!,
        [scan, '--checks', 'identifiers', '--patterns', join(dir, 'patterns.txt'), '--prove-node', join(dir, 'runtime.json'), '--node-dist', dist, 'path', app],
        { encoding: 'utf8', env: { ...process.env, PRIVATE_IDENTIFIERS: '', HOME: home, USERPROFILE: home } },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain('hostname');
      expect(result.stdout).toContain('exempt, proven upstream bytes');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The three shapes that hid slack at b42ba90d, and the honest shapes that
  // must stay exempted. One Node-proof setup, then a zip per shape: the member
  // is proved byte-for-byte, so only the slack is ours.
  const nodeProof = (dist: string) => {
    py(
      [
        'import io, sys, tarfile, hashlib',
        'dist, host = sys.argv[1], sys.argv[2]',
        'content = b"built on " + host.encode() + b"\\n"',
        'buf = io.BytesIO()',
        't = tarfile.open(fileobj=buf, mode="w:gz")',
        'for name in ("bin/node", "bin/helper"):',
        '    info = tarfile.TarInfo("node-v1.2.3-linux-x64/" + name); info.size = len(content)',
        '    t.addfile(info, io.BytesIO(content))',
        't.close()',
        'raw = buf.getvalue()',
        'open(dist + "/node-v1.2.3-linux-x64.tar.gz", "wb").write(raw)',
        'open(dist + "/SHASUMS256.txt", "w").write(hashlib.sha256(raw).hexdigest() + "  node-v1.2.3-linux-x64.tar.gz\\n")',
      ].join('\n'),
      dist, HOST,
    );
  };

  const buildZip = (zipPath: string, scenario: string) => {
    py(
      [
        'import sys, struct, zlib, bz2',
        'zip_path, host, scenario = sys.argv[1], sys.argv[2], sys.argv[3]',
        'content = b"built on " + host.encode() + b"\\n"',
        'slack = b"SLACK built on " + host.encode() + b"\\n"',
        'le16 = lambda n: struct.pack("<H", n)',
        'le32 = lambda n: struct.pack("<I", n)',
        'LH = b"PK" + le16(0x0403)',
        'CH = b"PK" + le16(0x0201)',
        'EOCD = b"PK" + le16(0x0605)',
        'crc = zlib.crc32(content) & 0xFFFFFFFF',
        'def raw_deflate(b):',
        '    co = zlib.compressobj(9, zlib.DEFLATED, -15)',
        '    return co.compress(b) + co.flush()',
        'def stored_blocks(parts):',
        '    out = b""',
        '    for i, p in enumerate(parts):',
        '        out += bytes([1 if i == len(parts) - 1 else 0]) + le16(len(p)) + le16(len(p) ^ 0xFFFF) + p',
        '    return out',
        'def build(entries):',
        '    local = b""',
        '    central = b""',
        '    for name, method, comp, csize, fsize in entries:',
        '        nb = name.encode()',
        '        off = len(local)',
        '        lh = LH + le16(20) + le16(0) + le16(method) + le16(0) + le16(0) + le32(crc) + le32(csize) + le32(fsize) + le16(len(nb)) + le16(0)',
        '        local += lh + nb + comp',
        '        central += CH + le16(20) + le16(20) + le16(0) + le16(method) + le16(0) + le16(0) + le32(crc) + le32(csize) + le32(fsize) + le16(len(nb)) + le16(0) + le16(0) + le16(0) + le16(0) + le32(0) + le32(off) + nb',
        '    return local + central + EOCD + le16(0) + le16(0) + le16(len(entries)) + le16(len(entries)) + le32(len(central)) + le32(len(local)) + le16(0)',
        'N = "runtime/node/bin/node"',
        'H = "runtime/node/bin/helper"',
        'stream = stored_blocks([content, slack])',
        'bz = bz2.compress(content) + slack',
        'dh = raw_deflate(content)',
        'entries = {',
        '    "a": [(N, 0, content + slack, len(content), len(content) + len(slack))],',
        '    "b": [(N, 8, stream, len(stream), len(content))],',
        '    "c": [(N, 12, bz, len(bz), len(content))],',
        '    "honest": [(N, 0, content, len(content), len(content)), (H, 8, dh, len(dh), len(content))],',
        '}[scenario]',
        'open(zip_path, "wb").write(build(entries))',
      ].join('\n'),
      zipPath, HOST, scenario,
    );
  };

  const scanZip = (scenario: string) => {
    const dir = room();
    const home = emptyHome();
    try {
      const dist = join(dir, 'dist');
      const app = join(dir, 'app');
      mkdirSync(dist, { recursive: true });
      mkdirSync(app, { recursive: true });
      nodeProof(dist);
      buildZip(join(app, 'app.zip'), scenario);
      writeFileSync(join(dir, 'patterns.txt'), LIST);
      writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ version: 'v1.2.3' }));
      return spawnSync(
        python!,
        [scan, '--checks', 'identifiers', '--patterns', join(dir, 'patterns.txt'), '--prove-node', join(dir, 'runtime.json'), '--node-dist', dist, 'path', app],
        { encoding: 'utf8', env: { ...process.env, PRIVATE_IDENTIFIERS: '', HOME: home, USERPROFILE: home } },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };

  it.skipIf(!python)('leaves slack past a stored member whose central file size exceeds its compressed size unmasked', () => {
    const result = scanZip('a');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('hostname');
    expect(result.stdout).toContain('exempt, proven upstream bytes');
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('leaves the extra stored block of a deflate member unmasked', () => {
    const result = scanZip('b');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('hostname');
    expect(result.stdout).toContain('exempt, proven upstream bytes');
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('leaves slack past a bzip2 member unmasked', () => {
    const result = scanZip('c');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('hostname');
    expect(result.stdout).toContain('exempt, proven upstream bytes');
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('still exempts an honest stored and an honest deflate member', () => {
    const result = scanZip('honest');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('exempt, proven upstream bytes');
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('refuses a local checksum source under --ci, where nodejs.org alone is the trust root', () => {
    const home = emptyHome();
    try {
      const result = spawnSync(python!, [scan, '--ci', '--checks', 'identifiers', '--node-dist', join(home, 'dist'), 'path', home], {
        encoding: 'utf8',
        env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, HOME: home, USERPROFILE: home },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('nodejs.org only');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('pruneDependencies', () => {
  it('normalises every path a package.json points at, without a leading ./', () => {
    expect(
      entryPoints({
        main: './index.js',
        browser: './browser.js',
        exports: { '.': { types: './docs/api.d.ts', import: './index.mjs' } },
        directories: { lib: './src' },
      }),
    ).toEqual(expect.arrayContaining(['index.js', 'browser.js', 'docs/api.d.ts', 'index.mjs', 'src']));
    expect(entryPoints('not an object')).toEqual([]);
  });

  it('sees a real reference to a directory, and leaves a bare string alone', () => {
    expect(referenced('docs', true, "import x from 'docs/guide.mjs'")).toBe(true);
    expect(referenced('docs', true, "const p = require('./docs/guide.mjs')")).toBe(true);
    expect(referenced('docs', true, "join(__dirname, 'docs')")).toBe(true);
    // `NODE_ENV === 'test'` is in half the packages on npm: a string, not a path.
    expect(referenced('test', true, "NODE_ENV === 'test'")).toBe(false);
    expect(referenced('README.md', false, "readFile('README.md')")).toBe(true);
  });

  it('sees __dirname concatenated or interpolated before a directory name', () => {
    expect(referenced('docs', true, "__dirname + '/docs'")).toBe(true);
    expect(referenced('docs', true, '`${__dirname}/docs`')).toBe(true);
    expect(referenced('docs', true, "resolve(__dirname, '/docs')")).toBe(true);
  });

  it('sees a bare relative require or import, and file names without case', () => {
    expect(referenced('docs', true, "require('./docs')")).toBe(true);
    expect(referenced('test', true, "import './test'")).toBe(true);
    expect(referenced('docs', true, 'require(`./docs`)')).toBe(true);
    expect(referenced('README.md', false, "readFile('readme.md')")).toBe(true);
  });

  it('names the fixed set, so a removal is a decision rather than an extension list nobody owns', () => {
    for (const kept of ['docs', 'test', '.github', 'coverage']) expect(PRUNED_DIRECTORIES.has(kept)).toBe(true);
    expect(PRUNED_FILE.test('README.md')).toBe(true);
    expect(PRUNED_FILE.test('CHANGELOG')).toBe(true);
    // LICENSE and NOTICE are never touched: removing one is a licence problem.
    expect(PRUNED_FILE.test('LICENSE')).toBe(false);
    expect(PRUNED_FILE.test('NOTICE')).toBe(false);
  });

  it('prunes documentation and tests, and keeps what package.json or code still loads', async () => {
    const dir = room();
    try {
      const modules = join(dir, 'node_modules');
      mkdirSync(join(modules, 'pkg-a', 'docs'), { recursive: true });
      mkdirSync(join(modules, 'pkg-a', 'test'), { recursive: true });
      mkdirSync(join(modules, 'pkg-a', 'lib'), { recursive: true });
      writeFileSync(join(modules, 'pkg-a', 'package.json'), JSON.stringify({ name: 'pkg-a', main: 'index.js' }));
      writeFileSync(join(modules, 'pkg-a', 'index.js'), "// NODE_ENV === 'test'\n");
      writeFileSync(join(modules, 'pkg-a', 'README.md'), 'readme\n');
      writeFileSync(join(modules, 'pkg-a', 'LICENSE'), 'MIT\n');
      writeFileSync(join(modules, 'pkg-a', 'docs', 'guide.md'), 'docs\n');
      writeFileSync(join(modules, 'pkg-a', 'test', 'x.js'), 'test\n');
      writeFileSync(join(modules, 'pkg-a', 'lib', 'kept.js'), 'code\n');

      mkdirSync(join(modules, 'pkg-b', 'docs'), { recursive: true });
      writeFileSync(
        join(modules, 'pkg-b', 'package.json'),
        JSON.stringify({ name: 'pkg-b', exports: { '.': { types: './docs/api.d.ts', default: './index.js' } } }),
      );
      writeFileSync(join(modules, 'pkg-b', 'index.js'), '');
      writeFileSync(join(modules, 'pkg-b', 'docs', 'api.d.ts'), 'kept\n');

      const result = await pruneDependencies(modules);
      expect(result.removed).toEqual(
        expect.arrayContaining(['node_modules/pkg-a/README.md', 'node_modules/pkg-a/docs', 'node_modules/pkg-a/test']),
      );
      expect(result.kept).toContain('node_modules/pkg-b/docs');
      // A file the runtime loads, and the licence, are never touched.
      expect(existsSync(join(modules, 'pkg-a', 'lib', 'kept.js'))).toBe(true);
      expect(existsSync(join(modules, 'pkg-a', 'LICENSE'))).toBe(true);
      expect(existsSync(join(modules, 'pkg-b', 'docs', 'api.d.ts'))).toBe(true);
      expect(existsSync(join(modules, 'pkg-a', 'docs'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
