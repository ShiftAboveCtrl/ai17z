#!/usr/bin/env tsx
/**
 * The maintainer's private identifiers, over files on disk: an unpacked
 * release artifact, or any directory.
 *
 *   tsx tools/private-identifiers-scan.mts <dir|file>...
 *
 * The same rules and the same list as `npm run release:check` (see
 * privateIdentifiers.ts), for the bytes that are about to be attached to a
 * release rather than the files git tracks. Dependencies are not searched, for
 * the reason scan-artifact.sh gives: they are their maintainers' files.
 * Symbolic links are not followed; where they point is scanned instead, since
 * a link target is published with the link.
 *
 * A path that itself carries an identifier is printed as `file #n`, never as
 * itself, and nothing ever prints a match.
 *
 * Exit 0 clean, 1 findings, 2 the list is missing or broken. Missing is a
 * refusal here, unlike in the release check: this is only run where a list is
 * expected, so its absence means the scan proved nothing.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
  findPrivateIdentifiers,
  findPrivateIdentifiersInBytes,
  IdentifierListError,
  loadPrivateIdentifiers,
  type PrivateIdentifiers,
} from './privateIdentifiers';
import type { Finding } from './releaseCheck';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write('usage: private-identifiers-scan.mts <dir|file>...\n');
  process.exit(2);
}

let list: PrivateIdentifiers;
try {
  list = loadPrivateIdentifiers({
    env: process.env,
    home: homedir().replace(/\\/g, '/'),
    read: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        // Absent and unreadable are the same answer; the check below refuses both.
        return undefined;
      }
    },
  });
} catch (error) {
  process.stderr.write(`private identifiers: ${error instanceof IdentifierListError ? error.message : 'the list could not be read'}\n`);
  process.exit(2);
}
if (list.rules.length === 0) {
  process.stderr.write('private identifiers: none configured, so this scan cannot say anything is clean\n');
  process.exit(2);
}

const findings: Finding[] = [];
let scanned = 0;

function scanFile(absolute: string, shown: string) {
  scanned++;
  const alias = `file #${scanned}`;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    findings.push(...findPrivateIdentifiers({ path: shown, content: readlinkSync(absolute) }, list, alias).map((f) => ({ ...f, line: 0 })));
    return;
  }
  if (!stat.isFile()) return;
  const bytes = readFileSync(absolute);
  const binary = bytes.subarray(0, 8192).includes(0) || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  findings.push(
    ...(binary ? findPrivateIdentifiersInBytes(shown, bytes, list, alias) : findPrivateIdentifiers({ path: shown, content: bytes.toString('utf8') }, list, alias)),
  );
}

function walk(root: string, dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, absolute);
    else scanFile(absolute, relative(root, absolute).replace(/\\/g, '/'));
  }
}

for (const target of targets) {
  if (lstatSync(target).isDirectory()) walk(target, target);
  else scanFile(target, target.replace(/\\/g, '/').split('/').pop()!);
}

const unique = [...new Set(findings.map((f) => `  ${f.file}${f.line > 0 ? `:${f.line}` : ''}: ${f.evidence}`))];
for (const line of unique) process.stdout.write(`${line}\n`);
process.stdout.write(`private identifiers: ${scanned} files, ${list.rules.length} rules ${list.source}, findings ${unique.length}\n`);
process.exit(unique.length > 0 ? 1 : 0);
