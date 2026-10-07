import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A port nothing is listening on that nothing may bind.
 *
 * The launcher checked whether each port it needs is already *listening*, which
 * is half the question. Hyper-V and WSL reserve blocks of ports for their own
 * dynamic use; nothing listens on those, so the check passed, and Docker then
 * failed with "ports are not available: exposing port TCP 127.0.0.1:8083 ... An
 * attempt was made to access a socket in a way forbidden by its access
 * permissions", which is not a sentence anybody can act on.
 *
 * Not hypothetical. Two installations on this machine had run for weeks on 8083
 * and 8091, and Windows later reserved 8041-8140. Nothing about either
 * installation had changed, and neither would start. A port chosen at install
 * time is not a port that stays usable, so this cannot be only an installer
 * check.
 *
 * What netsh prints on a given machine is not something a test can arrange, so
 * the parsing is a pure function over lines and this passes it real output,
 * recorded. The reservation lookup is pure outright. Both are lifted out of the
 * shipped script by name rather than transcribed, so a rename fails this rather
 * than silently testing nothing.
 */

const script = resolve(__dirname, '../../start-ai17z.ps1');
const harness = resolve(__dirname, '../support/launcherDecisions.ps1');

function findPowerShell(): string | null {
  for (const candidate of ['pwsh', 'powershell.exe', 'powershell']) {
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

interface Answer {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Every case in one process, because spawning PowerShell is the slow part. */
function ask(cases: { fn: string; args: unknown[] }[]): Answer[] {
  const out = execFileSync(
    shell!,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, '-Script', script],
    { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
  );
  return JSON.parse(out) as Answer[];
}

/**
 * Real `netsh interface ipv4 show excludedportrange protocol=tcp` output,
 * recorded on 2026-10-07 from the machine where this failed. The asterisk on
 * the last row is netsh's own mark for an administered exclusion, and the
 * footnote line below it is there because a parser that does not skip it reads
 * the explanation as a range.
 */
const NETSH = [
  '',
  'Protocol tcp Port Exclusion Ranges',
  '',
  'Start Port    End Port      ',
  '----------    --------      ',
  '      5357        5357      ',
  '      8041        8140      ',
  '      8284        8383      ',
  '      8473        8572      ',
  '      8829        8928      ',
  '      9015        9114      ',
  '      9197        9296      ',
  '      9480        9579      ',
  '     27339       27339      ',
  '     50000       50059     *',
  '',
  '* - Administered port exclusions.',
  '',
];

const describeShell = shell ? describe : describe.skip;
if (!shell) {
  // A skip is not a pass.
  console.warn('launcherPorts: no PowerShell found, so the launcher decisions were not run.');
}

describeShell('reading what Windows has reserved', () => {
  it('finds every block, and nothing that is not one', () => {
    const [answer] = ask([{ fn: 'Read-ReservedPortRanges', args: [NETSH] }]);
    expect(answer!.ok, answer!.error).toBe(true);
    const ranges = answer!.value as { Low: number; High: number }[];
    // Ten blocks: the count is checked as well as the values, because the two
    // things a parser like this gets wrong are the header rows and the
    // footnote, and either would change the count rather than a value.
    expect(ranges).toHaveLength(10);
    expect(ranges[0]).toEqual({ Low: 5357, High: 5357 });
    expect(ranges[1]).toEqual({ Low: 8041, High: 8140 });
    // The administered row carries an asterisk and is still a reservation.
    expect(ranges[9]).toEqual({ Low: 50000, High: 50059 });
    // The footnote beneath it reads as prose, not as a range.
    expect(ranges.some((r) => r.Low === 0 || r.High === 0)).toBe(false);
  });

  it('reads nothing out of output that has no ranges in it', () => {
    // A machine that answers with an error, or with nothing, must produce no
    // reservations rather than a refusal to start. The gate fails open.
    const [empty, words] = ask([
      { fn: 'Read-ReservedPortRanges', args: [[]] },
      { fn: 'Read-ReservedPortRanges', args: [['The following command was not found:', 'interface ipv4 show excludedportrange.']] },
    ]);
    expect(empty!.value).toEqual([]);
    expect(words!.value).toEqual([]);
  });
});

describeShell('deciding whether a port is inside one', () => {
  const ranges = [
    { Low: 8041, High: 8140 },
    { Low: 50000, High: 50059 },
  ];

  it('catches the two ports that actually failed', () => {
    // 8083 and 8091 are the web ports the two installations on this machine
    // were using when Windows reserved the block around them.
    const answers = ask([8083, 8091].map((port) => ({ fn: 'Get-PortReservation', args: [port, ranges] })));
    for (const answer of answers) {
      expect(answer.ok, answer.error).toBe(true);
      expect(answer.value).toEqual({ Low: 8041, High: 8140 });
    }
  });

  it('says nothing about a port outside every block', () => {
    const answers = ask([8183, 8191, 8787, 55432].map((port) => ({ fn: 'Get-PortReservation', args: [port, ranges] })));
    for (const answer of answers) {
      expect(answer.ok, answer.error).toBe(true);
      expect(answer.value).toBeNull();
    }
  });

  it('includes both ends of a block, because a range is inclusive', () => {
    // Off by one at either end is a port the launcher says is fine and Docker
    // refuses, which is exactly the failure this exists to stop.
    const [low, high, under, over] = ask(
      [8041, 8140, 8040, 8141].map((port) => ({ fn: 'Get-PortReservation', args: [port, ranges] })),
    );
    expect(low!.value).toEqual({ Low: 8041, High: 8140 });
    expect(high!.value).toEqual({ Low: 8041, High: 8140 });
    expect(under!.value).toBeNull();
    expect(over!.value).toBeNull();
  });
});

describe('the launcher asks before Docker does', () => {
  const start = readFileSync(script, 'utf8');

  it('checks reservations as well as listeners', () => {
    expect(start).toContain('Get-ReservedPortRanges');
    expect(start).toContain('Get-PortReservation');
  });

  it('says what to do, rather than passing on what Docker said', () => {
    // The whole point. Docker's own message names a socket and a permission
    // and leaves somebody looking for a program that is not there.
    expect(start).toMatch(/Windows has reserved/);
    expect(start).toContain('netsh interface ipv4 show excludedportrange protocol=tcp');
  });

  it('reports a reserved port before reporting a busy one', () => {
    // Two different problems with two different fixes. Calling a reserved port
    // "already in use" sends somebody hunting for a process that does not
    // exist, so the reservation check has to come first.
    expect(start.indexOf('$reserved = @($wanted')).toBeGreaterThan(0);
    expect(start.indexOf('$reserved = @($wanted')).toBeLessThan(start.indexOf('$taken = @($wanted'));
  });

  it('stays ASCII, like every shipped PowerShell file', () => {
    // A .ps1 without a BOM is read as ANSI, and a smart quote in it terminates
    // a string somewhere that has nothing to do with where the character is.
    // Checked by code point rather than with a pattern, because a regular
    // expression spanning the control range is itself a lint error.
    const offending = [...start].find((character) => character.codePointAt(0)! > 127);
    expect(offending, offending === undefined ? '' : `non-ASCII character ${JSON.stringify(offending)}`).toBeUndefined();
  });
});
