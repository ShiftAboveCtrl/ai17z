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
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|woff2?|ttf|otf|mp4|wasm|exe|dll)$/i;

/**
 * Whether a file is binary, asked of the bytes rather than of the name.
 *
 * The extension list is a promise to have thought of every format, and it was
 * wrong the first time somebody committed one it did not know: two `.bmp` files
 * for the installer were read as UTF-8 and reported seventeen "literal control
 * character" findings, which failed the release. The rule that catches a stray
 * shell escape in source cannot tell that from an image.
 *
 * A NUL byte in the first few kilobytes is the standard test, and it is what
 * git itself uses to decide the same question.
 */
function looksBinary(absolute: string): boolean {
  const handle = openSync(absolute, 'r');
  try {
    const head = Buffer.alloc(8192);
    const read = readSync(handle, head, 0, head.length, 0);
    return head.subarray(0, read).includes(0);
  } finally {
    closeSync(handle);
  }
}

const files: FileToCheck[] = [];
for (const path of paths) {
  if (BINARY.test(path)) continue;
  try {
    const absolute = join(root, path);
    if (statSync(absolute).size > MAX_BYTES) continue;
    if (looksBinary(absolute)) continue;
    files.push({ path, content: readFileSync(absolute, 'utf8') });
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
