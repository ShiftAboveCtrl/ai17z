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
    for (const f of ['private-identifiers.sh', 'privacy_scan.py', 'history-scan.py']) {
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
