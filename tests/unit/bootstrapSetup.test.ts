import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The promises AI17Z Setup makes, held to the files that make them.
 *
 * The separate `bootstrapDecisions` suite runs the script's logic. This one is
 * about the things a run cannot show: that the audit document still describes
 * the program, that the packaging ships what the updater needs, that the
 * workflow publishes what the script goes looking for, and that none of the
 * lines somebody would have to trust have quietly changed.
 *
 * The thread running through all of it: **a setup program that can install
 * system software has to be readable, and what it says about itself has to stay
 * true.** A document that drifts from the code is worse than no document,
 * because it is the one people read instead of the code.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const setup = read('packaging/windows/Setup-AI17Z.ps1');
const uninstall = read('packaging/windows/Uninstall-AI17Z.ps1');
const wrapper = read('packaging/windows/bootstrap.iss');
const installer = read('packaging/windows/ai17z.iss');
const packager = read('tools/package-windows.mts');
const workflow = read('.github/workflows/release.yml');
const audit = read('docs/SETUP_AUDIT.md');
const updater = read('update-ai17z.ps1');

/**
 * What the script declares it may do, printed by the script.
 *
 * Read by running it rather than by parsing it, so this cannot agree with a
 * regex while disagreeing with the program.
 */
interface Manifest {
  repository: string;
  allowedHosts: string[];
  minimumWindowsBuild: number;
  minimumNodeMajor: number;
  packages: { key: string; id: string; name: string; why: string; page: string }[];
  privilegedOperations: string[];
  writes: string[];
  persistence: string[];
  never: string[];
  assets: { package: string; checksums: string };
}

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
let manifest: Manifest | null = null;
if (shell) {
  const out = execFileSync(
    shell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve(root, 'packaging/windows/Setup-AI17Z.ps1'),
      '-Manifest',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  manifest = JSON.parse(out) as Manifest;
}

describe('the setup program is a file somebody can read', () => {
  it('is ASCII, like every other PowerShell file here', () => {
    // A .ps1 without a BOM is read as ANSI, and one smart quote from a pasted
    // em dash terminates a string somewhere unrelated. This has cost a release
    // once already.
    for (const [name, text] of [
      ['Setup-AI17Z.ps1', setup],
      ['Uninstall-AI17Z.ps1', uninstall],
      ['setupDecisions.ps1', read('tests/support/setupDecisions.ps1')],
    ] as const) {
      const offending = [...text].findIndex((character) => character.charCodeAt(0) > 127);
      expect(offending, `${name} has a non-ASCII character at index ${offending}`).toBe(-1);
    }
  });

  it('defines its functions and stops when asked to, which is what the tests load', () => {
    expect(setup).toContain('if ($LoadOnly) { return }');
    // Before anything that measures or changes the machine.
    expect(setup.indexOf('if ($LoadOnly) { return }')).toBeLessThan(setup.indexOf('function Measure-Ai17zMachine'));
  });

  it('the part the tests call does not need a Windows drive to exist', () => {
    // `Join-Path` resolves the drive qualifier through PowerShell's provider, so
    // `C:\Users\...` is an error on any machine with no C: drive -- which is
    // every Linux one, including the machine CI runs these functions on. It
    // passed on Windows and failed on CI, which is the same shape as the
    // `node:path` trap this repository has been caught by before.
    //
    // Only the decision half is held to this. Everything below the LoadOnly
    // return runs on Windows by definition.
    const decisions = setup.slice(0, setup.indexOf('if ($LoadOnly) { return }'));
    for (const line of decisions.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      expect(/\bJoin-Path\b/.test(line), `Join-Path in a function the tests call: ${line.trim()}`).toBe(false);
    }
    expect(setup).toContain('[System.IO.Path]::Combine(');
  });

  it('can say what it is allowed to do without doing any of it', () => {
    if (!shell) {
      console.log('SKIPPED: no PowerShell here, so the manifest was not read from the program. This is not a pass.');
      return;
    }
    expect(manifest).not.toBeNull();
    expect(manifest!.repository).toBe('ShiftAboveCtrl/ai17z');
    expect(manifest!.packages.length).toBeGreaterThan(0);
  });
});

describe('where it may go on the network', () => {
  it('starts a request only at a host it declares', () => {
    if (!shell) return;
    expect(manifest!.allowedHosts).toContain('api.github.com');
    expect(manifest!.allowedHosts).toContain('github.com');
    // GitHub redirects asset downloads to its own storage, so refusing that
    // host would refuse every download.
    expect(manifest!.allowedHosts.some((host) => host.endsWith('githubusercontent.com'))).toBe(true);
  });

  it('checks every address against that list rather than trusting the caller', () => {
    expect(setup).toContain('function Assert-Ai17zAllowedUrl');
    expect(setup).toMatch(/AllowedHosts -notcontains \$uri\.Host/);
    // HTTPS, and a refusal rather than a downgrade.
    expect(setup).toMatch(/\$uri\.Scheme -ne 'https'/);
    for (const call of ['Get-Ai17zText', 'Save-Ai17zDownload']) {
      const body = setup.slice(setup.indexOf(`function ${call} {`), setup.indexOf(`function ${call} {`) + 900);
      expect(body, `${call} does not check the address`).toContain('Assert-Ai17zAllowedUrl');
    }
  });

  it('downloads no executable of its own', () => {
    // The rule that makes the rest of this defensible. Everything installable
    // comes from winget or from Windows; the only thing fetched directly is
    // AI17Z, from AI17Z's release, checked against a hash.
    const downloads = [...setup.matchAll(/https:\/\/[^\s'")]+/g)].map((match) => match[0]);
    for (const url of downloads) {
      const allowed =
        url.includes('github.com/') ||
        url.includes('githubusercontent.com') ||
        // Vendor pages, opened in a browser when winget is not available. Never
        // fetched.
        url.includes('nodejs.org') ||
        url.includes('docker.com') ||
        url.includes('google.com/chrome') ||
        url.includes('learn.microsoft.com');
      expect(allowed, `${url} is reachable from the setup script`).toBe(true);
      expect(url.endsWith('.exe'), `${url} is an executable the script could fetch`).toBe(false);
      expect(url.endsWith('.msi')).toBe(false);
    }
  });

  it('never treats a finished download as a checked one', () => {
    expect(setup).toContain('Get-FileHash');
    expect(setup).toMatch(/\$actual -ne \$expected\.Hash/);
    // Fail closed: the file is deleted and nothing is installed.
    const at = setup.indexOf('$actual -ne $expected.Hash');
    const block = setup.slice(at, at + 900);
    expect(block).toContain('Remove-Item');
    expect(block).toContain('Stop-Ai17z');
    // And there is no way past it.
    expect(setup).not.toMatch(/SkipHash|IgnoreHash|Force.*hash/i);
  });

  it('refuses a release with no published hash rather than installing anyway', () => {
    expect(setup).toContain('There is no published SHA-256 for this release.');
    expect(setup).toContain('AI17Z Setup will not install a package it cannot check.');
  });
});

describe('what it installs, and how', () => {
  it('installs only through winget, from the Microsoft repository', () => {
    expect(setup).toContain("'--source', 'winget'");
    // No second source, which would defeat the point of using winget at all.
    const sources = [...setup.matchAll(/--source['",\s]+([a-z-]+)/gi)].map((match) => match[1]);
    for (const source of sources) expect(source).toBe('winget');
  });

  it('names the three packages and nothing else', () => {
    if (!shell) return;
    const ids = manifest!.packages.map((entry) => entry.id).sort();
    expect(ids).toEqual(['Docker.DockerDesktop', 'Google.Chrome', 'OpenJS.NodeJS.LTS']);
  });

  it('does not accept a vendor agreement on somebody else\u2019s behalf', () => {
    // --accept-package-agreements is winget's own, for the repository. Docker's
    // subscription agreement is a different thing, and Docker Desktop asks the
    // person about it on first run. Passing --accept-license here would be
    // answering it for them.
    expect(setup).toContain('--accept-package-agreements');
    expect(setup).not.toContain('--accept-license');
    expect(setup).toContain('AI17Z does not answer');
  });

  it('uses the supported Microsoft command for WSL, and asks for no distribution', () => {
    expect(setup).toContain("'--install', '--no-distribution'");
    expect(setup).toContain("'--update'");
    // Not dism, not Enable-WindowsOptionalFeature, not a registry poke.
    expect(setup).not.toMatch(/dism|Enable-WindowsOptionalFeature/i);
  });

  it('holds the Node version this repository requires', () => {
    if (!shell) return;
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(`>=${manifest!.minimumNodeMajor}`).toBe(pkg.engines?.node);
  });

  it('weakens nothing on the machine', () => {
    for (const forbidden of [
      'Set-MpPreference',
      'Add-MpPreference',
      'ExclusionPath',
      'DisableRealtimeMonitoring',
      'Run anyway',
      'netsh advfirewall',
      'Set-ExecutionPolicy',
    ]) {
      expect(setup.includes(forbidden), `the setup script mentions ${forbidden}`).toBe(false);
    }
    // SmartScreen and Defender appear exactly once each, in the sentence saying
    // it will not touch them. Anywhere else is a change to somebody's security
    // settings.
    expect([...setup.matchAll(/SmartScreen/g)].length).toBe(1);
    expect([...setup.matchAll(/Defender/g)].length).toBe(1);
    expect(setup).toContain('disable or exclude anything from Defender, SmartScreen or any antivirus');
  });

  it('leaves the machine\u2019s shared software alone when AI17Z is removed', () => {
    expect(uninstall).toContain('Docker, Node.js, Chrome and WSL were left alone.');
    expect(uninstall).not.toMatch(/winget\s+uninstall/);
  });
});

describe('elevation, and how long it lasts', () => {
  it('explains itself before the prompt appears', () => {
    expect(setup).toContain('Windows needs administrator approval');
    expect(setup).toContain('AI17Z never sees your password');
  });

  it('elevates one child for one named job rather than running elevated throughout', () => {
    expect(setup).toContain('function Invoke-Ai17zElevated');
    expect(setup).toMatch(/ValidateSet\('', 'wsl', 'packages'\)/);
    // Exactly one place starts an elevated process.
    const elevations = [...setup.matchAll(/-Verb RunAs/g)];
    expect(elevations.length).toBe(1);
  });

  it('treats a refused prompt as an answer rather than a crash', () => {
    // 1223 is ERROR_CANCELLED, which is what a dismissed UAC prompt raises.
    expect(setup).toContain('1223');
    expect(setup).toContain('Nothing on this PC was changed.');
  });

  it('installs Chrome without elevation, because Chrome does not need it', () => {
    const at = setup.indexOf("Install-Ai17zPackage 'chrome'");
    expect(at).toBeGreaterThan(-1);
    expect(setup.slice(Math.max(0, at - 400), at)).toContain('Not elevated');
  });
});

describe('what it leaves behind', () => {
  it('creates no service, no scheduled task and no Run key', () => {
    for (const persistence of ['New-Service', 'schtasks', 'Register-ScheduledTask', 'CurrentVersion\\Run']) {
      expect(setup.includes(persistence), `the setup script uses ${persistence}`).toBe(false);
    }
  });

  it('writes nothing machine-wide', () => {
    // HKLM appears, because that is where Windows records a pending restart and
    // whether the WSL service exists. Reading it is how the machine is measured;
    // writing to it would be this installation reaching outside the account that
    // ran it.
    for (const write of ['New-ItemProperty', 'Set-ItemProperty', 'New-Item -Path', 'Remove-Item -Path']) {
      for (const match of setup.matchAll(new RegExp(`${write.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`, 'g'))) {
        expect(match[0].includes('HKLM'), `writes to HKLM: ${match[0].trim()}`).toBe(false);
      }
    }
    // Everything it does record is under the user's own hive.
    expect(setup).toContain("'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'");
  });

  it('resumes a restart with a shortcut it deletes afterwards', () => {
    expect(setup).toContain('Continue AI17Z Setup');
    expect(setup).toContain('function Clear-Ai17zResume');
    // Cleared on the way out of a successful run, not only on failure.
    const end = setup.slice(setup.indexOf("Set-Ai17zStep 'verify' 'done'"));
    expect(end).toContain('Clear-Ai17zResume');
  });

  it('re-probes on resume rather than trusting the note', () => {
    expect(setup).toContain('function Test-Ai17zResumeUsable');
    expect(setup).toContain('A resume note is read, never obeyed');
  });
});

describe('what it must never touch', () => {
  it('completes the environment file and never replaces it', () => {
    const body = setup.slice(setup.indexOf('function Initialize-Ai17zEnvironment'));
    const scoped = body.slice(0, body.indexOf('function Write-Ai17zInstallInfo'));
    // Every write is conditional on the key being absent.
    expect(scoped).toMatch(/-notmatch '\(\?m\)\^\[ \\t\]\*AI17Z_WEB_PORT/);
    expect(scoped).toMatch(/-notmatch '\(\?m\)\^\[ \\t\]\*POSTGRES_PORT/);
    // [ \t] rather than \s, because .NET's \s matches a newline and "KEY=" then
    // reads as a value that is already set. That exact mistake shipped once.
    expect(scoped).not.toMatch(/\\s\*AI17Z_WEB_PORT/);
  });

  it('never writes a master key of its own', () => {
    // start-ai17z.ps1 owns that merge, and two implementations of it is two
    // places for them to disagree about a key that cannot be regenerated.
    expect(setup).not.toMatch(/AI17Z_MASTER_KEY\s*=\s*\$/);
    expect(setup).toContain("start-ai17z.ps1's");
    expect(setup).not.toContain('RandomNumberGenerator');
  });

  it('replaces only the directories the package owns', () => {
    const at = setup.indexOf('function Install-Ai17zProgram');
    const body = setup.slice(at, setup.indexOf('# ---', at + 100));
    expect(body).toContain("@('apps', 'packages', 'node_modules', 'migrations', 'docker', 'docs', 'tools', 'scripts')");
    // Never the whole program directory, and never anything under the data one.
    // The data directory appears exactly once here, written into the pointer
    // file, and nothing removes anything under it.
    expect(body).not.toMatch(/Remove-Item[^\n]*\$Layout\.ProgramDir\s+-Recurse/);
    for (const match of body.matchAll(/Remove-Item[^\n]*/g)) {
      expect(match[0].includes('DataDir'), `removes something under the data directory: ${match[0]}`).toBe(false);
    }
  });

  it('unpacks beside the installation and moves it in, so a broken download replaces nothing', () => {
    expect(setup).toContain(".ProgramDir + '.incoming'");
  });

  it('writes no byte-order mark into the files other programs read', () => {
    // `Set-Content -Encoding utf8` in Windows PowerShell writes three bytes on
    // the front. In `data-location.txt` they become part of the path `set /p`
    // reads, so the launcher looks for the owner's data in a directory that
    // does not exist and makes an empty one -- indistinguishable from having
    // lost everything. In `INSTALL_INFO.json` every parser but PowerShell's
    // refuses the document; the verification harness found that one by being
    // handed it.
    expect(setup).toContain('function Set-Ai17zText');
    expect(setup).toContain('New-Object System.Text.UTF8Encoding($false)');
    // The comment that explains all this names the cmdlet, so only lines that
    // actually call it count.
    for (const line of setup.split(/\r?\n/)) {
      if (/^\s*(#|\s*Windows PowerShell)/.test(line)) continue;
      expect(/Set-Content[^\n]*utf8/.test(line), `writes a BOM: ${line.trim()}`).toBe(false);
    }
    for (const file of ['INSTALL_INFO.json', 'data-location.txt']) {
      const at = setup.indexOf(`'${file}'`);
      expect(at, `${file} is not written any more`).toBeGreaterThan(-1);
      expect(setup.slice(at - 120, at), `${file} is written some other way`).toContain('Set-Ai17zText');
    }
  });

  it('keeps the ports an installation already chose', () => {
    expect(setup).toContain('Ports are chosen once, for an installation that has never run');
  });
});

describe('the wrapper that makes it one download', () => {
  it('carries the script and nothing else', () => {
    expect(wrapper).toContain('Source: "Setup-AI17Z.ps1"');
    expect(wrapper).toContain('CreateAppDir=no');
    expect(wrapper).toContain('Uninstallable=no');
    // Not an application installer wearing a hat: it must not lay down a
    // program directory of its own.
    expect(wrapper).not.toContain('{#StageDir}');
  });

  it('pins the release and the payload it installs', () => {
    expect(wrapper).toContain('-Release ""{#ReleaseTag}""');
    expect(wrapper).toContain('-ExpectedSha256 ""{#PackageSha256}""');
  });

  it('forwards two flags and refuses to forward anything else', () => {
    // Everything here lands on a PowerShell command line. A general pass-through
    // would make a signed executable a way to run arbitrary code, which is worth
    // less than not signing it at all.
    expect(wrapper).toContain('function CleanInstanceName');
    expect(wrapper).toMatch(/if Length\(Result\) > 48 then/);
    expect(wrapper).not.toMatch(/\{param:[A-Za-z]+\|\}[^\n]*Parameters/);
    const args = wrapper.slice(wrapper.indexOf('function ScriptArguments'));
    expect(args).toContain('-InstanceName');
    expect(args).toContain('-WhatIfOnly');
    // Nothing else is appended to that command line.
    expect([...args.matchAll(/Result := Result \+ ' -[A-Za-z]+/g)].length).toBe(2);
  });

  it('derives a four-number version the same way the installer does', () => {
    // Windows refuses a version resource with a prerelease suffix in it and
    // Inno refuses the whole script over it -- a one-second failure at the end
    // of an eight-minute build, and only on the tags that matter.
    const rule = /#define NumericVersion Pos\("-", AppVersion\) > 0 \? Copy\(AppVersion, 1, Pos\("-", AppVersion\) - 1\) : AppVersion/;
    expect(wrapper).toMatch(rule);
    expect(installer).toMatch(rule);
  });

  it('needs no administrator rights of its own', () => {
    expect(wrapper).toContain('PrivilegesRequired=lowest');
  });
});

describe('the packaging and the release agree with the script', () => {
  it('ships the setup script inside the application, because it is also the updater', () => {
    expect(packager).toContain("'packaging/windows/Setup-AI17Z.ps1'");
    expect(packager).toContain("'packaging/windows/Uninstall-AI17Z.ps1'");
    // What the installed copy needs to start, stop and be removed.
    expect(packager).toContain("'packaging/windows/AI17Z.cmd'");
    expect(packager).toContain("'packaging/windows/Stop-ForUninstall.ps1'");
  });

  it('does not ship the artwork or the scripts that draw it', () => {
    for (const never of ['make-icon', 'make-wizard-art', 'wizard-panel']) {
      expect(packager.includes(never), `${never} would be installed on somebody's machine`).toBe(false);
    }
  });

  it('builds the package under the name the script looks for', () => {
    if (!shell) return;
    // `AI17Z-App-{0}.zip` in the script, `AI17Z-App-${version}.zip` in the
    // packager, and a release asset in between. A rename in one place produces a
    // release the setup program cannot install from and a failure that names a
    // file nobody chose.
    expect(manifest!.assets.package).toBe('AI17Z-App-{0}.zip');
    expect(packager).toContain('`AI17Z-App-${version}.zip`');
    expect(workflow).toContain('AI17Z-App-${{ steps.version.outputs.version }}.zip');
    expect(manifest!.assets.checksums).toBe('SHA256SUMS.txt');
  });

  it('hashes everything it publishes, including the package', () => {
    const checksums = workflow.slice(workflow.indexOf('- name: Checksums'), workflow.indexOf('- name: Release notes'));
    expect(checksums).toContain('AI17Z-App-*.zip');
    expect(checksums).toContain('Install-AI17Z-*.exe');
    expect(checksums).toContain('Install-AI17Z-*.ps1');
  });

  it('publishes the setup script beside the executable, so the two can be compared', () => {
    expect(workflow).toContain('Install-AI17Z-$version.ps1');
    expect(workflow).toContain('-Manifest');
  });

  it('publishes an audit document built from the files it actually published', () => {
    const audit = workflow.slice(workflow.indexOf('- name: The audit document for this release'));
    expect(audit.length, 'the release publishes no audit document').toBeGreaterThan(0);
    // The release's own identity, not just the script's declaration.
    for (const fact of ['tag:', 'commit:', 'signed:', 'artifacts:']) {
      expect(audit, `the audit document does not record ${fact}`).toContain(fact);
    }
    // Built in the publish job, after signing. Signing rewrites the
    // executables, so an audit document listing the hashes of the unsigned ones
    // would be wrong about precisely the files somebody is checking.
    const publishAt = workflow.indexOf('  publish:');
    expect(workflow.indexOf('- name: The audit document for this release')).toBeGreaterThan(publishAt);
    expect(workflow).toContain('dist/AI17Z-Setup-Audit-*.json');
  });

  it('lists the full installer first, for update checks that take the first .exe', () => {
    const files = workflow.slice(workflow.lastIndexOf('files: |'));
    const installerAt = files.indexOf('AI17Z-Setup-*.exe');
    const setupAt = files.indexOf('Install-AI17Z-*.exe');
    expect(installerAt).toBeGreaterThan(-1);
    expect(setupAt).toBeGreaterThan(-1);
    expect(installerAt, 'an installation from before AI17Z Setup would be handed the wrong .exe').toBeLessThan(setupAt);
  });

  it('checks both executables before publishing either', () => {
    const check = workflow.slice(workflow.indexOf('Check the metadata SignPath requires'));
    expect(check).toContain('AI17Z-Setup-${{ steps.version.outputs.version }}.exe');
    expect(check).toContain('Install-AI17Z-${{ steps.version.outputs.version }}.exe');
  });
});

describe('an installation can say how it was installed', () => {
  it('is written by both installers, with different channels', () => {
    expect(setup).toContain("channel = 'BOOTSTRAP'");
    expect(installer).toContain('"channel": "INSTALLER"');
    // Windows paths are full of backslashes and a backslash is JSON's escape
    // character, so the installer escapes them rather than producing a document
    // the application cannot read.
    expect(installer).toContain('function JsonEscape');
  });

  it('reaches the application through the launcher, because a container has no such file', () => {
    const launcher = read('start-ai17z.ps1');
    expect(launcher).toContain('INSTALL_INFO.json');
    expect(launcher).toContain('AI17Z_INSTALL_CHANNEL');
    expect(read('docker-compose.yml')).toContain('AI17Z_INSTALL_CHANNEL: ${AI17Z_INSTALL_CHANNEL:-}');
  });

  it('is removed by an uninstall rather than left orphaned in the program directory', () => {
    expect(installer).toContain('Type: files; Name: "{app}\\INSTALL_INFO.json"');
  });
});

describe('updating a copy AI17Z Setup installed', () => {
  it('hands over to the script that installed it rather than implementing it twice', () => {
    expect(updater).toContain("$installChannel -eq 'BOOTSTRAP'");
    expect(updater).toContain('Setup-AI17Z.ps1');
    expect(updater).toContain("'-Update'");
  });

  it('names the installation rather than letting it be discovered', () => {
    // The property the published installer once got wrong: what is asked for
    // has to be what is acted on.
    expect(updater).toContain("'-ProgramDir', $PSScriptRoot");
    expect(updater).toContain("'-DataDir'");
  });

  it('still tells a checkout to pull, and an installer copy to download one', () => {
    expect(updater).toContain('This folder is not a git checkout');
    expect(updater).toContain('releases');
  });

  it('the screen says the one thing that is true for this copy', () => {
    const panel = read('apps/web/src/components/UpdatePanel.tsx');
    // Three layouts, three answers, and no branch that can fall through to the
    // wrong one: the table is keyed by the method, so a fourth method would not
    // compile rather than quietly rendering the installer's instructions.
    expect(panel).toContain("Record<UpdateState['method'], { action: string; detail: string }>");
    for (const method of ['BOOTSTRAP', 'INSTALLER', 'CHECKOUT']) {
      expect(panel, `${method} has no answer on the update screen`).toContain(`${method}: {`);
    }
    // A copy installed by AI17Z Setup is not sent to download an installer.
    const bootstrapAt = panel.indexOf('BOOTSTRAP: {');
    const bootstrapText = panel.slice(bootstrapAt, panel.indexOf('INSTALLER: {'));
    expect(bootstrapText).toContain('Update AI17Z');
    expect(bootstrapText).toContain('published hash');
    expect(bootstrapText).not.toContain('Download the installer');
  });
});

describe('the audit document describes the program it ships with', () => {
  it('names every host the script may reach', () => {
    if (!shell) return;
    for (const host of manifest!.allowedHosts) {
      expect(audit.includes(host), `${host} is not in docs/SETUP_AUDIT.md`).toBe(true);
    }
  });

  it('names every package it may install, and why', () => {
    if (!shell) return;
    for (const entry of manifest!.packages) {
      expect(audit.includes(entry.name), `${entry.name} is not in docs/SETUP_AUDIT.md`).toBe(true);
      expect(audit.includes(entry.page), `${entry.page} is not in docs/SETUP_AUDIT.md`).toBe(true);
    }
  });

  it('names the privileged operations', () => {
    if (!shell) return;
    // The command, not a paraphrase of it.
    expect(audit).toContain('wsl --install --no-distribution');
    expect(audit).toContain('winget');
    expect(manifest!.privilegedOperations.length).toBeGreaterThan(0);
  });

  it('carries the same list of things it never does, word for word', () => {
    if (!shell) return;
    // Verbatim rather than paraphrased. A list of promises is exactly the part
    // of a document that must not drift from the program, and comparing loosely
    // is how it drifts: the words change one at a time and every individual
    // change still passes.
    for (const promise of manifest!.never) {
      expect(audit.includes(promise), `"${promise}" is not in docs/SETUP_AUDIT.md`).toBe(true);
    }
  });

  it('tells people where the only official download is', () => {
    expect(audit).toContain('https://github.com/ShiftAboveCtrl/ai17z/releases');
    expect(audit).toMatch(/only from the official repository/i);
    expect(read('README.md')).toMatch(/Only install AI17Z from the official repository/i);
  });

  it('says what the hash does and does not protect against', () => {
    // Precision here is the whole point: a checksum published by the same
    // release as the package is not a defence against that release having been
    // tampered with, and saying otherwise would be the one dishonest line on
    // the page.
    expect(audit).toContain('not** a defence against a release that has itself been tampered with');
  });

  it('does not make a model the root of trust', () => {
    expect(audit).toContain('Audit this installer/bootstrap');
    expect(audit).toContain('This is a second opinion, not the root of trust');
  });

  it('tells somebody what to do when a hash does not match', () => {
    expect(audit).toMatch(/If it does not match.*stop/is);
    expect(audit).toContain('Do not run it');
  });
});
