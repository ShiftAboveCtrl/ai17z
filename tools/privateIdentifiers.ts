/**
 * Identifiers that must never be published and must never be listed publicly
 * either: a maintainer's account name, machine names, home addresses on a
 * private network. The list lives outside the repository, because a list of
 * them in a public file is the leak it exists to prevent.
 *
 * One format, shared with `.forgejo/scripts/history-scan.py` and with the
 * maintainer's own pre-push gate: one rule per line, `<class><TAB><regex>`,
 * `#` for comments. A line whose class is `allow` excuses a known false
 * positive, and only where its own match on the same line covers the hit, so an
 * allow entry can never excuse a real identifier elsewhere on that line. The
 * regex is written for Python; the subset both engines read the same way is
 * accepted, a leading `(?i)` becomes the `i` flag, and anything else that only
 * one of them understands is refused rather than guessed at.
 *
 * Where the list comes from, first that is set:
 *   PRIVATE_IDENTIFIERS        the content itself (a CI secret)
 *   PRIVATE_IDENTIFIERS_FILE   a path
 *   ~/.config/private-identifiers/identifiers.txt, with allow.txt beside it
 * Nothing set is not a failure here, because a contributor has no such list,
 * but it is always said out loud.
 *
 * Unlike every other rule in the release check, these are not excused by the
 * `@release-check-fixtures` marker. A fixture is invented data, and a real
 * identifier is by definition not invented: the marker is exactly how one
 * would slip through.
 */
import type { Finding, FileToCheck } from './releaseCheck';

export interface IdentifierRule {
  /** The class, which is the only part of a rule that is ever printed. */
  name: string;
  pattern: RegExp;
}

export interface PrivateIdentifiers {
  rules: IdentifierRule[];
  allow: RegExp[];
  /** Where they came from, as a sentence that names no path. */
  source: string;
}

/** A rule this engine would read differently from Python, or not at all. */
export class IdentifierListError extends Error {}

export function toRegExp(source: string, where: string): RegExp {
  let body = source;
  let flags = 'g';
  if (body.startsWith('(?i)')) {
    body = body.slice(4);
    flags += 'i';
  }
  // Python's named groups, inline flags anywhere else, and \A \Z mean
  // something else or nothing in JavaScript.
  if (/\(\?P|\(\?[aiLmsux-]+[:)]|\\[AZ]/.test(body)) {
    throw new IdentifierListError(`${where}: uses regex syntax only Python reads; rewrite it in the shared subset`);
  }
  try {
    return new RegExp(body, flags);
  } catch {
    throw new IdentifierListError(`${where}: is not a valid regular expression`);
  }
}

export function parseIdentifierList(text: string, label: string): { rules: IdentifierRule[]; allow: RegExp[] } {
  const rules: IdentifierRule[] = [];
  const allow: RegExp[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const tab = line.indexOf('\t');
    if (tab < 0) throw new IdentifierListError(`${label} line ${index + 1}: expected <class><TAB><regex>`);
    const name = line.slice(0, tab).trim();
    const pattern = toRegExp(line.slice(tab + 1), `${label} line ${index + 1}`);
    if (name === 'allow') allow.push(pattern);
    else rules.push({ name, pattern });
  });
  return { rules, allow };
}

/** One regex per line, the format of allow.txt beside the list. */
export function parseAllowList(text: string, label: string): RegExp[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim() && !line.trimStart().startsWith('#'))
    .map(({ line, index }) => toRegExp(line, `${label} line ${index + 1}`));
}

export interface IdentifierSources {
  env: Record<string, string | undefined>;
  home: string;
  read: (path: string) => string | undefined;
}

/** Resolves the list. Pure over its arguments so the order can be tested. */
export function loadPrivateIdentifiers({ env, home, read }: IdentifierSources): PrivateIdentifiers {
  const fromDefault = `${home}/.config/private-identifiers`;
  let text: string | undefined;
  let source: string;
  let allowText: string | undefined;
  if (env.PRIVATE_IDENTIFIERS?.trim()) {
    text = env.PRIVATE_IDENTIFIERS;
    source = 'from $PRIVATE_IDENTIFIERS';
  } else if (env.PRIVATE_IDENTIFIERS_FILE) {
    text = read(env.PRIVATE_IDENTIFIERS_FILE);
    if (text === undefined) throw new IdentifierListError('PRIVATE_IDENTIFIERS_FILE names a file that cannot be read');
    source = 'from $PRIVATE_IDENTIFIERS_FILE';
    allowText = env.PRIVATE_IDENTIFIERS_ALLOW_FILE ? read(env.PRIVATE_IDENTIFIERS_ALLOW_FILE) : undefined;
  } else {
    text = read(`${fromDefault}/identifiers.txt`);
    source = 'from ~/.config/private-identifiers';
    allowText = read(`${fromDefault}/allow.txt`);
  }
  if (text === undefined) return { rules: [], allow: [], source: 'none configured' };
  const parsed = parseIdentifierList(text, 'private identifiers');
  if (parsed.rules.length === 0) throw new IdentifierListError('the private identifier list has no rules');
  const allow = [...parsed.allow, ...(allowText ? parseAllowList(allowText, 'allow list') : [])];
  return { rules: parsed.rules, allow, source };
}

function excused(line: string, start: number, end: number, allow: RegExp[]): boolean {
  return allow.some((rx) => {
    // toRegExp always sets g, which matchAll needs; matchAll works on a copy,
    // so the shared regex keeps no lastIndex between files.
    for (const m of line.matchAll(rx)) {
      if (m.index! <= start && m.index! + m[0].length >= end) return true;
    }
    return false;
  });
}

/**
 * Every line of a file, and its path, against the list. The evidence is the
 * class and never the match: this output is pasted into issues and CI logs.
 */
export function findPrivateIdentifiers(file: FileToCheck, list: Pick<PrivateIdentifiers, 'rules' | 'allow'>): Finding[] {
  if (list.rules.length === 0) return [];
  const findings: Finding[] = [];
  const check = (text: string, line: number) => {
    for (const { name, pattern } of list.rules) {
      for (const m of text.matchAll(pattern)) {
        if (m[0].length === 0) continue;
        if (excused(text, m.index!, m.index! + m[0].length, list.allow)) continue;
        findings.push({
          file: file.path,
          line,
          problem: `A private identifier (${name}), which must never be published.`,
          evidence: `${name}, not shown`,
        });
        break;
      }
    }
  };
  check(file.path, 0);
  file.content.split(/\r?\n/).forEach((text, index) => check(text, index + 1));
  return findings;
}
