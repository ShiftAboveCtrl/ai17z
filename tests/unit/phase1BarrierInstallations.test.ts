/**
 * The barrier item that reads the installations on this machine.
 *
 * Item 29, "Local AI17Z remains healthy", used to be a hardcoded UNCHECKABLE
 * carrying a sentence that said neither installed instance had been updated
 * from this stack. That sentence was true when it was written and became false
 * the day both were updated, and nothing failed: a verdict that cannot be
 * wrong cannot be right either.
 *
 * It reads each installation's own BUILD_INFO.json now, so these cases hand it
 * a Programs directory and check the verdict follows what is in it. The tool is
 * run as a subprocess rather than imported because it is a script: importing it
 * would execute the whole barrier at module load.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

/** A commit that is in this history, so an installation at it is running this code. */
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * A Programs directory holding the given installations.
 *
 * Both files are written because the tool requires both: INSTALL_INFO.json is
 * what says a setup program put the folder there, and BUILD_INFO.json is what
 * says which version is running.
 */
function programsDirWith(installs: { name: string; version: string; commit: string; buildInfo?: boolean }[]): string {
  const local = mkdtempSync(join(tmpdir(), 'ai17z-barrier-'));
  const programs = join(local, 'Programs');
  mkdirSync(programs, { recursive: true });
  for (const install of installs) {
    const dir = join(programs, install.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INSTALL_INFO.json'), JSON.stringify({ schema: 3, route: 'BOOTSTRAP', programDir: dir }));
    if (install.buildInfo !== false) {
      writeFileSync(join(dir, 'BUILD_INFO.json'), JSON.stringify({ version: install.version, commit: install.commit }));
    }
  }
  return local;
}

/** Item 29 as the tool reports it, with LOCALAPPDATA pointed at a fixture. */
function itemTwentyNine(localAppData: string): { verdict: string; evidence: string } {
  // The barrier exits non-zero while it is unsatisfied, which it is and should
  // be: three items wait on confidential hardware. So the report is read from
  // stdout either way, and only an empty stdout is a failure to run.
  let out: string;
  try {
    // node with tsx as a loader, rather than npx. npx on Windows is a .cmd,
    // and spawning one without a shell throws EINVAL, while spawning it with a
    // shell concatenates the arguments instead of escaping them. This needs
    // neither.
    out = execFileSync(process.execPath, ['--import', 'tsx', 'tools/phase1-barrier.mts', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, LOCALAPPDATA: localAppData },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    out = String((error as { stdout?: string }).stdout ?? '');
    expect(out, `the barrier produced no report: ${String((error as { stderr?: string }).stderr ?? error)}`).not.toBe('');
  }
  const report = JSON.parse(out) as { items: { n: number; verdict: string; evidence: string }[] };
  const item = report.items.find((i) => i.n === 29);
  expect(item, 'the barrier reported no item 29').toBeDefined();
  return { verdict: item!.verdict, evidence: item!.evidence };
}

describe('the barrier reads the installations rather than claiming about them', () => {
  it('is met when every installation runs a commit from this history', () => {
    const { verdict, evidence } = itemTwentyNine(
      programsDirWith([
        { name: 'AI17Z-main', version: '1.0.0-beta.64', commit: headCommit },
        { name: 'AI17Z-test', version: '1.0.0-beta.64', commit: headCommit },
      ]),
    );
    expect(verdict).toBe('MET');
    // Named, not counted: which installation is at which version is the thing
    // somebody reading this needs.
    expect(evidence).toContain('AI17Z-main runs 1.0.0-beta.64');
    expect(evidence).toContain('AI17Z-test runs 1.0.0-beta.64');
  });

  it('is not met when an installation runs a commit this checkout does not contain', () => {
    const { verdict, evidence } = itemTwentyNine(
      programsDirWith([
        { name: 'AI17Z-main', version: '1.0.0-beta.64', commit: headCommit },
        // A real-looking commit that is not in this history, which is what an
        // installation updated from somewhere else looks like.
        { name: 'AI17Z-stray', version: '1.0.0-beta.99', commit: '0123456789abcdef0123456789abcdef01234567' },
      ]),
    );
    expect(verdict).toBe('NOT_MET');
    expect(evidence).toContain('AI17Z-stray');
    expect(evidence).toContain('not a commit in this history');
  });

  it('is uncheckable when there is no installation to read, and says so rather than passing', () => {
    const { verdict, evidence } = itemTwentyNine(programsDirWith([]));
    expect(verdict).toBe('UNCHECKABLE');
    expect(evidence).toMatch(/no installation was found/i);
  });

  it('ignores a folder with no BUILD_INFO, because that is not something to speak for', () => {
    const { verdict } = itemTwentyNine(
      programsDirWith([{ name: 'AI17Z-halfway', version: '-', commit: '-', buildInfo: false }]),
    );
    expect(verdict).toBe('UNCHECKABLE');
  });
});
