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
 *
 * Exit 0 clean, 1 findings, 2 the list is missing or broken. Missing is a
 * refusal here, unlike in the release check: this is only run where a list is
 * expected, so its absence means the scan proved nothing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { findPrivateIdentifiers, IdentifierListError, loadPrivateIdentifiers, type PrivateIdentifiers } from './privateIdentifiers';
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
  const bytes = readFileSync(absolute);
  scanned++;
  // A binary is searched as latin1 so every byte stays one character and a
  // name embedded in it is still found; its line number means nothing.
  const binary = bytes.subarray(0, 8192).includes(0);
  const content = bytes.toString(binary ? 'latin1' : 'utf8');
  for (const f of findPrivateIdentifiers({ path: shown, content }, list)) {
    findings.push(binary ? { ...f, line: 0 } : f);
  }
}

function walk(root: string, dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, absolute);
    else if (entry.isFile()) scanFile(absolute, relative(root, absolute).replace(/\\/g, '/'));
  }
}

for (const target of targets) {
  if (statSync(target).isDirectory()) walk(target, target);
  else scanFile(target, target.replace(/\\/g, '/').split('/').pop()!);
}

const unique = [...new Set(findings.map((f) => `  ${f.file}${f.line > 0 ? `:${f.line}` : ''}: ${f.evidence}`))];
for (const line of unique) process.stdout.write(`${line}\n`);
process.stdout.write(`private identifiers: ${scanned} files, ${list.rules.length} rules ${list.source}, findings ${unique.length}\n`);
process.exit(unique.length > 0 ? 1 : 0);
