import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What a failed install attempt means, decided deterministically.
 *
 * Release qualification used to depend on the anonymous GitHub API answering:
 * sixty requests an hour to an address a hosted runner shares with whoever else
 * is on it. Two of the last three releases failed a qualification job on that
 * and needed the owner to press re-run, for a release the other runner had
 * installed perfectly from the same URLs.
 *
 * The package is proved from the tag's own asset now, which needs no API at
 * all. What is left of the anonymous path is a smoke test of what a stranger
 * runs, and its failure semantics are pinned here rather than discovered on a
 * runner: these cases run the real shell function with canned inputs, so every
 * branch is exercised on every suite run without a network.
 */
const script = resolve(__dirname, '../../.github/scripts/qualify-attempt-verdict.sh');

/** Runs the real function under bash, exactly as the qualifiers call it. */
function verdict(code: number, text: string): string {
  return execFileSync(
    'bash',
    ['-c', `. "$1"; attempt_verdict "$2" "$3"`, 'sh', script, String(code), text],
    { encoding: 'utf8' },
  ).trim();
}

function retries(code: number): boolean {
  const out = execFileSync(
    'bash',
    ['-c', `. "$1"; if should_retry "$2"; then echo yes; else echo no; fi`, 'sh', script, String(code)],
    { encoding: 'utf8' },
  ).trim();
  return out === 'yes';
}

describe('reading one install attempt', () => {
  it('calls a success a success', () => {
    expect(verdict(0, 'AI17Z installed')).toBe('OK');
    // And never retries one.
    expect(retries(0)).toBe(false);
  });

  it('recognises the shared anonymous ceiling in the shapes it actually takes', () => {
    // curl's own line, seen verbatim in the Beta 4.7 arm64 log.
    expect(verdict(1, 'curl: (56) The requested URL returned error: 403')).toBe('CEILING');
    expect(verdict(1, 'HTTP 429 Too Many Requests')).toBe('CEILING');
    expect(verdict(1, 'API rate limit exceeded for 20.1.2.3')).toBe('CEILING');
    expect(verdict(1, 'Retry-After: 120')).toBe('CEILING');
    // The installer's own sentence when it could not resolve the release.
    expect(verdict(1, 'Release v1.0.0-beta.37 could not be read.')).toBe('CEILING');
  });

  it('does not call an empty failure a rate limit', () => {
    /*
      The defect this whole seam exists for. A job matched a rate-limit code in
      output that was empty on every run, because the installer writes through
      the host stream and only the error stream was captured. An empty string is
      not evidence of anything, least of all of a quota.
    */
    expect(verdict(1, '')).toBe('FAILED');
    expect(verdict(1, '   \n  ')).toBe('FAILED');
  });

  it('calls a broken package a failure rather than bad luck', () => {
    // These must never be excused as infrastructure, or a genuinely broken
    // release passes qualification on a quiet runner.
    expect(verdict(1, 'tar: Unexpected EOF in archive')).toBe('FAILED');
    expect(verdict(1, 'SHA-256 does not match')).toBe('FAILED');
    expect(verdict(2, 'cannot execute binary file')).toBe('FAILED');
  });

  it('treats a transient network error as a failure worth one more try', () => {
    // Not a ceiling: nothing about it says GitHub refused. Still retried,
    // because the retry turns on the attempt having failed.
    expect(verdict(1, 'curl: (28) Operation timed out after 30000 ms')).toBe('FAILED');
    expect(verdict(1, 'curl: (6) Could not resolve host: github.com')).toBe('FAILED');
    expect(retries(1)).toBe(true);
    expect(retries(28)).toBe(true);
  });

  it('retries on the attempt failing, whatever it printed', () => {
    // Every non-zero exit is worth exactly one more go, including the empty one
    // that the old text match could never see.
    for (const code of [1, 2, 6, 28, 56, 127]) expect(retries(code)).toBe(true);
  });
});

describe('the qualifiers use this and do not rewrite it', () => {
  it('is sourced rather than copied into each script', () => {
    for (const file of ['qualify-published-macos.sh', 'qualify-published-ubuntu.sh']) {
      const source = readFileSync(resolve(__dirname, '../../.github/scripts', file), 'utf8');
      expect(source, `${file} does not source the shared verdict`).toContain('qualify-attempt-verdict.sh');
    }
  });
});
