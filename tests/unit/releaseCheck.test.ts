/**
 * @release-check-fixtures
 *
 * Every key, address and home folder below is invented, and has to look real:
 * this is the test for the check that finds them. The marker tells that check
 * the same thing when it reads this file.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRelease,
  findEncodingProblems,
  findFilesThatShouldNotBeTracked,
  findPersonalDetails,
  findSecrets,
} from '../../tools/releaseCheck';

const file = (path: string, content: string) => ({ path, content });
const BACKSPACE = String.fromCharCode(8);
const BELL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

/**
 * Exercised against fixtures rather than against the repository.
 *
 * A check that passes only because the checkout happens to be clean today
 * proves nothing about tomorrow, and it is exactly the shape of test that
 * quietly becomes vacuous the moment somebody fixes the last real finding.
 */
describe('things that must not be published', () => {
  it('finds a key that was pasted into a file', () => {
    const found = findSecrets(file('src/x.ts', "const key = 'sk-abcdefghij0123456789abcdefghij';"));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toContain('OpenAI');
  });

  it('never reprints the secret it found', () => {
    // This output gets pasted into chats and issues.
    const secret = 'sk-abcdefghij0123456789abcdefghij';
    const found = findSecrets(file('src/x.ts', `const key = '${secret}';`));
    expect(found[0]!.evidence).not.toBe(secret);
    expect(found[0]!.evidence).toContain('...');
  });

  it('finds a real value assigned to something key-shaped', () => {
    const found = findSecrets(file('.env.example', 'AI17Z_MASTER_KEY=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA=='));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toContain('AI17Z_MASTER_KEY');
  });

  it('leaves the file that exists to show the shape alone', () => {
    const example = [
      'AI17Z_MASTER_KEY=',
      'BRAVE_API_KEY=your-key-here',
      'OPENAI_API_KEY=<paste yours>',
      '# XBAM_MASTER_KEY=generate one with openssl',
    ].join('\n');
    expect(findSecrets(file('.env.example', example))).toEqual([]);
  });

  it('lets a file declare that its credentials are invented', () => {
    // A fixture for a secret detector has to contain something shaped like a
    // secret. Exempting every test file instead would be worse: a real key
    // committed to a test is still a real key.
    const marked = ['/** @release-check-fixtures */', "const key = 'sk-abcdefghij0123456789abcdefghij';"].join('\n');
    expect(findSecrets(file('tests/x.test.ts', marked))).toEqual([]);
  });
});

describe('things that name a person', () => {
  it('finds a home folder', () => {
    const found = findPersonalDetails(file('docs/x.md', 'Path: C:\\Users\\jsmith\\Desktop\\thing'));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toContain('jsmith');
  });

  it('leaves the placeholders that stand in for the reader', () => {
    // Flagging these teaches people to ignore the check, which is worse than
    // not having it at all.
    for (const path of ['C:\\Users\\Public\\x', '/home/you/x', '/home/username/x', '/Users/someone/x', '/home/runner/x']) {
      expect(findPersonalDetails(file('docs/x.md', path)), path).toEqual([]);
    }
  });

  it('finds a real email address', () => {
    expect(findPersonalDetails(file('docs/x.md', 'ask real.person@gmail.com'))).toHaveLength(1);
  });

  it('leaves the addresses documentation is supposed to contain', () => {
    for (const address of [
      'you@example.com',
      'owner@example.test',
      'somebody@ai17z.local',
      'user@db.internal',
      'git@github.com:owner/repo.git',
      '12345+name@users.noreply.github.com',
    ]) {
      expect(findPersonalDetails(file('docs/x.md', address)), address).toEqual([]);
    }
  });
});

/**
 * The one that has already cost this repository twice.
 *
 * Writing a file through a shell heredoc turns a backslash-b into an actual
 * backspace, and the result is a regex that compiles, runs, matches nothing,
 * and reads correctly to anybody looking at it. Five happened in one
 * afternoon: one silently disabling an allowlist, one making a vision-capable
 * model undetectable, and two turning a backslash-a in a documented path into
 * a bell.
 */
describe('characters that should not be in source', () => {
  it('finds a control character a shell escape left behind', () => {
    const found = findEncodingProblems(file('src/x.ts', `const RE = /vision|vl${BACKSPACE}|omni/;`));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toContain('U+0008');
  });

  it('shows the invisible character as a marker rather than printing it', () => {
    const found = findEncodingProblems(file('src/x.ts', `a${BELL}b`));
    expect(found[0]!.evidence).toContain('<?>');
    expect(found[0]!.evidence).not.toContain(BELL);
  });

  it('leaves tabs alone, which are just indentation', () => {
    expect(findEncodingProblems(file('src/x.ts', '\tconst x = 1;'))).toEqual([]);
  });

  it('lets a file that means to hold them say so', () => {
    const marked = `/** @release-check-fixtures */\nconst nul = '${NUL}';`;
    expect(findEncodingProblems(file('tests/x.test.ts', marked))).toEqual([]);
  });

  it('finds a non-ASCII character in a PowerShell script', () => {
    // A .ps1 without a BOM is read as ANSI, and an em dash becomes a smart
    // quote that terminates a string somewhere unrelated to where it sits.
    const found = findEncodingProblems(file('start.ps1', 'Write-Host "one \u2014 two"'));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toContain('U+2014');
  });

  it('allows non-ASCII everywhere else, because only PowerShell has that problem', () => {
    expect(findEncodingProblems(file('docs/x.md', 'one \u2014 two'))).toEqual([]);
  });
});

describe('files that should never be tracked', () => {
  it('finds them by path alone', () => {
    const found = findFilesThatShouldNotBeTracked([
      '.env',
      '.env.production',
      'storage/browser-profiles/Default/Cookies',
      'storage/native-worker.pid',
      'accounts.db',
      'src/app.ts',
      '.env.example',
    ]);
    expect(found.map((f) => f.file)).toEqual([
      '.env',
      '.env.production',
      'storage/browser-profiles/Default/Cookies',
      'storage/native-worker.pid',
      'accounts.db',
    ]);
  });

  it('says why, not just that', () => {
    const [found] = findFilesThatShouldNotBeTracked(['.env']);
    expect(found!.problem).toContain('master key');
  });
});

describe('the whole check', () => {
  it('says nothing about a clean checkout', () => {
    expect(checkRelease([file('src/x.ts', 'export const x = 1;')], ['src/x.ts'])).toEqual([]);
  });

  it('reports everything at once rather than the first thing it hits', () => {
    const findings = checkRelease(
      [file('src/x.ts', "const k = 'sk-abcdefghij0123456789abcdefghij'; // C:\\Users\\jsmith\\x")],
      ['src/x.ts', '.env'],
    );
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });
});
