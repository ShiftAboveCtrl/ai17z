import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The machine states AI17Z Setup has to cope with, put to the code that ships.
 *
 * The installer is PowerShell, and almost everything worth testing about it is a
 * state no test machine can be in: WSL missing, WSL too old, Docker installed
 * but never started, Docker running Windows containers, Windows waiting for a
 * restart, a package whose paths escape the folder it is being written into.
 * None of those can be arranged. All of them can be passed as arguments.
 *
 * So every decision in that script is a pure function -- given what was
 * measured, say what to do -- and this dot-sources the shipped file with
 * `-LoadOnly` and calls them. What is under test is the file that goes into the
 * release, not a TypeScript transcription of it that drifts the first time
 * somebody edits one and not the other.
 *
 * `pwsh` on a Linux runner, `powershell.exe` on Windows, and a loud skip if
 * neither is there, because a skip is not a pass.
 */

const script = resolve(__dirname, '../../packaging/windows/Setup-AI17Z.ps1');
const harness = resolve(__dirname, '../support/setupDecisions.ps1');

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

interface Verdict {
  State: string;
  Action?: string;
  Message?: string;
  Fix?: string;
}

/** Every case in one process, because spawning PowerShell is the slow part. */
function ask(cases: { fn: string; args: unknown[] }[]): Answer[] {
  const out = execFileSync(
    shell!,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, '-Script', script],
    { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  const parsed = JSON.parse(out.trim()) as Answer[];
  for (const answer of parsed) {
    if (!answer.ok) throw new Error(`the setup script refused a case: ${answer.error}`);
  }
  return parsed;
}

/** One call, when a test is about one thing. */
function call<T>(fn: string, ...args: unknown[]): T {
  return ask([{ fn, args }])[0]!.value as T;
}

/**
 * Several at once, with the count checked.
 *
 * Spawning PowerShell is the slow part of this file, so a test that is about
 * four states asks about four states in one process.
 */
function askValues<T>(cases: { fn: string; args: unknown[] }[]): T[] {
  const answers = ask(cases);
  if (answers.length !== cases.length) {
    throw new Error(`asked about ${cases.length} cases and got ${answers.length} answers back`);
  }
  return answers.map((answer) => answer.value as T);
}

describe('what AI17Z Setup decides about a machine', () => {
  beforeAll(() => {
    if (!shell) return;
    expect(existsSync(script), 'the setup script is not where the release builds it from').toBe(true);
  });

  it('finds a PowerShell to run the shipped script with', () => {
    if (!shell) {
      console.log('SKIPPED: no PowerShell on this machine, so the installer was not exercised. This is not a pass.');
      return;
    }
    expect(shell).toBeTruthy();
  });

  // ---- Windows itself ------------------------------------------------------

  it('refuses a Windows older than Docker Desktop supports, and says which build', () => {
    if (!shell) return;
    const verdicts = askValues<Verdict>([
      { fn: 'Get-Ai17zWindowsVerdict', args: [18363, true, true, true] },
      { fn: 'Get-Ai17zWindowsVerdict', args: [26200, false, true, true] },
      { fn: 'Get-Ai17zWindowsVerdict', args: [19045, true, true, true] },
    ]);
    const [tooOld, old32, supported] = [verdicts[0]!, verdicts[1]!, verdicts[2]!];

    expect(tooOld.State).toBe('UNSUPPORTED');
    expect(tooOld.Message).toContain('18363');
    expect(tooOld.Fix).toContain('19045');
    expect(old32.State).toBe('UNSUPPORTED');
    // Windows 10 22H2 exactly, which is the documented floor rather than one
    // above it.
    expect(supported.State).toBe('OK');
  });

  it('stops on a machine with virtualisation turned off in firmware, because nothing here can fix that', () => {
    if (!shell) return;
    const verdict = call<Verdict>('Get-Ai17zWindowsVerdict', 26200, true, false, false);
    expect(verdict.State).toBe('NO_VIRTUALISATION');
    expect(verdict.Fix).toMatch(/BIOS|UEFI/);
  });

  it('does not treat a hypervisor that has not started as virtualisation being off', () => {
    if (!shell) return;
    // The property is absent or false on a machine where nothing has needed it
    // yet, and WSL turning it on is the next step. Refusing here would refuse
    // most machines that are about to work perfectly well.
    expect(call<Verdict>('Get-Ai17zWindowsVerdict', 26200, true, false, true).State).toBe('OK');
  });

  // ---- WSL -----------------------------------------------------------------

  it('tells the four WSL states apart', () => {
    if (!shell) return;
    const wsl = askValues<Verdict>([
      // wsl.exe not on the machine at all.
      { fn: 'Get-Ai17zWslVerdict', args: [false, '', false, false] },
      // wsl.exe exists -- it does on every Windows 10 and 11 -- but `wsl
      // --version` says nothing, and the optional component is enabled. That is
      // the old inbox WSL, and it updates rather than installs.
      { fn: 'Get-Ai17zWslVerdict', args: [true, '', false, true] },
      // Present, and below Docker Desktop's stated 2.1.5.
      { fn: 'Get-Ai17zWslVerdict', args: [true, '2.0.9', false, true] },
      { fn: 'Get-Ai17zWslVerdict', args: [true, '2.4.13.0', false, true] },
    ]);
    const [absent, legacy, tooOld, ready] = [wsl[0]!, wsl[1]!, wsl[2]!, wsl[3]!];

    expect(absent.State).toBe('ABSENT');
    expect(absent.Action).toBe('INSTALL');
    expect(legacy.State).toBe('NEEDS_UPDATE');
    expect(legacy.Action).toBe('UPDATE');
    expect(tooOld.State).toBe('NEEDS_UPDATE');
    expect(ready.State).toBe('READY');
    expect(ready.Action).toBe('NONE');
  });

  it('will not change Windows features on top of a restart Windows is already waiting for', () => {
    if (!shell) return;
    const verdict = call<Verdict>('Get-Ai17zWslVerdict', false, '', true, false);
    expect(verdict.State).toBe('RESTART_FIRST');
    expect(verdict.Action).toBe('RESTART');
  });

  it('but a pending restart does not un-ready a WSL that is already running', () => {
    if (!shell) return;
    // Somebody else's update waiting for a reboot is not a reason to refuse to
    // install AI17Z. It is a reason not to turn on a Windows feature.
    expect(call<Verdict>('Get-Ai17zWslVerdict', true, '2.4.13.0', true, true).State).toBe('READY');
  });

  it('reads a four-part WSL version against a three-part minimum', () => {
    if (!shell) return;
    const compared = askValues<boolean>([
      { fn: 'Test-Ai17zVersionAtLeast', args: ['2.4.13.0', '2.1.5'] },
      { fn: 'Test-Ai17zVersionAtLeast', args: ['2.0.9', '2.1.5'] },
      { fn: 'Test-Ai17zVersionAtLeast', args: ['2.1.5', '2.1.5'] },
      { fn: 'Test-Ai17zVersionAtLeast', args: ['', '2.1.5'] },
    ]);
    expect(compared).toEqual([true, false, true, false]);
  });

  // ---- Docker --------------------------------------------------------------

  it('tells installed, running and healthy apart, which is the whole point of it', () => {
    if (!shell) return;
    const docker = askValues<Verdict>([
      { fn: 'Get-Ai17zDockerVerdict', args: [false, false, false, false, '', false] },
      // Installed, nothing running. The state the old installer called success.
      { fn: 'Get-Ai17zDockerVerdict', args: [true, true, false, false, '', false] },
      // The application is up and the engine has not answered yet.
      { fn: 'Get-Ai17zDockerVerdict', args: [true, true, true, false, '', false] },
      { fn: 'Get-Ai17zDockerVerdict', args: [true, true, true, true, 'linux', false] },
    ]);
    const [absent, notRunning, starting, ready] = [docker[0]!, docker[1]!, docker[2]!, docker[3]!];

    expect(absent.State).toBe('ABSENT');
    expect(absent.Action).toBe('INSTALL');
    expect(notRunning.State).toBe('NOT_RUNNING');
    expect(notRunning.Action).toBe('START');
    expect(starting.State).toBe('STARTING');
    expect(starting.Action).toBe('WAIT');
    expect(ready.State).toBe('READY');
  });

  it('refuses to install onto Windows containers rather than failing later on a Linux image', () => {
    if (!shell) return;
    const verdict = call<Verdict>('Get-Ai17zDockerVerdict', true, true, true, true, 'windows', false);
    expect(verdict.State).toBe('WRONG_MODE');
    expect(verdict.Fix).toContain('Switch to Linux containers');
  });

  it('says a restart is needed when Docker has just been installed and asked for one', () => {
    if (!shell) return;
    const verdict = call<Verdict>('Get-Ai17zDockerVerdict', true, true, false, false, '', true);
    expect(verdict.State).toBe('NEEDS_RESTART');
    expect(verdict.Action).toBe('RESTART');
  });

  it('an engine that answers is ready whatever else is pending', () => {
    if (!shell) return;
    // A restart waiting on something unrelated does not make a running engine
    // stop running, and stopping here would send somebody to reboot for nothing.
    expect(call<Verdict>('Get-Ai17zDockerVerdict', true, true, true, true, 'linux', true).State).toBe('READY');
  });

  // ---- Node and Chrome -----------------------------------------------------

  it('holds the Node version this project requires and not a looser one', () => {
    if (!shell) return;
    const node = askValues<Verdict>([
      { fn: 'Get-Ai17zNodeVerdict', args: [0] },
      { fn: 'Get-Ai17zNodeVerdict', args: [20] },
      { fn: 'Get-Ai17zNodeVerdict', args: [22] },
      { fn: 'Get-Ai17zNodeVerdict', args: [24] },
    ]);
    expect(node.map((verdict) => verdict.State)).toEqual(['ABSENT', 'TOO_OLD', 'READY', 'READY']);
  });

  it('refuses Chromium and Edge at a Chrome-shaped path', () => {
    if (!shell) return;
    // The rule the rest of AI17Z already holds: identity comes from the version
    // resource, and a Chrome-shaped path is not evidence. This is the one place
    // that could quietly accept a substitute, because it is the place that
    // decides whether to install the real one.
    const browsers = askValues<Verdict>([
      { fn: 'Get-Ai17zChromeVerdict', args: ['C:\\x\\chrome.exe', 'Chromium', '140.0'] },
      { fn: 'Get-Ai17zChromeVerdict', args: ['C:\\x\\chrome.exe', 'Microsoft Edge', '140.0'] },
      { fn: 'Get-Ai17zChromeVerdict', args: ['C:\\x\\chrome.exe', 'Google Chrome', '152.0'] },
      { fn: 'Get-Ai17zChromeVerdict', args: ['', '', ''] },
    ]);
    expect(browsers.map((verdict) => verdict.State)).toEqual(['NOT_CHROME', 'NOT_CHROME', 'READY', 'ABSENT']);
    expect(browsers[0]!.Action).toBe('INSTALL');
  });

  // ---- Where an installation goes ------------------------------------------

  it('derives every path from one name', () => {
    if (!shell) return;
    const layout = call<{
      Instance: string;
      ProgramDir: string;
      DataDir: string;
      UninstallKey: string;
      StartMenuGroup: string;
    }>('Get-Ai17zLayout', 'AI17Z-test', '', '', 'C:\\Users\\x\\AppData\\Local');

    // Separators normalised, because Join-Path answers according to the
    // platform running it and this suite runs on a Linux CI machine as well.
    // What is being tested is that all five come from the one name.
    const windows = (path: string) => path.replace(/\//g, '\\');

    expect(layout.Instance).toBe('AI17Z-test');
    expect(windows(layout.ProgramDir)).toBe('C:\\Users\\x\\AppData\\Local\\Programs\\AI17Z-test');
    expect(windows(layout.DataDir)).toBe('C:\\Users\\x\\AppData\\Local\\AI17Z-test');
    expect(layout.UninstallKey).toContain('AI17Z-test');
    expect(layout.StartMenuGroup).toBe('AI17Z-test');
  });

  it('strips what Windows will not accept in a folder name', () => {
    if (!shell) return;
    const layout = call<{ Instance: string }>('Get-Ai17zLayout', 'AI17Z:probe*', '', '', 'C:\\L');
    expect(layout.Instance).toBe('AI17Zprobe');
  });

  it('refuses a name and a destination that disagree, which is the defect this exists for', () => {
    if (!shell) return;
    // Beta 1.0.0 (14) shipped an installer where everything built from the name
    // said AI17Z-probe and the files went into AI17Z-test -- so an installation
    // was named one thing, lived inside another, and its uninstaller was
    // registered to delete a program directory belonging to something else.
    //
    // Here the two values exist in one place at one moment, and disagreeing is
    // refused rather than corrected.
    const agreed = askValues<boolean>([
      { fn: 'Test-Ai17zLayoutConsistent', args: ['AI17Z-probe', 'C:\\L\\Programs\\AI17Z-test', false] },
      { fn: 'Test-Ai17zLayoutConsistent', args: ['AI17Z-probe', 'C:\\L\\Programs\\AI17Z-probe', false] },
      // Somebody who typed a directory meant that directory. The guard is about
      // a name being overridden by something discovered on the machine, which
      // is what happened, and not about an explicit choice.
      { fn: 'Test-Ai17zLayoutConsistent', args: ['AI17Z-probe', 'D:\\somewhere\\else', true] },
    ]);

    expect(agreed).toEqual([false, true, true]);
  });

  it('is not case-sensitive about it, because Windows paths are not', () => {
    if (!shell) return;
    expect(call<boolean>('Test-Ai17zLayoutConsistent', 'ai17z-Test', 'C:\\L\\Programs\\AI17Z-test', false)).toBe(true);
  });

  // ---- Which installation a run is about -----------------------------------
  //
  // A machine can hold several AI17Z installations. They are not variations of
  // one thing: each has its own agents, its own database and its own signed-in
  // browser, and the two operations somebody could mean are opposites --
  // "update this one" replaces a program directory and keeps everything else,
  // "install another" makes a new everything. Collapsing them is how an owner
  // loses an agent.

  interface Decision {
    Action: string;
    Instance: string;
    Reason: string;
  }

  const installed = (...names: string[]) => names.map((Instance) => ({ Instance }));

  it('installs the default one when there is nothing here', () => {
    if (!shell) return;
    const decision = call<Decision>('Select-Ai17zTarget', [], '', false, false, false, false);
    expect(decision.Action).toBe('INSTALL_NEW');
    expect(decision.Instance).toBe('AI17Z');
  });

  it('updates the only one rather than quietly making a second', () => {
    if (!shell) return;
    // The ordinary case: somebody runs the install command again on a machine
    // that already has AI17Z. Making a second installation there would be a
    // surprise, and the surprise would come with its own empty database.
    const decision = call<Decision>('Select-Ai17zTarget', installed('AI17Z'), '', false, false, false, false);
    expect(decision.Action).toBe('UPDATE');
    expect(decision.Instance).toBe('AI17Z');
  });

  it('asks, when there is one installation and somebody is there to answer', () => {
    if (!shell) return;
    const decision = call<Decision>('Select-Ai17zTarget', installed('AI17Z'), '', false, false, true, false);
    expect(decision.Action).toBe('ASK');
  });

  it('refuses to guess between several, and says how to say which', () => {
    if (!shell) return;
    // Nobody there to ask, and more than one answer: the only safe move is to
    // stop. Picking the first, the newest or the default is how the wrong
    // installation gets updated.
    const decision = call<Decision>(
      'Select-Ai17zTarget',
      installed('AI17Z', 'AI17Z-test', 'AI17Z-research'),
      '',
      false,
      false,
      false,
      false,
    );
    expect(decision.Action).toBe('REFUSE');
    expect(decision.Reason).toContain('3');
  });

  it('offers the choice when somebody is there', () => {
    if (!shell) return;
    const decision = call<Decision>('Select-Ai17zTarget', installed('AI17Z', 'AI17Z-test'), '', false, false, true, false);
    expect(decision.Action).toBe('CHOOSE');
  });

  it('updates the one that was named', () => {
    if (!shell) return;
    const decision = call<Decision>(
      'Select-Ai17zTarget',
      installed('AI17Z', 'AI17Z-test'),
      'AI17Z-test',
      false,
      false,
      false,
      false,
    );
    expect(decision.Action).toBe('UPDATE');
    expect(decision.Instance).toBe('AI17Z-test');
  });

  it('installs a new one under a name nothing is using', () => {
    if (!shell) return;
    const decision = call<Decision>(
      'Select-Ai17zTarget',
      installed('AI17Z'),
      'AI17Z-research',
      false,
      false,
      false,
      false,
    );
    expect(decision.Action).toBe('INSTALL_NEW');
    expect(decision.Instance).toBe('AI17Z-research');
  });

  it('will not install another one on top of a name that is taken', () => {
    if (!shell) return;
    // "Install another" and "update this one" are different requests. Asked to
    // install another *called something that already exists*, the only honest
    // answer is no -- doing it would replace the one that is there.
    const decision = call<Decision>('Select-Ai17zTarget', installed('AI17Z'), 'AI17Z', false, true, false, false);
    expect(decision.Action).toBe('REFUSE');
    expect(decision.Reason).toContain('already');
  });

  it('will not update one that is not there', () => {
    if (!shell) return;
    const decision = call<Decision>('Select-Ai17zTarget', installed('AI17Z'), 'ghost', true, false, false, false);
    expect(decision.Action).toBe('REFUSE');
    expect(decision.Reason).toContain('no AI17Z called ghost');
  });

  it('counts up to a free name when asked for another and given none', () => {
    if (!shell) return;
    const decision = call<Decision>('Select-Ai17zTarget', installed('AI17Z', 'AI17Z-2'), '', false, true, false, false);
    expect(decision.Action).toBe('INSTALL_NEW');
    expect(decision.Instance).toBe('AI17Z-3');
  });

  it('lets a caller who named the directory have it, and asks nothing', () => {
    if (!shell) return;
    // The verification harness and anybody scripting an install name the
    // program directory outright. Discovery has nothing to add there, and
    // prompting would hang a machine with nobody at it.
    const decision = call<Decision>(
      'Select-Ai17zTarget',
      installed('AI17Z', 'AI17Z-test'),
      'somewhere-else',
      false,
      false,
      false,
      true,
    );
    expect(decision.Action).toBe('INSTALL_NEW');
    expect(decision.Instance).toBe('somewhere-else');
  });

  // ---- Metadata is about how, never about where ----------------------------

  it('refuses to act on a record that describes a different folder', () => {
    if (!shell) return;
    // This is the Beta 1.0.0 (14) defect as a rule. That installer took a name,
    // built the uninstall entry and the Start Menu group from it, and wrote the
    // files into a different installation's directory -- so an installation was
    // named one thing, lived inside another, and its uninstaller was registered
    // to delete a program directory belonging to something else.
    //
    // What decides the target is where we are. A file claiming somewhere else
    // has been moved or copied, and neither is a reason to start replacing
    // program files.
    const mismatch = call<{ Ok: boolean; Reason: string }>(
      'Test-Ai17zInstallInfoTrustworthy',
      { programDir: 'C:\\L\\Programs\\AI17Z-test', instance: 'AI17Z-test' },
      'C:\\L\\Programs\\AI17Z',
    );
    expect(mismatch.Ok).toBe(false);
    expect(mismatch.Reason).toContain('AI17Z-test');
  });

  it('accepts the same folder however it is spelled', () => {
    if (!shell) return;
    const answers = askValues<{ Ok: boolean }>([
      { fn: 'Test-Ai17zInstallInfoTrustworthy', args: [{ programDir: 'C:\\L\\AI17Z' }, 'C:\\L\\AI17Z'] },
      { fn: 'Test-Ai17zInstallInfoTrustworthy', args: [{ programDir: 'C:\\L\\AI17Z\\' }, 'C:\\L\\AI17Z'] },
      { fn: 'Test-Ai17zInstallInfoTrustworthy', args: [{ programDir: 'c:\\l\\ai17z' }, 'C:\\L\\AI17Z'] },
    ]);
    expect(answers.map((answer) => answer.Ok)).toEqual([true, true, true]);
  });

  it('does not mind a folder called something other than the instance', () => {
    if (!shell) return;
    // Somebody who installed to a directory of their choosing has a folder
    // named whatever they named it. Refusing to update those would be inventing
    // a rule nobody agreed to -- and the path check is what actually catches a
    // record describing somewhere else.
    const answer = call<{ Ok: boolean }>(
      'Test-Ai17zInstallInfoTrustworthy',
      { programDir: 'D:\\apps\\work', instance: 'research' },
      'D:\\apps\\work',
    );
    expect(answer.Ok).toBe(true);
  });

  it('has nothing to disagree with when there is no record at all', () => {
    if (!shell) return;
    // An installation from before the marker existed. The fallback is what it
    // always did, and that has to keep working.
    expect(call<{ Ok: boolean }>('Test-Ai17zInstallInfoTrustworthy', null, 'C:\\L\\AI17Z').Ok).toBe(true);
  });

  // ---- A tag off the network never becomes a path --------------------------
  //
  // The release tag is the one value in this program that arrives from a remote
  // document and turns into a local filename -- `AI17Z-App-<version>.zip`, and
  // then the path under the setup folder that file is written to. GitHub will
  // not publish a tag with a separator in it today; that is a fact about GitHub
  // rather than a property of this program.

  it('takes the shapes this project actually tags with', () => {
    if (!shell) return;
    const answers = askValues<boolean>(
      ['v1.0.0', 'v1.0.0-beta.16', 'v1.0.0-rc.1', '1.2.3', 'v10.20.30-alpha.1'].map((tag) => ({
        fn: 'Test-Ai17zReleaseTag',
        args: [tag],
      })),
    );
    expect(answers).toEqual([true, true, true, true, true]);
  });

  it('refuses anything that could be a path', () => {
    if (!shell) return;
    const answers = askValues<boolean>(
      [
        'v1.0.0/../../evil',
        'v1.0.0\\..\\evil',
        '../../etc',
        'C:\\Windows',
        'v1.0.0:stream',
        '',
        'latest',
        'v1.0.0 ',
        `v1.0.0-${'x'.repeat(80)}`,
      ].map((tag) => ({ fn: 'Test-Ai17zReleaseTag', args: [tag] })),
    );
    expect(answers).toEqual([false, false, false, false, false, false, false, false, false]);
  });

  // ---- The package ---------------------------------------------------------

  it('refuses an archive entry that would be written outside the installation', () => {
    if (!shell) return;
    const cases: [string, boolean][] = [
      ['apps/api/src/index.ts', true],
      ['packaging\\windows\\ai17z.ico', true],
      ['../escape.txt', false],
      ['apps/../../escape.txt', false],
      ['..\\escape.txt', false],
      ['C:\\Windows\\System32\\evil.dll', false],
      ['/etc/passwd', false],
      ['\\\\server\\share\\x', false],
      ['', false],
    ];
    const answers = ask(cases.map(([name]) => ({ fn: 'Test-Ai17zArchiveEntryPath', args: [name] })));
    cases.forEach(([name, allowed], index) => {
      expect(answers[index]!.value, name).toBe(allowed);
    });
  });

  // ---- Ports ---------------------------------------------------------------

  it('steps past ports something else is holding, and never reuses one', () => {
    if (!shell) return;
    const chosen = call<{ Web: number; Api: number; Db: number }>('__ports', [8080, 8081, 8787, 55432, 55433]);
    expect(chosen.Web).toBe(8082);
    expect(chosen.Api).toBe(8788);
    expect(chosen.Db).toBe(55434);
  });

  it('leaves the defaults alone when nothing is holding them', () => {
    if (!shell) return;
    const chosen = call<{ Web: number; Api: number; Db: number }>('__ports', []);
    expect(chosen).toEqual({ Web: 8080, Api: 8787, Db: 55432 });
  });

  // ---- Resuming after a restart --------------------------------------------

  it('re-probes rather than trusting a note it does not recognise', () => {
    if (!shell) return;
    const answers = askValues<boolean>([
      // Written a minute ago, for this instance.
      { fn: '__resume', args: [{ schema: 1, instance: 'AI17Z', savedAt: 'AGE' }, 'AI17Z', 0.02] },
      // Yesterday's abandoned attempt. Continuing from it would skip checks.
      { fn: '__resume', args: [{ schema: 1, instance: 'AI17Z', savedAt: 'AGE' }, 'AI17Z', 30] },
      // Somebody else's installation.
      { fn: '__resume', args: [{ schema: 1, instance: 'AI17Z-test', savedAt: 'AGE' }, 'AI17Z', 0.02] },
      // A note from a version that wrote a different shape.
      { fn: '__resume', args: [{ schema: 2, instance: 'AI17Z', savedAt: 'AGE' }, 'AI17Z', 0.02] },
      // No note at all.
      { fn: '__resume', args: [null, 'AI17Z', 0] },
    ]);

    expect(answers).toEqual([true, false, false, false, false]);
  });

  // ---- The log -------------------------------------------------------------

  it('keeps secrets out of the log it writes', () => {
    if (!shell) return;
    // The log is a file on somebody's disk that they may well paste into an
    // issue, so redaction happens where it is written rather than where it is
    // read.
    // The shapes are invented rather than realistic on purpose: this repository
    // refuses to publish a file containing anything shaped like a real
    // provider key, including in a test about not printing them.
    const values = ['QQQhunter2correcthorseQQQ', 'ZZZbearertokenvalueZZZ', 'WWWmasterkeyvalueWWW'];
    const secrets = [
      `AI17Z_MASTER_KEY=${values[2]}`,
      `password: ${values[0]}`,
      `Authorization: Bearer ${values[1]}`,
      `"apiKey": "${values[1]}"`,
    ];
    const answers = ask(secrets.map((text) => ({ fn: 'Protect-Ai17zSecret', args: [text] })));
    for (const [index, answer] of answers.entries()) {
      const cleaned = String(answer.value);
      expect(cleaned, secrets[index]).toContain('<redacted>');
      for (const value of values) {
        expect(cleaned, `${secrets[index]} left ${value} in the log`).not.toContain(value);
      }
    }
  });

  it('does not redact ordinary output, which would make the log useless', () => {
    if (!shell) return;
    const line = 'docker compose build api web worker';
    expect(call<string>('Protect-Ai17zSecret', line)).toBe(line);
  });

  // ---- The long step -------------------------------------------------------
  //
  // Windows only, and not because of laziness: what these check is how
  // `Start-Process -PassThru` behaves -- an exit code that is null until the
  // handle has been cached, and a redirected file the child still holds open.
  // Those are Windows semantics, and running them against a Linux PowerShell
  // would prove something about a platform this code never runs on.
  const onWindows = process.platform === 'win32';
  const windowsOnly = (): boolean => {
    if (onWindows) return true;
    console.log('SKIPPED: the watched-process tests are about Windows semantics. This is not a pass.');
    return false;
  };

  it('watches the long step rather than blocking on it', () => {
    if (!shell || !windowsOnly()) return;
    // The first start builds three images, migrates and waits for an API:
    // minutes, on a machine that has never run it. Waited on, that is a row
    // that does not change and a spinner that does not turn -- which this
    // project calls a bug everywhere else.
    //
    // Run for real, against a child that prints what a real start prints,
    // because everything interesting here is mechanism: reading a file the
    // child still holds open, noticing when it ends, and carrying its exit code
    // back.
    const watched = call<{
      code: number;
      timedOut: boolean;
      sawBuilding: boolean;
      sawLast: boolean;
      summarised: string[];
    }>(
      '__watched',
      "Write-Host '  Building images: the api image is missing...'; Start-Sleep -Milliseconds 900; " +
        "Write-Host '  Waiting for the API...'; exit 0",
      60,
    );

    expect(watched.code).toBe(0);
    expect(watched.timedOut).toBe(false);
    // It collected the whole of the output, not only the tail.
    expect(watched.sawBuilding).toBe(true);
    expect(watched.sawLast).toBe(true);
    // And told the row what was happening while it was still happening.
    expect(watched.summarised).toContain('building');
    expect(watched.summarised).toContain('waiting');
  });

  it('carries a failing exit code back rather than reporting a start that did not happen', () => {
    if (!shell || !windowsOnly()) return;
    const watched = call<{ code: number; timedOut: boolean }>('__watched', "Write-Host 'nope'; exit 3", 60);
    expect(watched.code).toBe(3);
    expect(watched.timedOut).toBe(false);
  });

  it('gives up on something that never ends, instead of spinning for ever', () => {
    if (!shell || !windowsOnly()) return;
    // The child outlives the deadline on purpose. Setup stops watching after
    // two seconds and says so; it deliberately does not kill the child, because
    // a docker build carries on inside the daemon whatever happens to the
    // process that asked for it.
    const watched = call<{ timedOut: boolean; code: number }>('__watched', 'Start-Sleep -Seconds 8', 2);
    expect(watched.timedOut).toBe(true);
    expect(watched.code).not.toBe(0);
  }, 40_000);

  // ---- The screen ----------------------------------------------------------

  it('has a distinct shape for every state, not only a colour', () => {
    if (!shell) return;
    // Never colour alone: a red cross and a green tick are the same dot to a
    // lot of people and to every screen reader.
    //
    // Compared as code points, because the marks themselves do not survive a
    // pipe through a Windows code page -- which is also why there are two sets.
    for (const unicode of [false, true]) {
      const set = call<{ marks: number[]; spinner: number[] }>('__glyphs', unicode);
      expect(new Set(set.marks).size, `two states share a mark (unicode: ${unicode})`).toBe(set.marks.length);
      expect(set.spinner.length).toBeGreaterThan(1);
    }

    // The ASCII set is what a console with a legacy code page gets, and every
    // one of its marks has to be a character such a console can draw.
    const ascii = call<{ marks: number[]; spinner: number[] }>('__glyphs', false);
    for (const point of [...ascii.marks, ...ascii.spinner]) {
      expect(point, `code point ${point} is not printable ASCII`).toBeGreaterThan(0x20);
      expect(point).toBeLessThan(0x7f);
    }
  });
});
