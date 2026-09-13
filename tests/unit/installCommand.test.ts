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
const workflow = read('.github/workflows/release.yml');

/** The one line a person is asked to paste. Everything else follows from it. */
const COMMAND = 'irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | iex';

describe('the install command', () => {
  it('is the same line in the README, the file itself, and the release notes', () => {
    // Three places somebody could read it, and a difference between any two of
    // them is a command that works in one and not another.
    expect(readme).toContain(COMMAND);
    expect(install).toContain(COMMAND);
    expect(workflow).toContain(COMMAND);
  });

  it('fetches the file the command names, from the branch the command names', () => {
    // The URL in the command and the file in the repository have to be the same
    // thing. `install.ps1` at the root is what raw.githubusercontent serves for
    // that path.
    expect(COMMAND).toContain('/main/install.ps1');
  });

  it('is short enough to read before running it', () => {
    // Not a rule about aesthetics. A first-stage installer that nobody reads is
    // one nobody can audit, and length is the thing that stops people reading.
    //
    // The help block is not counted: it is the explanation somebody gets when
    // they look before they paste, and making it shorter would be the wrong
    // saving.
    const lines = installCode.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
    expect(lines.length, 'install.ps1 has grown past being readable in one sitting').toBeLessThan(200);
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
    for (const host of ['api.github.com', 'github.com', 'objects.githubusercontent.com']) {
      expect(install, `${host} is not in the allow-list`).toContain(host);
    }
  });

  it('checks the address before every fetch, not after', () => {
    // Every place that reaches the network has to go through the check. One
    // that does not is the one that gets used.
    const fetches = [...install.matchAll(/Invoke-WebRequest[^\n]*/g)].map((match) => match[0]);
    expect(fetches.length, 'nothing fetches anything any more').toBeGreaterThan(0);
    // Each fetch is preceded by an assertion in its own function.
    for (const helper of ['function Get-Text']) {
      const at = install.indexOf(helper);
      expect(install.slice(at, at + 400), `${helper} does not check the address`).toContain('Assert-AllowedUrl');
    }
    const download = install.indexOf('$setupAsset.browser_download_url');
    expect(install.slice(Math.max(0, download - 300), download)).toContain('Assert-AllowedUrl');
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
    expect(install).toMatch(/\$actual -ne \$expected/);
    const at = install.indexOf('$actual -ne $expected');
    const block = install.slice(at, at + 700);
    expect(block).toContain('Stop-Install');
    expect(block).toContain('Nothing was written and nothing was run.');
  });

  it('writes the file only after the check', () => {
    // A file that failed the check never reaches the disk, so there is nothing
    // for somebody to run by mistake afterwards.
    expect(install.indexOf('$actual -ne $expected')).toBeLessThan(install.indexOf('WriteAllBytes'));
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
      installCode.indexOf('$setupName = [string]::Format'),
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

describe('the release publishes what the command needs', () => {
  it('publishes the setup program as a script', () => {
    expect(workflow).toContain('Install-AI17Z-$version.ps1');
    expect(workflow).toContain('dist/Install-AI17Z-*.ps1');
  });

  it('publishes the first stage too, so it can be pinned or compared', () => {
    expect(workflow).toContain("Copy-Item 'install.ps1' 'build\\windows\\install.ps1'");
    expect(workflow).toContain('dist/install.ps1');
  });

  it('hashes everything the command will fetch', () => {
    const checksums = workflow.slice(workflow.indexOf('- name: Checksums'), workflow.indexOf('- name: The audit document'));
    expect(checksums).toContain('Install-AI17Z-*.ps1');
    expect(checksums).toContain('install.ps1');
    expect(checksums).toContain('AI17Z-App-*.zip');
  });

  it('no longer builds or publishes a bootstrap executable', () => {
    // The recommended route has no .exe in it at all. The only executable left
    // is the older full installer, which exists for the installations that
    // update by running one.
    expect(workflow).not.toContain('bootstrap.iss');
    expect(workflow).not.toContain('Install-AI17Z-${{ steps.version.outputs.version }}.exe');
    expect(workflow).toContain('AI17Z-Setup-${{ steps.version.outputs.version }}.exe');
  });

  it('has no signing lane left to depend on', () => {
    // The open-source signing application was refused for want of a user base.
    // A workflow that still referred to it would be describing a plan rather
    // than what happens.
    expect(workflow).not.toMatch(/signpath/i);
    expect(workflow).not.toContain('SIGNING_REQUIRED');
  });
});
