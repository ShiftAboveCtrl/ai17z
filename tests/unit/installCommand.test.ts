import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The command on the README, and the promises it makes.
 *
 * AI17Z is installed by pasting one line into a terminal. That is a lot of
 * trust to ask for, and it is bought with properties rather than with
 * reassurance: the thing that is fetched is short and readable at the URL in
 * the command, everything it then installs is checked against a hash published
 * by the release, and nothing anywhere turns a Windows security feature off.
 *
 * These hold the file to that. They are all about the shape of what it does,
 * because the behaviour of a first-stage installer is very hard to exercise --
 * it reaches the network before it does anything else -- and the shape is what
 * somebody reading it before they paste it is actually checking.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const install = read('install.ps1');
/**
 * The part of it that runs, without the help block at the top.
 *
 * That block explains, in words, that this never changes an execution policy
 * and never touches Defender -- so a check for those names across the whole
 * file finds the sentence promising not to and calls it a violation. The
 * promise and the code are checked separately for that reason.
 */
const installCode = install.slice(install.indexOf('[CmdletBinding()]'));
const setup = read('packaging/windows/Setup-AI17Z.ps1');
const readme = read('README.md');
// The release pipeline: what builds the Windows half, what publishes, and what
// the notes say.
const windowsBuild = read('.forgejo/scripts/build-windows-release.ps1');
const publishScript = read('.forgejo/scripts/publish-release.sh');
const notesScript = read('.forgejo/scripts/release-notes.sh');
const workflow = [read('.forgejo/workflows/package.yml'), read('.forgejo/workflows/release.yml'), windowsBuild, publishScript, notesScript].join('\n');

/** The one line a person is asked to paste. Everything else follows from it. */
const COMMAND = 'irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | iex';
/**
 * The same file from AI17Z Code, for when GitHub itself is down. The first
 * download is the one thing that cannot fall back, because nothing has run yet
 * to try elsewhere, so the second command has to be written down beside it.
 */
const FALLBACK_COMMAND = 'irm https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/install.ps1 | iex';

describe('the install command', () => {
  it('is the same line in the README, the file itself, and the release notes', () => {
    // Three places somebody could read it, and a difference between any two of
    // them is a command that works in one and not another.
    expect(readme).toContain(COMMAND);
    expect(install).toContain(COMMAND);
    expect(notesScript).toContain(COMMAND);
  });

  it('has its AI17Z Code twin written down wherever it is, for when GitHub is down', () => {
    expect(readme).toContain(FALLBACK_COMMAND);
    expect(install).toContain(FALLBACK_COMMAND);
    expect(notesScript).toContain(FALLBACK_COMMAND);
  });

  it('fetches the file the command names, from the branch the command names', () => {
    // The URL in the command and the file in the repository have to be the same
    // thing. `install.ps1` at the root is what AI17Z Code's raw path serves
    // for that path.
    expect(COMMAND).toContain('/main/install.ps1');
  });

  it('is short enough to read before running it', () => {
    // Not a rule about aesthetics. A first-stage installer that nobody reads is
    // one nobody can audit, and length is the thing that stops people reading.
    //
    // The help block is not counted: it is the explanation somebody gets when
    // they look before they paste, and making it shorter would be the wrong
    // saving.
    //
    // The number was 200 while this only resolved a release and checked a hash.
    // It went up once, deliberately, for three things that are not padding: a
    // boundary that stops a refusal printing a stack trace at somebody, a scan
    // of the release list so "try an earlier one" is never advice given without
    // evidence, and the two different explanations those two situations need.
    // Raising it again wants the same kind of argument -- a budget that moves
    // whenever it is inconvenient is not a budget.
    //
    // It went up a second time, from 280 to 380, for GitHub first with AI17Z
    // Code as the fallback: one attempt per source that says why it failed,
    // a check on the address a redirect landed on, and the explanation of a
    // failure from both. That is behaviour, not padding.
    const lines = installCode.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
    expect(lines.length, 'install.ps1 has grown past being readable in one sitting').toBeLessThan(380);
  });

  it('is ASCII, like every other PowerShell file here', () => {
    const offending = [...install].findIndex((character) => character.charCodeAt(0) > 127);
    expect(offending, `install.ps1 has a non-ASCII character at index ${offending}`).toBe(-1);
  });
});

describe('what it will and will not reach', () => {
  it('starts every request at a host it names', () => {
    expect(install).toContain('function Assert-AllowedUrl');
    expect(install).toMatch(/AllowedHosts -notcontains \$uri\.Host/);
    expect(install).toMatch(/\$uri\.Scheme -ne 'https'/);
    // GitHub, the host its downloads redirect to, and AI17Z Code. Nothing
    // else, and the same list the setup program and RELEASE_SOURCES declare.
    expect(install).toContain(
      "$AllowedHosts = @('api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'code.ai17z.io')",
    );
    expect(install).not.toMatch(/gitlab\.com/);
  });

  it('asks GitHub first and AI17Z Code second, and says when it falls back', () => {
    const github = install.indexOf("Name = 'GitHub'");
    const forgejo = install.indexOf("Name = 'AI17Z Code'");
    expect(github).toBeGreaterThan(0);
    expect(forgejo).toBeGreaterThan(github);
    expect(install).toContain('could not provide it (');
    expect(install).toContain("' from ' + $attempt.Source");
  });

  it('judges the address a redirect landed on, not only the one it asked', () => {
    const at = install.indexOf('function Invoke-Allowed');
    const body = install.slice(at, at + 700);
    expect(body).toContain('Get-AnsweredUrl');
    expect(body.indexOf('Assert-AllowedUrl $Url')).toBeLessThan(body.indexOf('Invoke-WebRequest'));
    expect(body.indexOf('Assert-AllowedUrl $answered')).toBeGreaterThan(body.indexOf('Invoke-WebRequest'));
  });

  it('checks the address before every fetch, not after', () => {
    // Every place that reaches the network has to go through the check. One
    // that does not is the one that gets used.
    const fetches = [...install.matchAll(/Invoke-WebRequest[^\n]*/g)].map((match) => match[0]);
    expect(fetches.length, 'nothing fetches anything any more').toBeGreaterThan(0);
    // One function reaches the network, and it checks before and after.
    expect(fetches.length, 'something other than Invoke-Allowed reaches the network').toBe(1);
    const at = install.indexOf('function Invoke-Allowed');
    expect(install.slice(at, at + 700)).toContain('Invoke-WebRequest');
    for (const helper of ['function Get-Text']) {
      const start = install.indexOf(helper);
      expect(install.slice(start, start + 400), `${helper} does not go through the check`).toContain('Invoke-Allowed');
    }
    expect(install).toContain('Invoke-Allowed $setupAsset.browser_download_url');
  });

  it('downloads no executable at all', () => {
    for (const url of [...install.matchAll(/https:\/\/[^\s'")]+/g)].map((match) => match[0])) {
      expect(url.endsWith('.exe'), `${url} is an executable`).toBe(false);
      expect(url.endsWith('.msi')).toBe(false);
    }
  });
});

describe('nothing runs until its hash matches', () => {
  it('refuses a setup program that does not match the release', () => {
    // Hashed in memory, out of the bytes that came back, rather than off a file
    // -- there is no file yet, and that is the point.
    expect(install).toContain('ComputeHash');
    expect(install).toMatch(/\$actual -ne \$result\.Expected/);
    const at = install.indexOf('$actual -ne $result.Expected');
    const block = install.slice(at, at + 700);
    expect(block).toContain('Stop-Install');
    expect(block).toContain('Nothing was written and nothing was run.');
  });

  it('writes the file only after the check', () => {
    // A file that failed the check never reaches the disk, so there is nothing
    // for somebody to run by mistake afterwards.
    expect(install.indexOf('$actual -ne $result.Expected')).toBeLessThan(install.indexOf('WriteAllBytes'));
  });

  it('refuses a release that publishes no hash for it', () => {
    expect(install).toContain('does not publish a hash for');
    expect(install).toContain('publishes no SHA256SUMS.txt');
  });

  it('has no way to skip the check', () => {
    // A switch that gets past the hash is the one thing that would make all of
    // this decorative.
    expect(install).not.toMatch(/SkipHash|IgnoreHash|NoVerify|SkipVerif|Insecure/i);
    // Matched rather than sliced to the first `)\n`: this file is stored with
    // LF and checked out with LF, but an editor on Windows can leave CRLF in a
    // working copy, and `indexOf(')\n')` then finds nothing, slices to -1, and
    // silently checks the whole file instead of the parameter block. It passed
    // for the wrong reason until it failed for one.
    const parameters = /param\(([\s\S]*?)\r?\n\)/.exec(install)?.[1] ?? '';
    expect(parameters, 'the parameter block could not be found').not.toBe('');
    expect(parameters, 'a parameter that could force past something').not.toMatch(/force/i);
  });

  it('checks it a second time where it is used', () => {
    // Between the hash and the execution the file sits on disk, approved. The
    // child checks it again out of its own file, which closes that gap.
    const driver = install.slice(install.indexOf('$driver = @'), install.indexOf("'@", install.indexOf('$driver = @')));
    expect(driver).toContain('ComputeHash');
    expect(driver).toContain('AI17Z_SETUP_SHA256');
    expect(driver).toContain('exit 9');
  });
});

describe('no Windows security feature is touched', () => {
  it('never changes an execution policy', () => {
    // Microsoft's default on a client is Restricted, which "permits individual
    // commands, but doesn't allow scripts". The command is individual commands,
    // and so is the way the checked bytes are run -- which is why nothing here
    // needs a policy changed, and why changing one would be the wrong answer.
    for (const forbidden of ['Set-ExecutionPolicy', '-ExecutionPolicy Bypass', '-ep bypass', 'Unblock-File']) {
      expect(installCode.includes(forbidden), `install.ps1 uses ${forbidden}`).toBe(false);
    }
    // And says so where somebody reading it will see it, including the part
    // that is easier to leave out: the shortcuts AI17Z creates for its own
    // installed scripts do pass -ExecutionPolicy Bypass to the process they
    // start. A sweeping claim that it appears nowhere would be untrue, and an
    // untrue reassurance in a file about trust is worse than no reassurance.
    expect(install).toContain('Set-ExecutionPolicy');
    expect(install).toMatch(/machine's policy is never changed/i);
    expect(install).toMatch(/-ExecutionPolicy Bypass/);
  });

  it('never touches Defender, SmartScreen or an antivirus', () => {
    for (const forbidden of [
      'Set-MpPreference',
      'Add-MpPreference',
      'ExclusionPath',
      'DisableRealtimeMonitoring',
      'Run anyway',
      'netsh advfirewall',
    ]) {
      expect(installCode.includes(forbidden), `install.ps1 mentions ${forbidden}`).toBe(false);
    }
  });

  it('runs the checked bytes in memory rather than launching a script file', () => {
    expect(install).toContain('[scriptblock]::Create(');
    // Launching the file would be subject to the execution policy, and the fix
    // for that is not to change somebody's policy.
    expect(install).not.toMatch(/powershell(\.exe)?[^\n]*-File/);
  });

  it('runs it in a child process, so finishing does not close the terminal', () => {
    // `exit` inside an invoked script block ends the host, and the host is the
    // window somebody is sitting in.
    expect(install).toContain('powershell.exe -NoProfile -Command $driver');
  });
});

describe('nothing from the network becomes code or a path', () => {
  it('passes everything variable through the environment', () => {
    // The program handed to the child is a constant. A release tag, a hash or a
    // name pasted into text that is about to be executed is the difference
    // between data and code, and this side of that line is the only safe one.
    const driver = install.slice(install.indexOf('$driver = @'), install.indexOf("'@", install.indexOf('$driver = @')));
    expect(driver).not.toMatch(/\$\(/);
    expect(driver).not.toContain('"');
    for (const name of ['AI17Z_SETUP_FILE', 'AI17Z_SETUP_SHA256']) {
      expect(driver, `${name} is not read from the environment`).toContain(name);
    }
  });

  it('never builds a path out of a release tag', () => {
    // The tag comes off the network. The file it is written to does not carry
    // any part of it.
    expect(install).toContain("'Setup-AI17Z.checked.ps1'");
    expect(install).not.toMatch(/Join-Path[^\n]*\$version/);
  });

  it('checks the tag is a version before deriving anything from it', () => {
    // The asset name is built from it, and it goes into a URL path where the
    // host allow-list cannot tell that the path underneath is the one meant. So
    // it is checked in both directions: what somebody typed, and what GitHub
    // answered with.
    expect(installCode).toContain('function Test-ReleaseTag');
    expect(installCode).toMatch(/\$Release -and -not \(Test-ReleaseTag \$Release\)/);
    expect(installCode).toMatch(/if \(-not \(Test-ReleaseTag \$tag\)\)/);

    // Refused, not repaired. A tag this does not recognise is a release it does
    // not understand, and quietly stripping the parts it dislikes would turn an
    // unknown release into a plausible-looking filename.
    const checked = installCode.slice(installCode.indexOf('if (-not (Test-ReleaseTag $tag))'));
    expect(checked.slice(0, 500)).toContain('Stop-Install');

    // And the check happens before the name is built, not after.
    expect(installCode.indexOf('if (-not (Test-ReleaseTag $tag))')).toBeLessThan(
      installCode.indexOf('$result.SetupName = [string]::Format'),
    );
  });

  it('never reads a field off a name a typed parameter owns', () => {
    // PowerShell variable names are case-insensitive, so `$release` *is*
    // `$Release` -- and `$Release` is declared `[string]`. Assigning a release
    // object to it converts the object to a string without complaining, and
    // every field read from it afterwards is empty.
    //
    // This is the worst shape of failure this language offers: not an error, a
    // wrong answer. The tag became '', the asset name became
    // `Install-AI17Z-.ps1`, and the message blamed the release for not
    // containing a file nobody had ever published. Both scripts had it, and
    // every phase of the install verifier uses `-LocalPackage`, which takes a
    // different branch -- so nothing found it until the command was run against
    // the real API.
    for (const [name, text] of [
      ['install.ps1', install],
      ['Setup-AI17Z.ps1', setup],
    ] as const) {
      expect(
        /\[string\]\s*\$Release\b/.test(text),
        `${name} no longer takes -Release; this test needs rewriting`,
      ).toBe(true);

      // Reading a field off it is the tell, and the thing that actually breaks.
      // An assignment on its own can be harmless -- inside a function or a
      // scriptblock it makes a local that shadows the parameter, which is what
      // `Get-Ai17zRelease` does, safely, because its own parameter is `$Tag`.
      // What is never safe is reading a *field* off a name a typed parameter
      // owns, because a string has no fields and the empty answer arrives
      // looking like a real one.
      //
      // Stated for every parameter rather than for this one, because the next
      // instance of it will be somewhere else.
      const parameters = /^param\(([\s\S]*?)^\)/m.exec(text)?.[1] ?? '';
      expect(parameters, `${name} has no parameter block`).not.toBe('');
      const declared = [...parameters.matchAll(/\[(?:string|switch)\]\s*\$([A-Za-z_]\w*)/g)].map((m) => m[1]);
      expect(declared.length, `${name} declares no typed parameters`).toBeGreaterThan(0);

      for (const parameter of declared) {
        for (const line of text.split(/\r?\n/)) {
          const code = line.replace(/#.*$/, '');
          const reads = new RegExp(`\\$(${parameter})\\.[A-Za-z_]`, 'gi');
          for (const found of code.matchAll(reads)) {
            expect(
              found[1] === parameter,
              `${name} reads a field off $${found[1]}, which is the typed -${parameter} parameter: ${line.trim()}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('refuses an instance name that is not a name', () => {
    expect(install).toMatch(/\$Instance -notmatch '\^\[A-Za-z0-9\]/);
    expect(install).toContain('is not a name an AI17Z installation can have');
  });

  it('cleans the environment up after itself', () => {
    expect(install).toContain("Remove-Item -Path ('Env:' + $name)");
  });
});

describe('the setup program it hands over to', () => {
  it('takes the path of the file that was checked', () => {
    // It has to be able to re-invoke itself -- for administrator rights, and to
    // continue after a restart -- and when it is run from memory there is no
    // $PSCommandPath to point at.
    expect(setup).toContain('[string] $SelfPath');
    expect(setup).toContain('if (-not $script:Ai17zScriptPath) { $script:Ai17zScriptPath = $SelfPath }');
  });

  it('reads what the command could not pass as a parameter', () => {
    for (const name of ['AI17Z_SETUP_FILE', 'AI17Z_SETUP_INSTANCE', 'AI17Z_SETUP_UPDATE', 'AI17Z_SETUP_NEW_INSTANCE']) {
      expect(setup, `${name} never reaches the setup program`).toContain(name);
    }
  });

  it('lets an explicit argument win over the environment', () => {
    expect(setup).toMatch(/if \(-not \$SelfPath -and \$env:AI17Z_SETUP_FILE\)/);
  });
});

describe('a refusal sends somebody to the right place', () => {
  /**
   * Observed, on a real machine, against a genuinely throttled address:
   *
   *   AI17Z could not work out which release to install.
   *   Nothing on this PC was changed.
   *   The remote server returned an error: (403) Forbidden.
   *
   *   Check your internet connection and run the command again.
   *
   * The connection was fine. GitHub allows sixty API requests an hour to an
   * address that is not signed in, and a shared office, a university or a cloud
   * box reaches that without anybody doing anything unusual -- so the one
   * person whose connection is provably working was the one being sent to check
   * it. An installer that answers wrong is worse than one that answers nothing.
   */
  it('does not blame the connection for a refusal', () => {
    // A refusal is recognised where each source is asked, and explained where
    // every source has failed.
    const attempt = install.slice(install.indexOf('function Get-FromSource'), install.indexOf('function Get-FailureWords'));
    expect(attempt).toMatch(/40\[39\]/);
    expect(attempt).toContain("$result.Kind = 'refused'");
    const message = install.slice(
      install.indexOf("Stop-Install 'AI17Z could not work out which release to install.'") - 900,
      install.indexOf("Stop-Install 'AI17Z could not work out which release to install.'") + 400,
    );
    expect(message).toContain("$attempt.Kind -eq 'refused'");
    expect(message).toMatch(/rate limit/i);
    // The connection is still the answer for everything that is not a refusal.
    expect(message).toContain('Check your internet connection');
  });

  it('knows a release that is not there from a network that is not working', () => {
    // `-Release v0.0.0-nope` used to answer "AI17Z could not work out which
    // release to install" and send somebody to check their connection. It
    // worked out which release perfectly well; that release does not exist, and
    // GitHub said so with a 404. Observed by running the published command on a
    // real machine, which is the only way a message like this is ever read.
    const attempt = install.slice(install.indexOf('function Get-FromSource'), install.indexOf('function Get-FailureWords'));
    expect(attempt).toMatch(/404/);
    // And only when a release was named: a 404 with none named is a different
    // thing and must not claim the person asked for something that is missing.
    expect(attempt).toContain("if ($Release -and $why -match '\\(404\\)') { $result.Kind = 'no-such-release' }");
    const explained = install.slice(install.indexOf("'no-such-release' {"), install.indexOf("'no-release' {", install.indexOf("'no-such-release' {")));
    expect(explained).toContain('There is no release called');
  });

  it('does not point at a file the clean path deletes', () => {
    // It said "Reading it afterwards: <path>". A clean run removes that file --
    // deliberately, because it is a copy of something published -- so the one
    // person who took the line at its word found nothing there and had no way
    // to know that was correct. `-KeepDownload` is the answer and the line
    // never mentioned it.
    // As something printed, not as a word: the line that replaced it quotes the
    // old wording to explain itself, exactly as the `continue-on-error` check in
    // the workflow tests had to be taught.
    const printed = install.split(/\r?\n/).filter((line) => /^\s*Write-Line/.test(line));
    expect(printed.join('\n')).not.toContain('Reading it afterwards');
    expect(install).toContain('Removed when the install finishes cleanly. Pass -KeepDownload to keep it.');
    // And the failure path still says where what ran is, because there it stays.
    expect(install).toContain('What ran is still at ');
  });

  it('says nothing about a cause the shell installers cannot know', () => {
    // `curl -f` collapses every 4xx into one exit code, and the status cannot
    // come back out of the subshell `RELEASE_JSON="$(fetch_stdout ...)"` runs
    // in. So these say what is true of every case rather than picking one.
    for (const [name, script] of [
      ['macOS', read('install-ai17z-macos.sh')],
      ['Ubuntu', read('install-ai17z-ubuntu.sh')],
    ] as const) {
      const at = script.indexOf('AI17Z could not be downloaded.');
      expect(at, `${name}: the unreachable refusal is gone`).toBeGreaterThan(-1);
      const refusal = script.slice(at, at + 500);
      expect(refusal, `${name} still blames the connection outright`).not.toMatch(
        /^\s*"Check your internet connection/m,
      );
      expect(refusal, `${name} does not mention the rate limit`).toMatch(/limit addresses that are not signed in/);
      // And it still says nothing was changed, which is the half that matters.
      expect(refusal).toMatch(/was changed/);
    }
  });
});

describe('the release publishes what the command needs', () => {
  it('publishes the setup program as a script', () => {
    expect(windowsBuild).toContain('Install-AI17Z-$Version.ps1');
    expect(publishScript).toMatch(/INSTALLABLE=\([^)]*Install-AI17Z-\*\.ps1/);
  });

  it('publishes the first stage too, so it can be pinned or compared', () => {
    expect(windowsBuild).toContain("Copy-Item 'install.ps1' 'build\\windows\\install.ps1'");
    expect(publishScript).toMatch(/INSTALLABLE=\([^)]* install\.ps1 /);
  });

  it('hashes everything the command will fetch', () => {
    const checksums = publishScript.slice(publishScript.indexOf('say "checksums"'), publishScript.indexOf('say "nothing of an owner'));
    expect(checksums).toContain('Install-AI17Z-*.ps1');
    expect(checksums).toContain('install.ps1');
    expect(checksums).toContain('AI17Z-App-*.zip');
  });

  it('no longer builds or publishes a bootstrap executable', () => {
    // The recommended route has no .exe in it at all. The only executable left
    // is the older full installer, which exists for the installations that
    // update by running one.
    expect(workflow).not.toContain('bootstrap.iss');
    expect(workflow).not.toMatch(/Install-AI17Z-[^\s'"]*\.exe/);
    expect(windowsBuild).toContain('AI17Z-Setup-$Version.exe');
  });

  it('has no signing lane left to depend on', () => {
    // The open-source signing application was refused for want of a user base.
    // A workflow that still referred to it would be describing a plan rather
    // than what happens.
    expect(workflow).not.toMatch(/signpath/i);
    expect(workflow).not.toContain('SIGNING_REQUIRED');
  });
});
