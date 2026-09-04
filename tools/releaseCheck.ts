/**
 * What must not be in a published checkout.
 *
 * This repository has already shipped two of these. Seven em dashes arrived as
 * mojibake because a script read a UTF-8 file as ANSI and wrote it back. And a
 * file that had no business being public was tracked for several commits before
 * anybody looked.
 *
 * Neither was caught by a test, a typecheck, or a review, because none of those
 * are looking at the repository as a stranger would receive it. This is.
 *
 * The rules are pure and take file contents, so they are exercised against
 * fixtures rather than against whatever happens to be checked in today -- a
 * check that only passes because the repository is currently clean proves
 * nothing about the next commit.
 */

export interface Finding {
  file: string;
  line: number;
  /** What is wrong, as a sentence somebody can act on. */
  problem: string;
  /** The matched text, already reduced so a real secret is not reprinted. */
  evidence: string;
}

export interface FileToCheck {
  path: string;
  content: string;
}

/** Never printed in full, whatever it is: the output of this may be pasted anywhere. */
function redactEvidence(match: string): string {
  const trimmed = match.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)} (${trimmed.length} chars)`;
}

/**
 * Things that are secret whatever file they appear in.
 *
 * Deliberately shaped rather than named: looking for the word "password"
 * catches documentation and misses a key. These match the shape of the value.
 */
const SECRET_SHAPES: { pattern: RegExp; problem: string }[] = [
  { pattern: /sk-[A-Za-z0-9]{20,}/g, problem: 'an OpenAI-style API key' },
  { pattern: /sk-ant-[A-Za-z0-9-]{20,}/g, problem: 'an Anthropic API key' },
  { pattern: /xai-[A-Za-z0-9]{20,}/g, problem: 'an xAI API key' },
  { pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g, problem: 'a GitHub token' },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, problem: 'a private key' },
  { pattern: /BSA[A-Za-z0-9_-]{20,}/g, problem: 'a Brave Search API key' },
];

/**
 * An assignment that carries a real value rather than a placeholder.
 *
 * `.env.example` exists to be committed, so the test cannot be "does this look
 * like a key assignment" -- it has to be "does this one have something in it".
 */
const ASSIGNED_SECRET = /^\s*(?:export\s+)?([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\s*=\s*(.+)$/;

/**
 * A file that says, in itself, that its sensitive-looking content is invented.
 *
 * Test fixtures for a secret detector have to contain things shaped like
 * secrets, and fixtures for an address detector have to contain addresses. The alternative -- exempting every test file -- is worse, because a
 * real key committed to a test is still a real key. The marker is explicit,
 * greppable, and belongs to the file rather than to this list.
 */
const FIXTURE_MARKER = '@release-check-fixtures';

/** Values that are obviously not a secret, in the files meant to show the shape. */
const PLACEHOLDER = /^(?:''|""|<.*>|\.\.\.|xxx+|your[-_ ]|replace|changeme|example|placeholder|generate|sk-\.\.\.|\$\{)/i;

export function findSecrets(file: FileToCheck): Finding[] {
  if (file.content.includes(FIXTURE_MARKER)) return [];
  const findings: Finding[] = [];
  const lines = file.content.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const { pattern, problem } of SECRET_SHAPES) {
      for (const match of line.matchAll(pattern)) {
        findings.push({ file: file.path, line: index + 1, problem: `Looks like ${problem}.`, evidence: redactEvidence(match[0]) });
      }
    }

    const assigned = ASSIGNED_SECRET.exec(line);
    if (assigned) {
      const name = assigned[1]!;
      const value = assigned[2]!.replace(/^["']|["']$/g, '').trim();
      // A comment is documentation, not a value.
      const commented = /^\s*#|^\s*\/\//.test(line);
      if (!commented && value.length >= 12 && !PLACEHOLDER.test(value)) {
        findings.push({
          file: file.path,
          line: index + 1,
          problem: `${name} has a real-looking value committed to it.`,
          evidence: redactEvidence(value),
        });
      }
    }
  });

  return findings;
}

/**
 * Somebody's machine, in a file everybody gets.
 *
 * A home directory path is not a secret but it is a person's name, and it makes
 * an instruction that cannot work for the reader.
 */
export function findPersonalDetails(file: FileToCheck): Finding[] {
  // A file that declares its data invented covers this too: a test for an
  // address detector has to contain an address that looks real.
  if (file.content.includes(FIXTURE_MARKER)) return [];
  const findings: Finding[] = [];
  const lines = file.content.split(/\r?\n/);
  // Not the generic ones. C:\Users\Public names nobody, and the placeholders
  // stand in for the reader on purpose -- flagging those would teach people to
  // ignore this check, which is worse than not having it.
  const HOME_PATH =
    /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)(?!Public\b|Default\b|All Users\b|runner\b|user\b|you\b|someone\b|username\b|your-?name\b|me\b)([A-Za-z0-9._-]{2,})/g;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // Addresses that appear in documentation on purpose.
  //   .local / .internal / .invalid  reserved for exactly this, by RFC
  //   git@github.com                   an SSH remote, not somebody's address
  const ALLOWED_EMAIL =
    /@(?:example\.(?:com|test|org)|localhost|users\.noreply\.github\.com|[A-Za-z0-9.-]+\.(?:local|internal|invalid|test))\b/i;
  const SSH_REMOTE = /\b(?:git|hg)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  lines.forEach((line, index) => {
    for (const match of line.matchAll(HOME_PATH)) {
      findings.push({
        file: file.path,
        line: index + 1,
        problem: `Names somebody's home folder (${match[1]}), which is not a path the reader has.`,
        evidence: match[0],
      });
    }
    for (const match of line.matchAll(EMAIL)) {
      if (ALLOWED_EMAIL.test(match[0])) continue;
      if (SSH_REMOTE.test(match[0])) continue;
      findings.push({ file: file.path, line: index + 1, problem: 'A real email address.', evidence: match[0] });
    }
  });

  return findings;
}

/**
 * Bytes a PowerShell script cannot survive.
 *
 * A .ps1 without a BOM is read as ANSI, so an em dash becomes a smart quote
 * that terminates a string, and the script fails somewhere unrelated to where
 * the character is. Seven of these shipped in this repository, produced by a
 * script that read UTF-8 as ANSI and wrote it back.
 */
export function findEncodingProblems(file: FileToCheck): Finding[] {
  const findings: Finding[] = [];
  const isPowerShell = file.path.endsWith('.ps1');

  file.content.split(/\r?\n/).forEach((line, index) => {
    if (isPowerShell) {
      const nonAscii = [...line].find((char) => char.charCodeAt(0) > 127);
      if (nonAscii) {
        findings.push({
          file: file.path,
          line: index + 1,
          problem: `A non-ASCII character (${codePoint(nonAscii)}). PowerShell reads a .ps1 without a BOM as ANSI, and this becomes something that breaks the script somewhere else.`,
          evidence: line.trim().slice(0, 60),
        });
      }
    }

    // A control character sitting in source, in any language.
    //
    // This is not theoretical tidiness. Writing a file through a shell heredoc
    // turns `\b` into an actual backspace, and the result is a regex that
    // compiles, runs, matches nothing, and reads correctly to anybody looking
    // at it. It happened five times in one afternoon, once silently disabling
    // an allowlist in this very file and once making a vision-capable model
    // undetectable. Nothing else catches it: it is not a type error, not a
    // lint error, and not visible.
    //
    // A file that means to hold these says so, the same way a fixture says its
    // credentials are invented.
    if (!file.content.includes(FIXTURE_MARKER)) {
      const control = [...line].find((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && char !== '\t') || code === 127;
      });
      if (control) {
        findings.push({
          file: file.path,
          line: index + 1,
          problem: `A literal control character (${codePoint(control)}) in the source. Almost always a shell escape that was interpreted: write it as an escape sequence instead.`,
          // The offending characters are invisible by definition, so they are
          // shown as a marker rather than printed into somebody's terminal.
          evidence: [...line.trim().slice(0, 60)]
            .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '<?>' : char))
            .join(''),
        });
      }
    }
  });

  return findings;
}

const codePoint = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Files that should never be tracked, whatever they contain.
 *
 * The path is the whole test: a .env holds the master key every stored
 * credential is encrypted with, and a browser profile holds a live session.
 */
const NEVER_TRACKED: { pattern: RegExp; problem: string }[] = [
  { pattern: /(^|\/)\.env$/, problem: 'A .env holds the master key that every stored credential is encrypted with.' },
  { pattern: /(^|\/)\.env\.(?!example$)/, problem: 'An environment file with real values.' },
  { pattern: /(^|\/)storage\//, problem: 'The storage folder holds browser profiles and live sessions.' },
  { pattern: /\.(?:pid|log)$/, problem: 'A runtime file from somebody running it, not part of the source.' },
  { pattern: /(^|\/)accounts\.db$/, problem: 'A database of accounts.' },
  { pattern: /(^|\/)node_modules\//, problem: 'Installed dependencies.' },
];

export function findFilesThatShouldNotBeTracked(paths: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const path of paths) {
    const normalised = path.replace(/\\/g, '/');
    for (const { pattern, problem } of NEVER_TRACKED) {
      if (pattern.test(normalised)) {
        findings.push({ file: path, line: 0, problem, evidence: path });
        break;
      }
    }
  }
  return findings;
}

/** Everything, over a set of tracked files. */
export function checkRelease(files: FileToCheck[], paths: string[]): Finding[] {
  return [
    ...findFilesThatShouldNotBeTracked(paths),
    ...files.flatMap(findSecrets),
    ...files.flatMap(findPersonalDetails),
    ...files.flatMap(findEncodingProblems),
  ];
}
