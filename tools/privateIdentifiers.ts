/**
 * Identifiers that must never be published and must never be listed publicly
 * either: a maintainer's account name, machine names, home addresses on a
 * private network. The list lives outside the repository, because a list of
 * them in a public file is the leak it exists to prevent.
 *
 * One format, shared with `.forgejo/scripts/history-scan.py` and with the
 * maintainer's own pre-push gate. One rule per line, `#` for comments:
 *
 *   <class><TAB><regex>                       a rule
 *   allow:<class>[,<class>...]<TAB><regex>    excuses hits of those classes only,
 *                                             and only where its own match on the
 *                                             same line covers the hit
 *   identity<TAB>Name <email>                 the one allowed commit identity
 *
 * allow.txt beside the list uses `<class>[,<class>...]<TAB><regex>`. An allow
 * entry that names no class is refused: an entry excusing everything is how a
 * placeholder path once carried a username through with it.
 *
 * The regex is written for Python; the subset both engines read the same way is
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
 * identifier is by definition not invented.
 *
 * Nothing here ever prints a match, and a path that itself carries an
 * identifier is never printed either: it is replaced by an alias.
 */
import type { Finding, FileToCheck } from './releaseCheck';

export interface IdentifierRule {
  /** The class, which is the only part of a rule that is ever printed. */
  name: string;
  pattern: RegExp;
}

export interface AllowRule {
  classes: Set<string>;
  pattern: RegExp;
}

export interface PrivateIdentifiers {
  rules: IdentifierRule[];
  allow: AllowRule[];
  identities: string[];
  /** Where they came from, as a sentence that names no path. */
  source: string;
}

type RuleSet = Pick<PrivateIdentifiers, 'rules' | 'allow'>;

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

function classesOf(text: string, where: string): Set<string> {
  const classes = new Set(
    text
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  );
  if (classes.size === 0) throw new IdentifierListError(`${where}: an allow entry must name the classes it excuses`);
  return classes;
}

export function parseIdentifierList(text: string, label: string): Omit<PrivateIdentifiers, 'source'> {
  const rules: IdentifierRule[] = [];
  const allow: AllowRule[] = [];
  const identities: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const where = `${label} line ${index + 1}`;
    const tab = line.indexOf('\t');
    if (tab < 0) throw new IdentifierListError(`${where}: expected <class><TAB><regex>`);
    const name = line.slice(0, tab).trim();
    const value = line.slice(tab + 1);
    if (name === 'identity') identities.push(value.trim());
    else if (name === 'allow' || name.startsWith('allow:')) {
      allow.push({ classes: classesOf(name.slice(6), where), pattern: toRegExp(value, where) });
    } else rules.push({ name, pattern: toRegExp(value, where) });
  });
  return { rules, allow, identities };
}

/** allow.txt: `<class>[,<class>...]<TAB><regex>` per line. */
export function parseAllowList(text: string, label: string): AllowRule[] {
  const out: AllowRule[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const where = `${label} line ${index + 1}`;
    const tab = line.indexOf('\t');
    if (tab < 0) throw new IdentifierListError(`${where}: expected <class>[,<class>]<TAB><regex>`);
    out.push({ classes: classesOf(line.slice(0, tab), where), pattern: toRegExp(line.slice(tab + 1), where) });
  });
  return out;
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
  if (text === undefined) return { rules: [], allow: [], identities: [], source: 'none configured' };
  const parsed = parseIdentifierList(text, 'private identifiers');
  if (parsed.rules.length === 0) throw new IdentifierListError('the private identifier list has no rules');
  const allow = [...parsed.allow, ...(allowText ? parseAllowList(allowText, 'allow list') : [])];
  return { ...parsed, allow, source };
}

/**
 * The classes of identifier in one line of text that no allow entry covers.
 *
 * Linear in the line: each class's allow spans are computed once, then every
 * hit is checked against the running maximum end of the spans that start at or
 * before it, by binary search. Re-running the allow list for every hit was
 * quadratic, and a long minified line of excused hits took minutes.
 */
export function privateHitsInLine(text: string, list: RuleSet): string[] {
  const found: string[] = [];
  for (const { name, pattern } of list.rules) {
    let spans: { starts: number[]; ends: number[] } | undefined;
    for (const m of text.matchAll(pattern)) {
      if (m[0].length === 0) continue;
      const start = m.index!;
      const end = start + m[0].length;
      if (!spans) {
        const all: [number, number][] = [];
        for (const a of list.allow) {
          if (!a.classes.has(name)) continue;
          for (const am of text.matchAll(a.pattern)) all.push([am.index!, am.index! + am[0].length]);
        }
        all.sort((x, y) => x[0] - y[0]);
        let best = -1;
        spans = { starts: all.map((s) => s[0]), ends: all.map((s) => (best = Math.max(best, s[1]))) };
      }
      let lo = 0;
      let hi = spans.starts.length - 1;
      let at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spans.starts[mid]! <= start) {
          at = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (at >= 0 && spans.ends[at]! >= end) continue;
      found.push(name);
      break;
    }
  }
  return found;
}

/**
 * Every line of a file, and its path, against the list. The evidence is the
 * class and never the match: this output is pasted into issues and CI logs. A
 * path that carries an identifier is reported as `alias`, never as itself.
 */
export function findPrivateIdentifiers(file: FileToCheck, list: RuleSet, alias = 'a file whose path is private'): Finding[] {
  if (list.rules.length === 0) return [];
  const findings: Finding[] = [];
  const pathHits = privateHitsInLine(file.path, list);
  const shown = pathHits.length > 0 ? alias : file.path;
  const push = (name: string, line: number) =>
    findings.push({ file: shown, line, problem: `A private identifier (${name}), which must never be published.`, evidence: `${name}, not shown` });
  for (const name of pathHits) push(name, 0);
  file.content.split(/\r?\n/).forEach((text, index) => {
    for (const name of privateHitsInLine(text, list)) push(name, index + 1);
  });
  return findings;
}

/**
 * Bytes that are not plain text: a binary, an image, or UTF-16 without a BOM.
 * Searched as latin1 so every byte stays one character, and again with the zero
 * bytes removed, which is what ASCII stored as UTF-16 looks like. Line numbers
 * mean nothing here, so every finding is line 0.
 */
export function findPrivateIdentifiersInBytes(path: string, bytes: Uint8Array, list: RuleSet, alias?: string): Finding[] {
  if (list.rules.length === 0) return [];
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const views = [buf.toString('latin1')];
  if (buf.subarray(0, 8192).includes(0)) views.push(Buffer.from(buf.filter((b) => b !== 0)).toString('latin1'));
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
    views.push(buf[0] === 0xff ? buf.subarray(2).toString('utf16le') : Buffer.from(buf.subarray(2)).swap16().toString('utf16le'));
  }
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const content of views) {
    for (const f of findPrivateIdentifiers({ path, content }, list, alias)) {
      const key = `${f.file}|${f.evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, line: 0 });
    }
  }
  return out;
}

/**
 * A finding from any rule with every field that carries an identifier replaced:
 * the path by `alias`, the problem and evidence by a sentence. The release
 * check's other rules quote the file and what they matched, and a home path
 * they quote is exactly what must not be printed.
 */
export function redactFinding(finding: Finding, list: RuleSet, alias: string): Finding {
  if (list.rules.length === 0) return finding;
  const dirty = (text: string) => privateHitsInLine(text, list).length > 0;
  return {
    ...finding,
    file: dirty(finding.file) ? alias : finding.file,
    problem: dirty(finding.problem) ? 'Something private, which must never be published (details withheld).' : finding.problem,
    evidence: dirty(finding.evidence) ? 'contains a private identifier, not shown' : finding.evidence,
  };
}
