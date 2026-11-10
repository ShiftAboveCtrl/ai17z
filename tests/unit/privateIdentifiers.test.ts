import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findPrivateIdentifiers,
  findPrivateIdentifiersInBytes,
  IdentifierListError,
  loadPrivateIdentifiers,
  parseAllowList,
  parseIdentifierList,
  toRegExp,
} from '../../tools/privateIdentifiers';
import { checkRelease } from '../../tools/releaseCheck';

/**
 * The maintainer's private identifiers: a list that lives outside the
 * repository, read by the release check, the artifact scan and the history
 * scan.
 *
 * Every identifier here is invented. `zorblaxquin` stands for a username and
 * `quillbox-node` for a machine; neither names anybody. A real one in this file
 * would publish exactly what the file exists to stop. Anything a maintainer's
 * own gate would flag (a home path) is assembled at run time for the same
 * reason.
 */

const root = resolve(__dirname, '../..');
const NAME = 'zorblax' + 'quin';
const HOST = 'quillbox' + '-node';
const home = (who: string) => ['C:', 'Users', who].join('/');
const LIST = [
  '# invented',
  `username\t(?i)${NAME}`,
  `hostname\t\\b${HOST}\\b`,
  'home-path\t(?i)\\b[a-z]:/+users/+[a-z0-9._-]+',
  'allow:home-path\t(?i)\\b[a-z]:/+users/+someone(?![a-z0-9._-])',
  'identity\tSomebody <somebody@example.invalid>',
].join('\n');
const list = parseIdentifierList(LIST, 'test');
const file = (path: string, content: string) => ({ path, content });
const leaks = (value: unknown) => new RegExp(`${NAME}|${HOST}`, 'i').test(JSON.stringify(value));

describe('the list format, shared with the Python history scan', () => {
  it('reads classes, a leading (?i), scoped allow entries and identities', () => {
    expect(list.rules.map((r) => r.name)).toEqual(['username', 'hostname', 'home-path']);
    expect(list.rules[0]!.pattern.flags).toContain('i');
    expect([...list.allow[0]!.classes]).toEqual(['home-path']);
    expect(list.identities).toEqual(['Somebody <somebody@example.invalid>']);
  });

  it('refuses an allow entry that names no class, so nothing can excuse everything', () => {
    expect(() => parseIdentifierList('username\tx\nallow\t.*', 'l')).toThrow(IdentifierListError);
    expect(() => parseAllowList('.*', 'l')).toThrow(IdentifierListError);
    expect([...parseAllowList('lan-ip,tailscale-ip\tx', 'l')[0]!.classes]).toEqual(['lan-ip', 'tailscale-ip']);
  });

  it('refuses syntax only Python reads, rather than reading it differently', () => {
    for (const rx of ['(?P<who>x)', 'a(?i:b)', 'x\\Z', '(?s)x']) {
      expect(() => toRegExp(rx, 'rule'), rx).toThrow(IdentifierListError);
    }
  });

  it('refuses a malformed line without repeating the rule', () => {
    let message = '';
    try {
      parseIdentifierList(`no-tab-${NAME}`, 'list');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('<class><TAB><regex>');
    expect(message).not.toContain(NAME);
    expect(() => parseIdentifierList('username\t(unclosed', 'list')).toThrow(IdentifierListError);
  });
});

describe('finding one', () => {
  it('names the file, the line and the class, and never the match', () => {
    const found = findPrivateIdentifiers(file('docs/a.md', `one\nbuilt on ${HOST} by ${NAME.toUpperCase()}\n`), list);
    expect(found.map((f) => [f.line, f.evidence])).toEqual([
      [2, 'username, not shown'],
      [2, 'hostname, not shown'],
    ]);
    expect(leaks(found)).toBe(false);
  });

  it('reads the path, and never prints a path that is itself an identifier', () => {
    const found = findPrivateIdentifiers(file(`notes/dir_${NAME}/n.txt`, `again ${NAME}`), list, 'tracked path #7');
    expect(found.map((f) => [f.file, f.line])).toEqual([
      ['tracked path #7', 0],
      ['tracked path #7', 1],
    ]);
    expect(leaks(found)).toBe(false);
  });

  it('is not excused by the fixture marker, which only ever describes invented data', () => {
    const marker = ['@release', 'check', 'fixtures'].join('-');
    expect(findPrivateIdentifiers(file('t.ts', `/** ${marker} */\nconst p = '${NAME}';`), list)).toHaveLength(1);
  });

  it('is excused only by an allow entry for its own class that covers it on the same line', () => {
    expect(findPrivateIdentifiers(file('a', `${home('someone')}/x`), list)).toEqual([]);
    // The placeholder on the line does not buy the real path beside it a pass.
    expect(findPrivateIdentifiers(file('a', `${home('someone')} and ${home('other')}`), list)).toHaveLength(1);
    // A home-path allow cannot excuse a username, even one inside the placeholder's own path.
    expect(findPrivateIdentifiers(file('a', `${home('someone')}/${NAME}`), list).map((f) => f.evidence)).toEqual(['username, not shown']);
    // And a placeholder's tail is exact.
    expect(findPrivateIdentifiers(file('a', `${home('someone2')}/x`), list)).toHaveLength(1);
  });

  it('stays linear on a long line full of excused hits', () => {
    const line = `${home('someone')} `.repeat(20000);
    const started = Date.now();
    expect(findPrivateIdentifiers(file('min.js', line), list)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reads bytes: UTF-16 without a BOM, and strings inside a binary', () => {
    const utf16 = Buffer.from(`made by ${NAME}`, 'utf16le');
    expect(findPrivateIdentifiersInBytes('a.txt', utf16, list).map((f) => [f.line, f.evidence])).toEqual([[0, 'username, not shown']]);
    const binary = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`host=${HOST}`), Buffer.from([0, 0])]);
    expect(findPrivateIdentifiersInBytes('a.png', binary, list).map((f) => f.evidence)).toEqual(['hostname, not shown']);
  });

  it('runs inside the release check, only when a list was given, and redacts every rule', () => {
    const files = [file('README.md', `ssh ${HOST}`)];
    expect(checkRelease(files, ['README.md']).some((f) => f.problem.includes('private identifier'))).toBe(false);
    const found = checkRelease(files, ['README.md', `assets/${NAME}.png`], list).filter((f) => f.problem.includes('private identifier'));
    // The image was never read as text, and its name is still checked, and not printed.
    expect(found.map((f) => [f.file, f.line])).toEqual([
      ['README.md', 1],
      ['tracked path #2', 0],
    ]);
    // The ordinary home-folder rule quotes the folder; with a list, the quote is withheld.
    const quoted = checkRelease([file('docs/setup.md', `cd ${home(NAME)}/x`)], ['docs/setup.md'], list);
    expect(quoted.length).toBeGreaterThan(1);
    expect(leaks(quoted)).toBe(false);
  });
});

describe('where the list comes from', () => {
  const files: Record<string, string> = {
    '/home/someone/.config/private-identifiers/identifiers.txt': `username\t${NAME}`,
    '/home/someone/.config/private-identifiers/allow.txt': 'username\tplaceholder',
    '/elsewhere/list.txt': `hostname\t${HOST}`,
  };
  const read = (path: string) => files[path];
  const homeDir = '/home/someone';

  it('takes the content first, then a named file, then the default place', () => {
    expect(loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS: `x\ty`, PRIVATE_IDENTIFIERS_FILE: '/elsewhere/list.txt' }, home: homeDir, read }).source).toBe(
      'from $PRIVATE_IDENTIFIERS',
    );
    expect(loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS_FILE: '/elsewhere/list.txt' }, home: homeDir, read }).rules[0]!.name).toBe('hostname');
    const fromDefault = loadPrivateIdentifiers({ env: {}, home: homeDir, read });
    expect(fromDefault.rules[0]!.name).toBe('username');
    expect(fromDefault.allow).toHaveLength(1);
  });

  it('says plainly when there is none, and names no path when there is', () => {
    expect(loadPrivateIdentifiers({ env: {}, home: '/nobody', read })).toEqual({ rules: [], allow: [], identities: [], source: 'none configured' });
    expect(loadPrivateIdentifiers({ env: {}, home: homeDir, read }).source).not.toContain(homeDir);
  });

  it('refuses a named file it cannot read, and a list of only allow entries', () => {
    expect(() => loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS_FILE: '/missing' }, home: homeDir, read })).toThrow(IdentifierListError);
    expect(() => loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS: 'allow:username\tx' }, home: homeDir, read })).toThrow(IdentifierListError);
  });
});

/** An interpreter, asked to run, because on Windows `python3` is often a stub that prints an error. */
function find(candidates: string[], probe: string[]): string | undefined {
  for (const candidate of candidates) {
    if (spawnSync(candidate, probe, { encoding: 'utf8' }).status === 0) return candidate;
  }
  return undefined;
}
const python = find(['python3', 'python'], ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']);
const bash = find(['bash'], ['-c', 'exit 0']);
if (!python) console.warn('privateIdentifiers.test: no Python 3, so the history scan tests below are SKIPPED, which is not a pass');
if (!bash) console.warn('privateIdentifiers.test: no bash, so the release step tests below are SKIPPED, which is not a pass');

/** Python, for a step script that calls `python3` by name: on Windows that name is often a stub. */
function python3Shim(dir: string): Record<string, string> {
  if (find(['python3'], ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'])) return {};
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'python3'), `#!/bin/sh\nexec ${python!.replace(/\\/g, '/')} "$@"\n`, { mode: 0o755 });
  return { PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };
}

/** Writes archives with Python, so the bytes are the ones a real tool would write. */
function pythonWrites(script: string, ...args: string[]) {
  const done = spawnSync(python!, ['-c', script, ...args], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`python helper failed: ${done.stderr}`);
}
const TAR_WITH_OWNER = [
  'import io, sys, tarfile, gzip',
  'b = io.BytesIO(); t = tarfile.open(fileobj=b, mode="w", format=tarfile.PAX_FORMAT)',
  'i = tarfile.TarInfo("ok.txt"); data = b"clean"; i.size = len(data); i.uname = sys.argv[2]; t.addfile(i, io.BytesIO(data)); t.close()',
  'open(sys.argv[1], "wb").write(gzip.compress(b.getvalue()))',
].join('\n');

describe('the history scan reads the same list, through the gate\'s own scanner', () => {
  const room = mkdtempSync(join(tmpdir(), 'private-ids-'));
  const repo = join(room, 'repo');
  const emptyHome = join(room, 'home');
  mkdirSync(repo);
  mkdirSync(emptyHome);
  afterAll(() => rmSync(room, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    spawnSync('git', ['-C', repo, '-c', 'user.name=Somebody', '-c', 'user.email=somebody@example.invalid', '-c', 'core.hooksPath=', ...args], {
      encoding: 'utf8',
    });
  const scan = (env: Record<string, string>, at = repo) =>
    spawnSync(python!, [resolve(root, 'ci/scripts/history-scan.py'), at], {
      encoding: 'utf8',
      // An empty home on both platforms, so the maintainer's own list on the
      // machine running this never joins in.
      env: { ...process.env, PRIVATE_IDENTIFIERS: '', PRIVATE_IDENTIFIERS_FILE: '', HOME: emptyHome, USERPROFILE: emptyHome, ...env },
    });

  it.skipIf(!python)('finds an identifier in a file, a fixture, a path, a message, an author and UTF-16', () => {
    git('init', '-q');
    const marker = ['@release', 'check', 'fixtures'].join('-');
    writeFileSync(join(repo, 'fixture.ts'), `/** ${marker} */\nconst who = '${NAME}';\n`);
    mkdirSync(join(repo, `dir-${HOST}`));
    // A hyphen, not an underscore: `\b` sees `_` as part of the word.
    writeFileSync(join(repo, `dir-${HOST}`, 'n.txt'), 'clean\n');
    writeFileSync(join(repo, 'wide.txt'), Buffer.from(`by ${NAME}`, 'utf16le'));
    git('add', '.');
    git('commit', '-q', '-m', `built on ${HOST}`);
    git('-c', `user.email=${NAME}@example.invalid`, 'commit', '-q', '--allow-empty', '-m', 'second');
    const result = scan({ PRIVATE_IDENTIFIERS: LIST });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private identifiers: 3 rules from $PRIVATE_IDENTIFIERS');
    expect(result.stdout).toMatch(/fixture\.ts:2: username/);
    expect(result.stdout).toMatch(/wide\.txt \(binary\): username/);
    expect(result.stdout).toMatch(/\(its path\): hostname/);
    expect(result.stdout).toMatch(/commit [0-9a-f]+ message:1: hostname/);
    expect(result.stdout).toMatch(/commit [0-9a-f]+ people: username/);
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('sees a rename: every entry name of every tree, not only the first path of a blob', () => {
    git('mv', 'fixture.ts', `${NAME}-notes.ts`);
    git('commit', '-q', '-m', 'rename');
    const result = scan({ PRIVATE_IDENTIFIERS: LIST });
    expect(result.stdout).toMatch(/tree [0-9a-f]+ entry #\d+: username/);
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('opens an archive in history and reads its metadata (a tar owner name)', () => {
    pythonWrites(TAR_WITH_OWNER, join(repo, 'bundle.tgz'), NAME);
    git('add', 'bundle.tgz');
    git('commit', '-q', '-m', 'bundle');
    const result = scan({ PRIVATE_IDENTIFIERS: LIST });
    expect(result.stdout).toMatch(/bundle\.tgz![^:\n]*: username/);
  });

  it.skipIf(!python)('with a list, refuses AI attribution and a foreign identity, and leaves people and prose alone', () => {
    const before = scan({ PRIVATE_IDENTIFIERS: LIST }).stdout;
    expect(before).not.toMatch(/message: ai-attribution/);
    git('commit', '-q', '--allow-empty', '-m', 'prose', '-m', 'Output generated by the llm router is now cached.', '-m', 'Co-authored-by: Jane Talbot <jane@example.invalid>', '-m', 'Co-authored-by: Devin Smith <devin@example.invalid>');
    expect(scan({ PRIVATE_IDENTIFIERS: LIST }).stdout).not.toMatch(/message: ai-attribution/);
    // Assembled, so the release check's own email rule does not flag this file.
    git('commit', '-q', '--allow-empty', '-m', 'tool', '-m', `Helped-by: Claude <${['noreply', 'anthropic.com'].join('@')}>`);
    const after = scan({ PRIVATE_IDENTIFIERS: LIST });
    expect(after.stdout).toMatch(/commit [0-9a-f]+ message: ai-attribution/);
    // The second commit's author was the invented username, which is not the listed identity.
    expect(after.stdout).toMatch(/commit [0-9a-f]+ author: foreign-identity/);
    expect(scan({ PRIVATE_IDENTIFIERS: LIST.replace(/^identity.*$/m, '') }).stdout).toContain('foreign-identity: SKIPPED');
  });

  it.skipIf(!python)('never prints a tag or branch name that is itself an identifier', () => {
    git('tag', '-a', `v-${NAME}`, '-m', 'a tag');
    git('branch', `wip-${HOST}`);
    const result = scan({ PRIVATE_IDENTIFIERS: LIST });
    expect(result.stdout).toMatch(/tag [0-9a-f]+ name: username/);
    expect(result.stdout).toMatch(/ref #\d+: hostname/);
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('says it skipped when there is no list, and runs no policy', () => {
    const result = scan({});
    expect(result.stdout).toContain('private identifiers: SKIPPED, none configured');
    expect(result.stdout).not.toMatch(/message: ai-attribution|author: foreign-identity/);
    expect(result.status).toBe(0);
  });

  it.skipIf(!python)('stops on a broken list rather than reporting clean, without printing it', () => {
    const result = scan({ PRIVATE_IDENTIFIERS: `username\t(${NAME}` });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain(NAME);
  });

  it.skipIf(!python)('stops when git cannot hand over every object, rather than reporting what it read', () => {
    const broken = join(room, 'broken');
    mkdirSync(broken);
    const b = (...args: string[]) => spawnSync('git', ['-C', broken, '-c', 'user.name=S', '-c', 'user.email=s@example.invalid', '-c', 'core.hooksPath=', ...args], { encoding: 'utf8' });
    b('init', '-q');
    writeFileSync(join(broken, 'a.txt'), 'some bytes\n');
    b('add', 'a.txt');
    b('commit', '-q', '-m', 'one');
    const blob = b('rev-parse', 'HEAD:a.txt').stdout.trim();
    rmSync(join(broken, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const result = scan({}, broken);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('refusing to report clean');
  });
});

describe('the release step', () => {
  /** A disposable git repository holding the release scripts, so a tag can carry (or not carry) the opt-out file. */
  function releaseRepo(withOptOut: 'none' | 'tagged' | 'untracked'): string {
    const repo = mkdtempSync(join(tmpdir(), 'private-ids-repo-'));
    mkdirSync(join(repo, 'ci', 'scripts'), { recursive: true });
    for (const f of ['private-identifiers.sh', 'privacy_scan.py', 'history-scan.py', 'installer_matches_zip.py']) {
      writeFileSync(join(repo, 'ci', 'scripts', f), readFileSync(resolve(root, 'ci/scripts', f)));
    }
    const g = (...args: string[]) =>
      spawnSync('git', ['-C', repo, '-c', 'user.name=S', '-c', 'user.email=s@example.invalid', '-c', 'core.hooksPath=', ...args], { encoding: 'utf8' });
    g('init', '-q');
    if (withOptOut === 'tagged') writeFileSync(join(repo, 'ci', 'private-identifiers-optional'), 'this fork has no list\n');
    g('add', '.');
    g('commit', '-q', '-m', 'release scripts');
    g('tag', 'v9.9.9');
    if (withOptOut === 'untracked') writeFileSync(join(repo, 'ci', 'private-identifiers-optional'), 'added after the tag\n');
    return repo;
  }
  const run = (env: Record<string, string>, args: string[], at = root) => {
    const bin = mkdtempSync(join(tmpdir(), 'private-ids-bin-'));
    try {
      return spawnSync(bash!, [join(at, 'ci/scripts/private-identifiers.sh'), ...args], {
        encoding: 'utf8',
        cwd: at,
        env: { ...process.env, PRIVATE_IDENTIFIERS: '', GITHUB_REF_NAME: '', ...python3Shim(bin), ...env },
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  };
  const dist = (files: Record<string, (path: string) => void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'private-ids-dist-'));
    for (const [name, write] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      write(join(dir, name));
    }
    return dir;
  };

  it.skipIf(!bash)('refuses a release when the secret is missing', () => {
    const result = run({}, ['files', __filename]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('REFUSED: the PRIVATE_IDENTIFIERS secret is not set');
  });

  it.skipIf(!bash)('takes the opt-out only from the tag being released', () => {
    // A variable cannot do it, whatever its value.
    expect(run({ PRIVATE_IDENTIFIERS_SKIP: 'no-private-identifiers-here' }, ['history']).status).toBe(1);
    const tagged = releaseRepo('tagged');
    const untracked = releaseRepo('untracked');
    try {
      const skipped = run({ GITHUB_REF_NAME: 'v9.9.9' }, ['history'], tagged);
      expect(skipped.status).toBe(0);
      expect(skipped.stdout).toContain('SKIPPED, BY CHOICE');
      // The same file in the working directory, but not in the tag, counts for nothing.
      expect(run({ GITHUB_REF_NAME: 'v9.9.9' }, ['history'], untracked).status).toBe(1);
      // Nor does a tagged opt-out when no tag is being released.
      expect(run({}, ['history'], tagged).status).toBe(1);
    } finally {
      rmSync(tagged, { recursive: true, force: true });
      rmSync(untracked, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('reads only the secret: no variable, home directory or file in the repository can excuse a hit', () => {
    const repo = releaseRepo('none');
    const room = mkdtempSync(join(tmpdir(), 'private-ids-env-'));
    try {
      // A list and an allow file that would excuse everything, offered every way there is.
      writeFileSync(join(room, 'harmless.txt'), 'username\tnothing-here\n');
      writeFileSync(join(room, 'allow-all.txt'), 'username,hostname,home-path\t.*\n');
      mkdirSync(join(room, '.config', 'private-identifiers'), { recursive: true });
      writeFileSync(join(room, '.config', 'private-identifiers', 'allow.txt'), 'username,hostname,home-path\t.*\n');
      mkdirSync(join(repo, 'ci', 'ai', 'private'), { recursive: true });
      writeFileSync(join(repo, 'ci', 'ai', 'private', 'allow.txt'), 'username,hostname,home-path\t.*\n');
      const target = join(room, 'leak.txt');
      writeFileSync(target, `built by ${NAME}\n`);
      const result = run(
        {
          PRIVATE_IDENTIFIERS: LIST,
          PRIVATE_IDENTIFIERS_FILE: join(room, 'harmless.txt'),
          PRIVATE_IDENTIFIERS_ALLOW_FILE: join(room, 'allow-all.txt'),
          PRIVACY_SCAN_MAX_UNPACKED: '1',
          HOME: room,
          USERPROFILE: room,
        },
        ['files', target],
        repo,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/leak\.txt:1: username/);
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(room, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('scans every file it is given, a directory recursively, and refuses a missing one', () => {
    const dir = dist({ 'build/windows/inner.txt': (p) => writeFileSync(p, `by ${NAME}\n`), 'top.txt': (p) => writeFileSync(p, 'clean\n') });
    try {
      const nested = run({ PRIVATE_IDENTIFIERS: LIST }, ['files', join(dir, 'top.txt'), join(dir, 'build')]);
      expect(nested.status).toBe(1);
      expect(nested.stdout).toMatch(/windows\/inner\.txt:1: username/);
      const missing = run({ PRIVATE_IDENTIFIERS: LIST }, ['files', join(dir, 'top.txt'), join(dir, 'not-there.zip')]);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain('a file to be published is missing');
      expect(run({ PRIVATE_IDENTIFIERS: LIST }, ['files', join(dir, 'top.txt')]).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('opens nested archives and their metadata, and still reads node_modules', () => {
    const nestedZip = [
      'import io, sys, tarfile, zipfile',
      'b = io.BytesIO(); t = tarfile.open(fileobj=b, mode="w:gz")',
      'i = tarfile.TarInfo("ok.txt"); data = b"clean"; i.size = len(data); i.uname = sys.argv[2]; t.addfile(i, io.BytesIO(data)); t.close()',
      'z = zipfile.ZipFile(sys.argv[1], "w"); z.writestr("app/inner.tgz", b.getvalue()); z.close()',
    ].join('\n');
    const modules = [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)',
      // A third-party example path is not a finding; a name from the list is.
      'z.writestr("app/node_modules/dep/README.md", "see " + sys.argv[3]); z.writestr("app/node_modules/dep/built.js", "// " + sys.argv[2]); z.close()',
    ].join('\n');
    const dir = dist({
      'AI17Z-App-1.zip': (p) => pythonWrites(nestedZip, p, NAME),
      'AI17Z-App-2.zip': (p) => pythonWrites(modules, p, NAME, `${home('jdoe')}/x`),
    });
    try {
      const result = run({ PRIVATE_IDENTIFIERS: LIST }, ['files', join(dir, 'AI17Z-App-1.zip'), join(dir, 'AI17Z-App-2.zip')]);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/AI17Z-App-1\.zip!app\/inner\.tgz![^:\n]*: username/);
      expect(result.stdout).toMatch(/node_modules\/dep\/built\.js:1: username/);
      expect(result.stdout).not.toMatch(/README\.md[^\n]*home-path/);
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('refuses when innoextract warns and the installer holds files the zip does not', () => {
    const repo = releaseRepo('none');
    const dir = mkdtempSync(join(tmpdir(), 'private-ids-ino-'));
    try {
      // The application zip the installer must reproduce, plus a dummy .exe.
      const zip = join(dir, 'AI17Z-App-1.zip');
      pythonWrites(
        ['import sys, zipfile', 'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)', 'z.writestr("a.txt", "top file\\n")', 'z.close()'].join('\n'),
        zip,
      );
      const exe = join(dir, 'AI17Z-Setup-1.exe');
      writeFileSync(exe, 'MZ placeholder\n');
      // A fake innoextract that unpacks the zip's file plus an extra one, warns,
      // and exits clean: the warning, not the status, is what must refuse.
      const bin = mkdtempSync(join(tmpdir(), 'private-ids-ino-bin-'));
      writeFileSync(
        join(bin, 'innoextract'),
        ['#!/bin/sh', 'mkdir -p "$2/app"', "printf 'top file\\n' > \"$2/app/a.txt\"", "printf 'extra\\n' > \"$2/app/extra.txt\"", 'echo "Warning: could not read back some checksums" >&2', 'exit 0'].join('\n'),
        { mode: 0o755 },
      );
      python3Shim(bin);
      const sep = process.platform === 'win32' ? ';' : ':';
      const result = spawnSync(bash!, [join(repo, 'ci/scripts/private-identifiers.sh'), 'files', zip, exe], {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, GITHUB_REF_NAME: '', PATH: `${bin}${sep}${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('unpacked 2 files; innoextract warned 1 times');
      expect(result.stdout).toContain('REFUSED: innoextract warned 1 times and the installer holds 1 files that are neither in the application zip nor byte for byte copies of one');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('counts installer-only files across the whole output, not only the application directory', () => {
    const repo = releaseRepo('none');
    const dir = mkdtempSync(join(tmpdir(), 'private-ids-ino-whole-'));
    try {
      const zip = join(dir, 'AI17Z-App-1.zip');
      pythonWrites(
        ['import sys, zipfile', 'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)', 'z.writestr("a.txt", "top file\\n")', 'z.close()'].join('\n'),
        zip,
      );
      const exe = join(dir, 'AI17Z-Setup-1.exe');
      writeFileSync(exe, 'MZ placeholder\n');
      // The extra file sits at the top of the output, outside app/: it must
      // still be counted as installer-only, or a warning would not refuse it.
      const bin = mkdtempSync(join(tmpdir(), 'private-ids-ino-whole-bin-'));
      writeFileSync(
        join(bin, 'innoextract'),
        ['#!/bin/sh', 'mkdir -p "$2/app"', "printf 'top file\\n' > \"$2/app/a.txt\"", "printf 'installer only\\n' > \"$2/extra.txt\"", 'echo "Warning: could not read back some checksums" >&2', 'exit 0'].join('\n'),
        { mode: 0o755 },
      );
      python3Shim(bin);
      const sep = process.platform === 'win32' ? ';' : ':';
      const result = spawnSync(bash!, [join(repo, 'ci/scripts/private-identifiers.sh'), 'files', zip, exe], {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, GITHUB_REF_NAME: '', PATH: `${bin}${sep}${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('unpacked 2 files; innoextract warned 1 times');
      expect(result.stdout).toContain('REFUSED: innoextract warned 1 times and the installer holds 1 files that are neither in the application zip nor byte for byte copies of one');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('passes when innoextract warns but every installer-only file is a byte for byte copy of a zip file, and still scans them', () => {
    const repo = releaseRepo('none');
    const dir = mkdtempSync(join(tmpdir(), 'private-ids-ino-copy-'));
    try {
      // The real shape of Beta 0.91: Inno Setup follows a workspace symlink the
      // zip skips, so the installer holds node_modules/@scope/pkg/index.js as a
      // second copy of packages/pkg/index.js, and innoextract warns on every file.
      const zip = join(dir, 'AI17Z-App-1.zip');
      pythonWrites(
        [
          'import sys, zipfile',
          'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)',
          'z.writestr("packages/pkg/index.js", "export const x = 1;\\n")',
          'z.writestr("a.txt", "top file\\n")',
          'z.close()',
        ].join('\n'),
        zip,
      );
      const exe = join(dir, 'AI17Z-Setup-1.exe');
      writeFileSync(exe, 'MZ placeholder\n');
      const bin = mkdtempSync(join(tmpdir(), 'private-ids-ino-copy-bin-'));
      writeFileSync(
        join(bin, 'innoextract'),
        [
          '#!/bin/sh',
          'mkdir -p "$2/app/packages/pkg" "$2/app/node_modules/@scope/pkg"',
          "printf 'top file\\n' > \"$2/app/a.txt\"",
          "printf 'export const x = 1;\\n' > \"$2/app/packages/pkg/index.js\"",
          "printf 'export const x = 1;\\n' > \"$2/app/node_modules/@scope/pkg/index.js\"",
          'echo "Warning: Could not read back a file to calculate output checksum for multi-part file" >&2',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      python3Shim(bin);
      const sep = process.platform === 'win32' ? ';' : ':';
      const result = spawnSync(bash!, [join(repo, 'ci/scripts/private-identifiers.sh'), 'files', zip, exe], {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, GITHUB_REF_NAME: '', PATH: `${bin}${sep}${process.env.PATH ?? ''}` },
      });
      expect(result.stdout).toContain('unpacked 3 files; innoextract warned 1 times');
      expect(result.stdout).toContain('installer-only: 1; copies of zip files: 1; unproven: 0');
      expect(result.stdout).not.toContain('REFUSED');
      expect(result.status).toBe(0);
      expect(leaks(result.stdout)).toBe(false);

      // The copy is still scanned as content: an identifier in a copy-shaped
      // file that differs from the zip is not a copy, so it refuses as unproven.
      writeFileSync(
        join(bin, 'innoextract'),
        [
          '#!/bin/sh',
          'mkdir -p "$2/app/packages/pkg" "$2/app/node_modules/@scope/pkg"',
          "printf 'top file\\n' > \"$2/app/a.txt\"",
          "printf 'export const x = 1;\\n' > \"$2/app/packages/pkg/index.js\"",
          "printf 'export const x = 2;\\n' > \"$2/app/node_modules/@scope/pkg/index.js\"",
          'echo "Warning: Could not read back a file to calculate output checksum for multi-part file" >&2',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      const changed = spawnSync(bash!, [join(repo, 'ci/scripts/private-identifiers.sh'), 'files', zip, exe], {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, GITHUB_REF_NAME: '', PATH: `${bin}${sep}${process.env.PATH ?? ''}` },
      });
      expect(changed.status).toBe(1);
      expect(changed.stdout).toContain('installer-only: 1; copies of zip files: 0; unproven: 1');
      expect(changed.stdout).toContain('REFUSED: innoextract warned 1 times and the installer holds 1 files that are neither');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('still scans the content of an installer file that is a proven copy of a zip file', () => {
    const repo = releaseRepo('none');
    const dir = mkdtempSync(join(tmpdir(), 'private-ids-ino-copyscan-'));
    try {
      // Proving a file is a copy says it is whole, not that it is clean. The
      // zip member and its copy carry an identifier (invented, assembled at
      // run time), so the hash match accepts the copy and the content scan
      // must still be the thing that refuses it.
      const zip = join(dir, 'AI17Z-App-1.zip');
      pythonWrites(
        [
          'import sys, zipfile',
          'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)',
          `z.writestr("packages/pkg/index.js", "// owner ${NAME}\\n")`,
          'z.close()',
        ].join('\n'),
        zip,
      );
      const exe = join(dir, 'AI17Z-Setup-1.exe');
      writeFileSync(exe, 'MZ placeholder\n');
      const bin = mkdtempSync(join(tmpdir(), 'private-ids-ino-copyscan-bin-'));
      writeFileSync(
        join(bin, 'innoextract'),
        [
          '#!/bin/sh',
          'mkdir -p "$2/app/packages/pkg" "$2/app/node_modules/@scope/pkg"',
          `printf '// owner ${NAME}\\n' > "$2/app/packages/pkg/index.js"`,
          `printf '// owner ${NAME}\\n' > "$2/app/node_modules/@scope/pkg/index.js"`,
          'echo "Warning: Could not read back a file to calculate output checksum for multi-part file" >&2',
          'exit 0',
        ].join('\n'),
        { mode: 0o755 },
      );
      python3Shim(bin);
      const sep = process.platform === 'win32' ? ';' : ':';
      const result = spawnSync(bash!, [join(repo, 'ci/scripts/private-identifiers.sh'), 'files', zip, exe], {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, GITHUB_REF_NAME: '', PATH: `${bin}${sep}${process.env.PATH ?? ''}` },
      });
      const inside = result.stdout.split('### inside installer #1')[1] ?? '';
      // The copy was accepted as a copy, not refused as unproven...
      expect(inside).toContain('installer-only: 1; copies of zip files: 1; unproven: 0');
      expect(inside).not.toContain('files that are neither');
      // ...and the scan of the unpacked installer, which is a separate step,
      // still ran and refused, without printing the identifier.
      expect(inside).toMatch(/username/);
      expect(result.status).toBe(1);
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bash || !python)('refuses when innoextract warns and no application zip matches the installer', () => {
    const repo = releaseRepo('none');
    const dir = mkdtempSync(join(tmpdir(), 'private-ids-ino-nozip-'));
    try {
      // A zip of a different version, so no application zip matches this installer.
      const zip = join(dir, 'AI17Z-App-1.zip');
      pythonWrites(
        ['import sys, zipfile', 'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)', 'z.writestr("a.txt", "top file\\n")', 'z.close()'].join('\n'),
        zip,
      );
      const exe = join(dir, 'AI17Z-Setup-2.exe');
      writeFileSync(exe, 'MZ placeholder\n');
      const bin = mkdtempSync(join(tmpdir(), 'private-ids-ino-nozip-bin-'));
      writeFileSync(
        join(bin, 'innoextract'),
        ['#!/bin/sh', 'mkdir -p "$2/app"', "printf 'top file\\n' > \"$2/app/a.txt\"", 'echo "Warning: could not read back some checksums" >&2', 'exit 0'].join('\n'),
        { mode: 0o755 },
      );
      python3Shim(bin);
      const sep = process.platform === 'win32' ? ';' : ':';
      const result = spawnSync(bash!, [join(repo, 'ci/scripts/private-identifiers.sh'), 'files', zip, exe], {
        encoding: 'utf8',
        cwd: repo,
        env: { ...process.env, PRIVATE_IDENTIFIERS: LIST, GITHUB_REF_NAME: '', PATH: `${bin}${sep}${process.env.PATH ?? ''}` },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('unpacked 1 files; innoextract warned 1 times');
      expect(result.stdout).toContain('REFUSED: no application zip for this installer in the set and innoextract warned 1 times');
      expect(leaks(result.stdout)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('round 3: shapes that are refused, and reads that are wider', () => {
  const room = mkdtempSync(join(tmpdir(), 'private-ids-r3-'));
  const repo = join(room, 'repo');
  const emptyHome = join(room, 'home');
  mkdirSync(repo);
  mkdirSync(emptyHome);
  afterAll(() => rmSync(room, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', repo, '-c', 'user.name=Somebody', '-c', 'user.email=somebody@example.invalid', '-c', 'core.hooksPath=', ...args], {
      encoding: 'utf8',
    });
  const scan = (args: string[], env: Record<string, string>) =>
    spawnSync(python!, [resolve(root, 'ci/scripts/history-scan.py'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PRIVATE_IDENTIFIERS: '', PRIVATE_IDENTIFIERS_FILE: '', HOME: emptyHome, USERPROFILE: emptyHome, ...env },
    });

  it.skipIf(!python)('never prints a tag name in a built-in finding', () => {
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    // A token shape the built-in rules know, assembled so this file is not one.
    git('tag', '-a', `v-${NAME}`, '-m', `token ${'ghp_' + 'A'.repeat(35)}`);
    const result = scan([repo], {});
    expect(result.stdout).toMatch(/github-token in message of tag [0-9a-f]{20,}/);
    expect(leaks(result.stdout)).toBe(false);
  });

  it.skipIf(!python)('refuses a commit whose message is in another encoding, under --ci', () => {
    const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
    const parent = git('rev-parse', 'HEAD').stdout.trim();
    const who = 'Somebody <somebody@example.invalid> 1700000000 +0000';
    const raw = join(room, 'enc.txt');
    pythonWrites(
      'import sys; head = "tree %s\\nparent %s\\nauthor %s\\ncommitter %s\\nencoding IBM037\\n\\n" % tuple(sys.argv[2:6]); open(sys.argv[1], "wb").write(head.encode() + ("built on " + sys.argv[6]).encode("cp037"))',
      raw, tree, parent, who, who, NAME,
    );
    const sha = git('hash-object', '-t', 'commit', '-w', '--literally', raw).stdout.trim();
    git('update-ref', 'refs/heads/enc', sha);
    const result = scan(['--ci', repo], { PRIVATE_IDENTIFIERS: LIST });
    expect(result.stdout).toMatch(/commit [0-9a-f]+: non-utf8-encoding/);
    expect(result.status).toBe(1);
    // --ci takes nothing but the repository, and no list is a refusal there.
    expect(scan(['--ci', repo], {}).status).toBe(2);
  });

  it('reads bytes past the first 8 KB, and after NFKC with invisible characters removed', () => {
    const late = Buffer.concat([Buffer.alloc(12000, 97), Buffer.from([0]), Buffer.from(NAME, 'utf16le')]);
    expect(findPrivateIdentifiersInBytes('a.bin', late, list).map((f) => f.evidence)).toEqual(['username, not shown']);
    const fullwidth = [...NAME].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    const zeroWidth = NAME.slice(0, 4) + String.fromCharCode(0x200b) + NAME.slice(4);
    for (const text of [fullwidth, zeroWidth]) {
      expect(findPrivateIdentifiers(file('a.txt', `by ${text}`), list).map((f) => f.evidence)).toEqual(['username, not shown']);
      expect(findPrivateIdentifiersInBytes('a.txt', Buffer.from(`by ${text}`, 'utf8'), list)).toHaveLength(1);
    }
  });
});

describe('merges made on github.com: who may have written and committed a commit', () => {
  const room = mkdtempSync(join(tmpdir(), 'merge-ids-'));
  const repo = join(room, 'repo');
  const emptyHome = join(room, 'home');
  mkdirSync(repo);
  mkdirSync(emptyHome);
  afterAll(() => rmSync(room, { recursive: true, force: true }));

  const OURS = 'somebody@example.invalid';
  // Assembled, so the release check does not read these as somebody's address.
  const at = (local: string, domain = 'github.com') => [local, domain].join('@');
  const GITHUB = `GitHub <${at('noreply')}>`;
  const split = (ident: string) => {
    const cut = ident.lastIndexOf(' <');
    return { name: ident.slice(0, cut), email: ident.slice(cut + 2, -1) };
  };
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  /** One empty commit written by `author` and committed by `committer`; returns its id. */
  const commit = (subject: string, author: string, committer: string, ...body: string[]) => {
    const a = split(author);
    const c = split(committer);
    const done = run(['commit', '-q', '--allow-empty', '-m', subject, ...body.flatMap((b) => ['-m', b])], {
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_COMMITTER_NAME: c.name,
      GIT_COMMITTER_EMAIL: c.email,
    });
    if (done.status !== 0) throw new Error(done.stderr);
    return run(['rev-parse', 'HEAD']).stdout.trim();
  };
  const LIST_HERE = [`username\t(?i)${NAME}`, `identity\tSomebody <${OURS}>`].join('\n');
  const scan = () =>
    spawnSync(python!, [resolve(root, 'ci/scripts/history-scan.py'), repo], {
      encoding: 'utf8',
      env: { ...process.env, PRIVATE_IDENTIFIERS: LIST_HERE, PRIVATE_IDENTIFIERS_FILE: '', HOME: emptyHome, USERPROFILE: emptyHome },
    });
  const findingsFor = (out: string, id: string) =>
    out.split('\n').filter((l) => l.includes(`commit ${id.slice(0, 10)} `)).map((l) => l.trim().replace(/^commit [0-9a-f]+ /, ''));

  it.skipIf(!python)('accepts GitHub as committer and our address under any display name, and nothing wider', () => {
    run(['init', '-q']);
    const squash = commit('Squashed on github.com', `Display Name <${OURS}>`, GITHUB);
    const exact = commit('Written here', `Somebody <${OURS}>`, `Somebody <${OURS}>`);
    const foreign = commit('Somebody else', 'Other Person <other@example.invalid>', GITHUB);
    const bot = commit('A bot pull request', 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>', GITHUB);
    const botOurs = commit('A bot name on our address', `dependabot[bot] <${OURS}>`, GITHUB);
    const renamedCommitter = commit('Our address, another committer name', `Somebody <${OURS}>`, `Display Name <${OURS}>`);
    const fakeGithub = commit('Not GitHub', `Somebody <${OURS}>`, `GitHub <${at('someone')}>`);
    const signed = commit('Allowed people, bot trailer', `Display Name <${OURS}>`, GITHUB, `Signed-off-by: dependabot[bot] <${at('support')}>`);
    const tagged = run(['tag', '-a', 'v0.0.1', '-m', 'tagged by GitHub'], { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: at('noreply') });
    expect(tagged.status).toBe(0);

    const out = scan();
    expect(out.status).toBe(1);
    expect(findingsFor(out.stdout, squash)).toEqual([]);
    expect(findingsFor(out.stdout, exact)).toEqual([]);
    expect(findingsFor(out.stdout, foreign)).toEqual(['author: foreign-identity']);
    expect(findingsFor(out.stdout, bot)).toEqual(['author: foreign-identity']);
    expect(findingsFor(out.stdout, botOurs)).toEqual(['author: foreign-identity']);
    expect(findingsFor(out.stdout, renamedCommitter)).toEqual(['committer: foreign-identity']);
    expect(findingsFor(out.stdout, fakeGithub)).toEqual(['committer: foreign-identity']);
    expect(findingsFor(out.stdout, signed)).toEqual(['message: ai-attribution']);
    // A tagger gets no widening: GitHub never tags here.
    expect(out.stdout).toMatch(/tag [0-9a-f]+ tagger: foreign-identity/);
  });

  // The three squash merges that first landed on the recreated main, judged
  // against the identity of the commit before them, which is how the
  // maintainer's machine writes. Read from this checkout, so nothing about the
  // identity is spelled out in this file.
  const BEFORE = '91484a05';
  const MERGES = ['8ecac85b', '9eb522ed', '2ba7d7d5'];
  const here = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const haveMerges = [BEFORE, ...MERGES].every((c) => here('cat-file', '-e', `${c}^{commit}`).status === 0);
  if (!haveMerges) console.warn('privateIdentifiers.test: this checkout lacks the first GitHub merges on main, so that test is SKIPPED');

  it.skipIf(!python || !haveMerges)('passes the first squash merges on main, which GitHub wrote', () => {
    const identity = here('show', '-s', '--format=%an <%ae>', BEFORE).stdout.trim();
    const patterns = join(room, 'patterns.txt');
    const identityFile = join(room, 'identity.txt');
    writeFileSync(patterns, `username\t(?i)${NAME}\n`);
    writeFileSync(identityFile, `${identity}\n`);
    const tip = MERGES[MERGES.length - 1]!;
    // Each merge has GitHub's committer and an author other than the exact line.
    for (const c of MERGES) expect(here('show', '-s', '--format=%cn <%ce>', c).stdout.trim()).toBe(GITHUB);
    expect(MERGES.some((c) => here('show', '-s', '--format=%an <%ae>', c).stdout.trim() !== identity)).toBe(true);
    const out = spawnSync(
      python!,
      [resolve(root, 'ci/scripts/privacy_scan.py'), '--checks', 'policy', '--patterns', patterns, '--identity', identityFile, 'range', root, `${BEFORE}..${tip}`],
      { encoding: 'utf8', env: { ...process.env, PRIVATE_IDENTIFIERS: '', PRIVATE_IDENTIFIERS_FILE: '', HOME: emptyHome, USERPROFILE: emptyHome } },
    );
    expect(out.stdout).toMatch(/3 commits, rules 0, findings 0/);
    expect(out.status).toBe(0);
  });
});
