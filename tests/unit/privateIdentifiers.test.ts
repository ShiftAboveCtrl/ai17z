import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findPrivateIdentifiers,
  IdentifierListError,
  loadPrivateIdentifiers,
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
 * would publish exactly what the file exists to stop.
 */

const root = resolve(__dirname, '../..');
const NAME = 'zorblax' + 'quin';
const HOST = 'quillbox' + '-node';
const LIST = [
  '# invented',
  `username\t(?i)${NAME}`,
  `hostname\t\\b${HOST}\\b`,
  'allow\t(?i)\\b[a-z]:/+users/+someone\\b',
].join('\n');
const list = parseIdentifierList(LIST, 'test');
const file = (path: string, content: string) => ({ path, content });

describe('the list format, shared with the Python history scan', () => {
  it('reads classes, a leading (?i) and inline allow rules', () => {
    expect(list.rules.map((r) => r.name)).toEqual(['username', 'hostname']);
    expect(list.rules[0]!.pattern.flags).toContain('i');
    expect(list.allow).toHaveLength(1);
  });

  it('refuses syntax only Python reads, rather than reading it differently', () => {
    for (const rx of ['(?P<who>x)', 'a(?i:b)', 'x\\Z', '(?s)x']) {
      expect(() => toRegExp(rx, 'rule'), rx).toThrow(IdentifierListError);
    }
  });

  it('refuses a malformed line without repeating the rule', () => {
    const secret = `no-tab-${NAME}`;
    let message = '';
    try {
      parseIdentifierList(secret, 'list');
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
    expect(JSON.stringify(found)).not.toMatch(new RegExp(`${NAME}|${HOST}`, 'i'));
  });

  it('reads the path as well as the contents', () => {
    expect(findPrivateIdentifiers(file(`notes/${NAME}.txt`, 'clean'), list).map((f) => f.line)).toEqual([0]);
  });

  it('is not excused by the fixture marker, which only ever describes invented data', () => {
    const marker = ['@release', 'check', 'fixtures'].join('-');
    expect(findPrivateIdentifiers(file('t.ts', `/** ${marker} */\nconst p = '${NAME}';`), list)).toHaveLength(1);
  });

  it('is excused only where an allow match on the same line covers it', () => {
    const covered = parseIdentifierList(`home\t(?i)c:/+users/+[a-z]+\nallow\t(?i)c:/+users/+someone\\b`, 'l');
    expect(findPrivateIdentifiers(file('a', 'C:/Users/someone/x'), covered)).toEqual([]);
    // The placeholder on the line does not buy the real path beside it a pass.
    // Assembled, so this file is not itself a home path to a maintainer's gate.
    const another = ['C:', 'Users', 'other'].join('/');
    expect(findPrivateIdentifiers(file('a', `C:/Users/someone and ${another}`), covered)).toHaveLength(1);
  });

  it('runs inside the release check, and only when a list was given', () => {
    const files = [file('README.md', `ssh ${HOST}`)];
    expect(checkRelease(files, ['README.md']).some((f) => f.problem.includes('private identifier'))).toBe(false);
    const found = checkRelease(files, ['README.md', `assets/${NAME}.png`], list).filter((f) => f.problem.includes('private identifier'));
    // The image was never read as text, and its name is still published.
    expect(found.map((f) => [f.file, f.line])).toEqual([
      ['README.md', 1],
      [`assets/${NAME}.png`, 0],
    ]);
  });
});

describe('where the list comes from', () => {
  const files: Record<string, string> = {
    '/home/someone/.config/private-identifiers/identifiers.txt': `username\t${NAME}`,
    '/home/someone/.config/private-identifiers/allow.txt': 'placeholder',
    '/elsewhere/list.txt': `hostname\t${HOST}`,
  };
  const read = (path: string) => files[path];
  const home = '/home/someone';

  it('takes the content first, then a named file, then the default place', () => {
    expect(loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS: `x\ty`, PRIVATE_IDENTIFIERS_FILE: '/elsewhere/list.txt' }, home, read }).source).toBe(
      'from $PRIVATE_IDENTIFIERS',
    );
    expect(loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS_FILE: '/elsewhere/list.txt' }, home, read }).rules[0]!.name).toBe('hostname');
    const fromDefault = loadPrivateIdentifiers({ env: {}, home, read });
    expect(fromDefault.rules[0]!.name).toBe('username');
    expect(fromDefault.allow).toHaveLength(1);
  });

  it('says plainly when there is none, and names no path when there is', () => {
    const none = loadPrivateIdentifiers({ env: {}, home: '/nobody', read });
    expect(none).toEqual({ rules: [], allow: [], source: 'none configured' });
    expect(loadPrivateIdentifiers({ env: {}, home, read }).source).not.toContain(home);
  });

  it('refuses a named file it cannot read, and a list of only allow rules', () => {
    expect(() => loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS_FILE: '/missing' }, home, read })).toThrow(IdentifierListError);
    expect(() => loadPrivateIdentifiers({ env: { PRIVATE_IDENTIFIERS: 'allow\tx' }, home, read })).toThrow(IdentifierListError);
  });
});

/** A Python 3, asked to run, because on Windows `python3` is often a stub that prints an error. */
function findPython(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}
const python = findPython();
if (!python) console.warn('privateIdentifiers.test: no Python 3, so the history scan tests below are SKIPPED, which is not a pass');

describe('the history scan reads the same list', () => {
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
  const scan = (env: Record<string, string>) =>
    spawnSync(python!, [resolve(root, '.forgejo/scripts/history-scan.py'), repo], {
      encoding: 'utf8',
      // An empty home on both platforms, so the maintainer's own list on the
      // machine running this never joins in.
      env: { ...process.env, PRIVATE_IDENTIFIERS: '', PRIVATE_IDENTIFIERS_FILE: '', HOME: emptyHome, USERPROFILE: emptyHome, ...env },
    });

  it.skipIf(!python)('finds an identifier in a file, a fixture, a path, a message and an author', () => {
    git('init', '-q');
    const marker = ['@release', 'check', 'fixtures'].join('-');
    writeFileSync(join(repo, 'fixture.ts'), `/** ${marker} */\nconst who = '${NAME}';\n`);
    writeFileSync(join(repo, `${HOST}.txt`), 'clean\n');
    git('add', '.');
    git('commit', '-q', '-m', `built on ${HOST}`);
    git('-c', `user.email=${NAME}@example.invalid`, 'commit', '-q', '--allow-empty', '-m', 'second');
    const result = scan({ PRIVATE_IDENTIFIERS: LIST });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('private identifiers: 2 rules from $PRIVATE_IDENTIFIERS');
    expect(result.stdout).toMatch(/username in fixture\.ts/);
    expect(result.stdout).toMatch(/hostname in a path name/);
    expect(result.stdout).toMatch(/hostname in message of/);
    expect(result.stdout).toMatch(/username in the author or committer of/);
    expect(result.stdout).not.toMatch(new RegExp(`${NAME}|${HOST}`, 'i'));
  });

  it.skipIf(!python)('says it skipped when there is no list, and finds nothing private', () => {
    const result = scan({});
    expect(result.stdout).toContain('private identifiers: SKIPPED, none configured');
    expect(result.status).toBe(0);
  });

  it.skipIf(!python)('stops on a broken list rather than reporting clean, without printing it', () => {
    const result = scan({ PRIVATE_IDENTIFIERS: `username\t(${NAME}` });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain(NAME);
  });
});
