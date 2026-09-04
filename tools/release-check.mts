#!/usr/bin/env tsx
/**
 * Looks at this checkout the way a stranger receives it.
 *
 * Run before publishing. It reads what git actually tracks rather than what is
 * on disk, because the question is not "is my machine tidy" but "what does
 * somebody get when they clone this".
 *
 * Every rule lives in releaseCheck.mts, is pure, and is tested against fixtures
 * -- a check that passes only because the repository happens to be clean today
 * proves nothing about tomorrow.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease, type FileToCheck } from './releaseCheck';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const paths = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

/** Anything too big to be source is not read; it is also not what this looks for. */
const MAX_BYTES = 512 * 1024;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|wasm)$/i;

const files: FileToCheck[] = [];
for (const path of paths) {
  if (BINARY.test(path)) continue;
  try {
    if (statSync(join(root, path)).size > MAX_BYTES) continue;
    files.push({ path, content: readFileSync(join(root, path), 'utf8') });
  } catch {
    // A tracked file that cannot be read here is reported by the path rules if
    // it matters, and is not this check's business otherwise.
  }
}

const findings = checkRelease(files, paths);

process.stdout.write(`\nRelease check: ${files.length} tracked files\n\n`);

if (findings.length === 0) {
  process.stdout.write('  Nothing found. This is safe to publish as far as this can tell.\n\n');
  process.exit(0);
}

// Grouped by file, because fixing them means opening files, not reading a list.
const byFile = new Map<string, typeof findings>();
for (const finding of findings) {
  const existing = byFile.get(finding.file) ?? [];
  existing.push(finding);
  byFile.set(finding.file, existing);
}

for (const [file, group] of byFile) {
  process.stdout.write(`  ${file}\n`);
  for (const finding of group) {
    const where = finding.line > 0 ? `line ${finding.line}` : 'tracked at all';
    process.stdout.write(`    ${where}: ${finding.problem}\n`);
    process.stdout.write(`      ${finding.evidence}\n`);
  }
  process.stdout.write('\n');
}

process.stdout.write(`  ${findings.length} thing(s) to deal with before publishing.\n\n`);
process.exit(1);
