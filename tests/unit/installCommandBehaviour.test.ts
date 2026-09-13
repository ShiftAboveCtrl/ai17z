import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * What a refusal looks like, run rather than read.
 *
 * `install.ps1` refuses on purpose in several places -- a release that does not
 * carry the setup program, a hash that does not match, a name that is not a
 * name -- and for a while every one of those printed its polished explanation
 * and then a PowerShell error record underneath it:
 *
 *     At line:152 char:3
 *     + throw $What
 *         + CategoryInfo          : OperationStopped: (...)
 *         + FullyQualifiedErrorId : ...
 *
 * A real person pasted the command and got exactly that. The explanation above
 * it was correct and the refusal was right; the stack trace made a decision
 * look like a crash, on the one screen where somebody is deciding whether to
 * trust this.
 *
 * The sibling suite checks the shape of the file. This one runs it, because the
 * thing being asserted is what lands in a terminal and no amount of reading the
 * source proves that.
 */

const root = resolve(__dirname, '../..');
const script = resolve(root, 'install.ps1');

/** The markers PowerShell puts around an unhandled terminating error. */
const ERROR_RECORD = ['At line:', 'CategoryInfo', 'FullyQualifiedErrorId', 'RuntimeException'];

/**
 * Windows only, and not because of the shell.
 *
 * CI runs on Linux, where `pwsh` is usually installed -- so "is PowerShell
 * here" is the wrong question and answering it would have made this suite red
 * on every CI run. `install.ps1` refuses a machine that is not Windows *before*
 * it looks at anything else, which is correct, and means every refusal below
 * would come back as "AI17Z Setup installs on Windows" instead of the one being
 * tested.
 *
 * The same shape as the `node:path` trap this repository has been caught by:
 * green here, red there, and nothing local ever goes red.
 */
function findPowerShell(): string | null {
  if (process.platform !== 'win32') return null;
  for (const candidate of ['powershell.exe', 'powershell', 'pwsh']) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 30_000 });
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

const shell = findPowerShell();
const rooms: string[] = [];

afterAll(() => {
  for (const room of rooms) rmSync(room, { recursive: true, force: true });
});

/**
 * Run the real file the way the command runs it, and report everything that
 * came back.
 *
 * Read and executed as a scriptblock rather than launched with `-File`, because
 * that is what `irm ... | iex` does and the difference is the whole point: a
 * script file is what Windows' default execution policy refuses.
 *
 * The two lines after it are the test. `MARKER_ALIVE` only prints if the
 * session survived the refusal, which is what rules out `exit`, and
 * `MARKER_CODE` carries the result out for automation to read.
 */
function runRefusal(args: string): { output: string; alive: boolean; code: string; exitStatus: number } {
  const driver = [
    `& ([scriptblock]::Create((Get-Content -Raw '${script.replace(/'/g, "''")}'))) ${args}`,
    `Write-Host ('MARKER_CODE=' + $LASTEXITCODE)`,
    `Write-Host 'MARKER_ALIVE'`,
  ].join('; ');

  let output = '';
  let exitStatus = 0;
  try {
    output = execFileSync(shell!, ['-NoProfile', '-Command', driver], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    exitStatus = failure.status ?? 1;
  }
  return {
    output,
    alive: output.includes('MARKER_ALIVE'),
    code: /MARKER_CODE=(\S*)/.exec(output)?.[1] ?? '',
    exitStatus,
  };
}

describe('a refusal reads like a decision, not a crash', () => {
  it('says what is wrong and nothing else', () => {
    if (!shell) {
      console.log('SKIPPED: not Windows, so nothing was run. This is not a pass.');
      return;
    }
    // Chosen because it refuses before it touches the network: the check on a
    // tag somebody typed is the first thing that happens. A test that needed
    // GitHub to be reachable would be a test that goes red for reasons that
    // have nothing to do with this.
    const run = runRefusal('-Release "not-a-version"');

    expect(run.output).toContain('is not a release version');
    expect(run.output).toContain('Releases are named like');
    for (const marker of ERROR_RECORD) {
      expect(run.output.includes(marker), `a PowerShell error record leaked: ${marker}\n\n${run.output}`).toBe(false);
    }
  });

  it('leaves the session it was pasted into open', () => {
    if (!shell) return;
    // The reason `exit` is not used. A refusal that closes somebody's terminal
    // takes their other tabs and whatever they were doing with them.
    const run = runRefusal('-Release "not-a-version"');
    expect(run.alive, `the session did not survive the refusal:\n\n${run.output}`).toBe(true);
  });

  it('still reports failure to anything reading a result', () => {
    if (!shell) return;
    // Catching the refusal is what removes the error record, and a catch that
    // reported success would make every one of these invisible to automation.
    const run = runRefusal('-Release "not-a-version"');
    expect(run.code).toBe('1');
  });

  it('refuses a tag that could be a path, before anything is built from it', () => {
    if (!shell) return;
    const run = runRefusal('-Release "v1.0.0/../../evil"');
    expect(run.output).toContain('is not a release version');
    for (const marker of ERROR_RECORD) {
      expect(run.output.includes(marker), `error record leaked: ${marker}`).toBe(false);
    }
    expect(run.code).toBe('1');
  });

  it('writes nothing while refusing', () => {
    if (!shell) return;
    // "Nothing on this PC was changed" is a sentence this prints. It has to be
    // true, and the cheapest way to know is to give it somewhere empty to write
    // to and look afterwards.
    const room = mkdtempSync(join(tmpdir(), 'ai17z-refusal-'));
    rooms.push(room);
    const driver = [
      `$env:LOCALAPPDATA = '${room.replace(/'/g, "''")}'`,
      `& ([scriptblock]::Create((Get-Content -Raw '${script.replace(/'/g, "''")}'))) -Release "not-a-version"`,
      `Write-Host 'MARKER_ALIVE'`,
    ].join('; ');
    try {
      execFileSync(shell, ['-NoProfile', '-Command', driver], { encoding: 'utf8', timeout: 120_000 });
    } catch {
      // A refusal is not a process failure here; what matters is the directory.
    }
    expect(existsSync(join(room, 'AI17Z-setup'))).toBe(false);
    expect(readdirSync(room)).toEqual([]);
  });
});
