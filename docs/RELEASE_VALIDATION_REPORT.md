# Release validation

What was checked before a release was published, how, and what it found. Every
claim here is something somebody ran; anything taken on trust says so, and the
last section is the list of things this release did not verify.

The release workflow attaches this file to the release.

---

## Hosted platform validation

Every platform package is now built on a runner that really is that
architecture, on every push, and then run. `.github/workflows/platform-packaging.yml`
does it and publishes nothing; it calls the same actions under `.github/actions/`
that the release workflow calls, so what it proves is what a release ships.

Before this, the macOS and Ubuntu jobs had never executed. The first four runs
found five faults that would otherwise have appeared for the first time in a
release.

### The runners

| Job | Runner | Result |
| --- | --- | --- |
| macOS arm64 | `macos-15` (Apple Silicon) | green |
| macOS Intel | `macos-15-intel` | green |
| Ubuntu amd64 | `ubuntu-24.04` | green |
| Ubuntu arm64 | `ubuntu-24.04-arm` | green |
| Ubuntu 22.04 takes the package | container on `ubuntu-24.04` | green |
| Ubuntu 24.04 takes the package | container on `ubuntu-24.04` | green |
| Ubuntu 26.04 takes the package | container on `ubuntu-24.04` | green |
| the release contract | `ubuntu-24.04` | green |

The labels are named exactly rather than through `macos-latest`, which moves
between major versions *and* between architectures. The workflow asked for
`macos-13` until this pass, and that image was retired in December 2025 -- so a
release built from it would have waited for a runner that no longer answers.

### What the hosted jobs actually run

On each platform, against the package that job just built:

- the bundled Node starts, and reports the architecture and platform it should
- `file` confirms the Node binary and `@esbuild/<platform>/bin/esbuild` are
  genuinely that architecture, rather than the runtime's own opinion of itself
- esbuild runs
- tsx transforms TypeScript
- every workspace package imports -- ten of them, which is how a package with
  every file present but nothing loadable is caught
- `BUILD_INFO.json` and `VERSION` agree with the build
- the launcher runs from a path with a space in it
- an unknown command is refused
- root is refused
- the owner's directories are created 0700, beside the program and never inside
  it
- `doctor` produces a report from a packaged layout
- the compatibility gate answers OK and NO, and treats a missing Chrome as a
  note rather than a refusal
- the fail-closed decision: a pre-gate installation carries on, a current one
  with a broken gate refuses
- the real installer installs, reruns without losing the master key, refuses a
  downgrade, and leaves the owner's data alone on uninstall
- the finished artifact is unpacked and scanned for anything of an owner's or a
  builder's

### The faults it found

1. **`npm run package:unix` had never worked.** It imports the deny-list from
   the Windows packager, and that file ended in a bare top-level `await main()`
   -- so importing it ran the Windows packager. It is the first step of both
   platform jobs.
2. **Neither Unix build made a compiled binary executable.** The rule gave the
   executable bit to anything with a `#!` line, written with `grep -I`, which
   skips binary files by design. `@esbuild/<platform>/bin/esbuild` shipped at
   0644 -- and that is what every `tsx` process an installed copy runs shells
   out to. The package installed and the first migration died with EACCES.
3. **The real `.deb` failed lintian.** `test-deb.sh` builds from a stand-in
   stage with no dependency tree, so it never saw the sixteen errors a real one
   produces.
4. **The macOS installer's cleanup attacked a mounted volume.** The Docker path
   mounts a disk image inside the work directory; `rm -rf` on a mounted
   read-only volume walks the whole of Docker.app printing errors and leaves it
   mounted.
5. **It waited for a keypress that could not come.** With no terminal, `read`
   returned at once and the script carried on as though Docker's setup had been
   finished.

And one thing the hosted run found that no packaging test could: the installer
never told anybody the package is unsigned. The README says it, the trust
document leads with it, and there was a test asserting the installer "says
plainly that it is not signed or notarized" -- which passed, because it was
reading a comment in the source.

### What the artifacts were

A green run produced, and retained without publishing:

    macos-arm64         77,074,839 bytes
    macos-x64           80,251,364 bytes
    ubuntu-amd64        55,333,483 bytes
    ubuntu-arm64        52,934,681 bytes
    release-contract         1,467 bytes   (SHA256SUMS.txt + release-manifest.json)

The contract job checks that every artifact the manifest names exists, and that
each package carries the architecture its name claims -- after an upload and a
download, over the finished files.

### Still BLOCKED, and narrowly

- **Docker Desktop's own install on macOS.** A hosted Mac has no Docker and
  cannot be given one without a person: a disk image, a graphical setup, and
  Docker's own licence, which AI17Z must never accept for somebody. The
  `docker` command is answered at the vendor boundary so the rest of the
  installer can be tested; the download, the image, the licence and the first
  run are not reachable and are not claimed.
- **Gatekeeper and quarantine as a person meets them** -- a downloaded file's
  quarantine attribute, the dialog, Terminal's paste protection. Nothing in a
  headless runner represents those.
- **A real X sign-in**, on either platform.
- **Chrome on Ubuntu**, which needs a graphical session.
- **A physical reboot.**

## Cross-platform: macOS and Ubuntu

Not a release of its own yet. This records what was proved while building the
macOS and Ubuntu platforms, and -- more importantly -- what was not.

### What ran, on what

| Suite | Platform | Result |
| --- | --- | --- |
| `packaging/unix/test-paths.sh` | Ubuntu 24.04 container | 15 passed |
| `packaging/ubuntu/test-installer.sh` | Ubuntu 24.04 container | 15 passed |
| `packaging/ubuntu/test-lifecycle.sh` | Ubuntu 24.04 container, real `.deb` | 19 passed |
| `packaging/ubuntu/test-deb.sh` | Ubuntu 24.04 container, real `.deb` | lintian 0 errors |
| `packaging/macos/test-tarball.sh` | Ubuntu container (packaging only) | 39 passed |
| `packaging/ubuntu/test-deb.sh` | bare Ubuntu 24.04 container | builds, installs, runs, purges |
| `shellcheck -S warning -x` | every shell file, both platforms | clean |
| `verify:install --twice --upgrade --bootstrap --instances --no-git` | Windows | exit 0 |

The Ubuntu cases install, exercise and purge a package built by the real build
script, with a Node runtime really fetched from nodejs.org and really verified.

### Git is not required

`--no-git` removes every directory holding a `git.exe` from the environment each
shortcut is given, asserts `Get-Command git` resolves to nothing, and only then
installs. The whole Windows run passed underneath that.

Grepping for `git` proves nothing here: the one caller on the release path is
`Invoke-Quiet git`, written to tolerate git being absent. The only way to find
out is to take it away.

### BLOCKED, and not claimed

- **Anything requiring a Mac.** That the Mach-O binaries run; Gatekeeper;
  quarantine; Terminal paste protection; Docker Desktop's first-run behaviour;
  Chrome's DMG flow. No Mac hardware or runner is available here. The macOS
  packages are built and their *shape* is verified on Linux -- including that
  `file` confirms each carries the architecture it claims -- but nothing has
  executed them.
- **Ubuntu with a graphical session.** Containers have no screen, so the browser
  worker's start, crash-recovery and Chrome handling on a real desktop are
  unexercised. What is proved is the path a server takes: reported NOT
  AVAILABLE, nothing started, everything else running.
- **Ubuntu 22.04 and 26.04.** Tested on 24.04 only. The other two are declared
  supported on Docker Engine's own list; that is source-inspected, not run.
- **arm64.** Both arm64 packages build, and the build refuses a runner whose
  architecture disagrees. Neither has been installed on arm64 hardware.
- **A real multi-platform release.** The release workflow itself has still not
  run -- no tag has been pushed since it was written. What has run, on every
  push, is the packaging validation workflow, which builds the same artifacts
  through the same actions and publishes nothing. See "Hosted platform
  validation" above.

Each of those is broken down item by item, so that whoever gets the hardware
knows exactly what to look at: [what still needs a
Mac](MACOS_TEST_CHECKLIST.md) and [what still needs a real Ubuntu
machine](UBUNTU_TEST_CHECKLIST.md). Record what you observe in this file,
under the release you observed it on, with the OS version and the hardware.

### The update gate that had never been run

`preflight` in `@xbam/shared` decides whether a release can run on a machine,
and every updater is meant to ask it before it stops anything, so that "no"
costs a download rather than somebody's working installation.

Two faults, found by looking for who actually called it:

**Windows never asked.** macOS and Ubuntu both did; Windows checked its own
compiled-in floors, downloaded, stopped the running AI17Z, and found out
afterwards. Worse, an installed copy updates by running its *own* setup script,
which carries the *old* floors -- so a release that raised one could stop a
working installation and then fail. The bridge lived under `packaging/unix/`,
which is why. It now sits above the platform directories and all three run it.

**Nothing had ever executed the bridge at all.** It reaches `@xbam/shared`
through the packaged tsx from inside an installed copy, and every updater
swallows a failure there and prints "could not read this release's compatibility
manifest; continuing". That sentence is correct for a release published before
manifests existed, so at runtime a missing manifest and a dead gate are
indistinguishable. It fails open and reassures you while it does.

Both packagers now run the real bridge in the real stage, with a manifest built
through the real schema, and assert **both** verdicts. The refusal is the half
that matters: a bridge that cannot start prints nothing, and an OK-only check
would pass on it. This is the same reasoning as the TypeScript transform the
Windows packager runs -- a guard that lists files cannot catch a missing binary.

Proved on this tree: the Windows stage built by `npm run package:windows`
answers `OK` for a supported machine and `NO` for an unsupported one, which is
`verify:install` staging successfully.

### Two Ubuntu suites that were not testing what they said

Found by running each one alone in a bare `ubuntu:24.04`, which is how they are
documented to run.

`test-deb.sh` stubbed one script per command -- the shape the launcher used
before the lifecycle was consolidated into one file. The package it built
carried a launcher that could not find anything, and every case after the
install ran against it. It had no pass/fail accounting, so it printed its
findings and exited with whatever ran last: `No such file or directory`, exit
127, unread. The dead half covers the launcher reaching its lifecycle script,
the env file resolving to the XDG config, the bundled runtime being the one
used, 0700 directories, XDG overrides, and a purge that keeps the owner's data.

`test-installer.sh` passed only when something else had installed `sudo` and
`curl` first. `test-lifecycle.sh` does, and running the two in one container hid
it; alone, four cases reported a refusal that was real and was not the one under
test.

Both are self-contained now, and both were mutation-tested to confirm they go
red for the right reason.

### Nothing an owner made can reach a package

The Unix packager copied whole directories with `cp`. What is inside a
developer's checkout includes their `.env` -- which holds the master key every
provider credential is sealed under -- their `storage`, and the Chrome profile
they are signed in to X with. The Windows packager had a deny-list; the Unix one
had inherited none.

Both now copy through the same filter, and both build scripts prune a second
time after the copy. Two gates for one property, on purpose: the first is a
promise that the input was clean, and a packaging script that ships somebody's
master key because its input was dirty is still a packaging script that shipped
somebody's master key.

The test plants a `.env` at the root, a second one further down, and a file
under a `storage` directory, then builds the real package and looks inside it.
It also asserts `.env.example` survives -- filtering that out was an installed
build's very first failure.

### A bug found by shellcheck, not by reading

`start-ai17z.sh` set `AI17Z_WORKER_ROLE=browser` on a line whose continuation was
broken by a comment. A backslash continuation followed by a comment ends the
command, so the assignment was standalone and never reached the worker -- every
native worker started on Unix has been claiming jobs of every kind and competing
with the containerised one. This repository already had that trap written down
for backticks. It is the same trap.

---

## AI17Z Beta 1.0.0 (17)

The first release that is not only Windows. macOS on Apple Silicon and Intel,
Ubuntu on amd64 and arm64, each built on a runner that really is that
architecture and each run there before this release existed. The two sections at
the top of this document -- hosted platform validation, and the cross-platform
work behind it -- are that evidence; this section is about the release itself.

### Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean, from a deleted `tsconfig.tsbuildinfo` |
| `npm run lint` | clean |
| `npm test` | 259 files, 3304 tests, 0 failures |
| `npm audit` | 0 vulnerabilities |
| `npm --workspace @xbam/web run build` | built |
| `npm run release:check` | 950 tracked files, nothing found, run after `git add` |
| `shellcheck` | clean at error and warning, all 35 tracked shell files |
| GitHub Actions | 11 of 11 green on the candidate commit, platform packaging included |
| `rehearsal-v1.0.0-beta.17` | the whole release workflow, publishing nothing: 5 jobs, 26m 25s, green |
| `npm run verify:install -- --twice --upgrade --bootstrap --instances --schemas --no-git` | exit 0 |

### The Windows regression, in full

The gate this repository does not tag without. Every phase passed:

    no-git:     git does not resolve in the environment every shortcut is given
    first:      installed, started, 71 migrations, API and interface answering,
                diagnostics agreeing, stopped, and nothing written beside the
                program
    second:     the same again into a new room, because a first-run bug is
                invisible on the second run and a second-run bug on the first
    sbs:        two installations side by side, each with its own everything
    bootstrap:  a package with the wrong hash refused and nothing written; then
                installed, started, and updated through the installed updater
    instances:  AI17Z-beta updated; AI17Z-alpha and AI17Z-gamma byte for byte
                what they were, 4791 files each; and a request from inside
                AI17Z-beta to update AI17Z-alpha refused, touching neither
    schemas:    install records 1, 2 and 3 each took a new release and kept
                everything of the owner's
    upgrade:    installed over the top -- same Docker project, same database,
                master key intact, and it rebuilt

And the part a log cannot be trusted for. The harness promises to take back
whatever it told Windows, so that was checked rather than believed: both golden
installations' program directories were hashed file by file before and after,
along with `HKCU\Software\AI17Z`, the three uninstall entries and the three
Start Menu groups. Identical, every line:

    AI17Z-main : 5124 files, tree 246626fb1527c1a9...
    AI17Z-test : 4781 files, tree 871447691d023958...
    HKCU\Software\AI17Z DataDir : unchanged, and still naming AI17Z-test's
                                  own data directory

The verification room was gone, and no Docker volume of its own was left
behind.

### Four defects found while preparing this release

None of them would have failed a build. Each is a thing a release says about
itself that was not true.

**1. A package named for the tag, reporting the version in the checkout.**
The release workflow hands the tag's version to the platform build scripts, so a
package is *named* after the tag -- while `package-unix.mts` wrote
`package.json`'s version into the `BUILD_INFO.json` inside it. They agree today
because the convention is to bump `package.json` with the tag. The day somebody
forgets, `AI17Z-macos-arm64-1.0.0-beta.18.tar.gz` reports 1.0.0-beta.17 to the
update check, which then offers an update that is already installed, for ever.
The tag now wins in both places, exactly as it does for Windows.

**2. The attestation that had never run.** The step sat in the Windows build
job and named `dist/` paths. That job writes to `build/windows` and has never
had a `dist`, so every glob matched nothing, the action failed, and
`continue-on-error: true` rendered that green. Beta 1.0.0 (16) was published
saying it carried GitHub build provenance. It does not, and anybody can check:

    $ curl -s -o /dev/null -w '%{http_code}\n' \
      https://api.github.com/repos/ShiftAboveCtrl/ai17z/attestations/sha256:38ceec5e...
    404

It now runs in the publish job, which is the only place every artifact exists at
once, over every file published out of `dist`. Required rather than
best-effort: a release that cannot be attested is one that does not get
published.

**3. The Windows package nobody was scanning.** `scan-artifact.sh` unpacks a
finished package and refuses it if anything of a builder's or an owner's is
inside. It knew macOS and Ubuntu. The Windows zip -- the one most people install
-- went through no version of it, because the job that builds it runs on
Windows, where the scanner's tools are not all there. The scan now happens in
the publish job, on Linux, over the bytes about to be attached, and covers all
five packages. It counts them, because a glob that matches nothing is a loop
that runs nothing and a step that passes.

**4. A manifest that described a directory rather than a release.**
`release-manifest.mts` listed the artifacts it found. A release that had lost
one of the four platform packages would therefore have published a manifest
saying that platform was unsupported -- correct about the directory, and a lie
about the release -- and the contract job that checks "every name the manifest
gives is a file that exists" would have agreed, because the name was no longer
there to check. `expectedAssets(version, platform)` now says what each platform
owes, and anything owed and absent stops the generator before a line is
composed.

Three of the four are the same shape: a check that could not fail. That is worth
saying plainly, because it is the shape that survives review.

### And a fifth, which would have failed the release itself

The publish job runs `npx tsx tools/release-manifest.mts`. That file imports
`@xbam/shared`, which resolves only through the workspace symlinks `npm ci`
writes -- and the job had neither `actions/setup-node` nor an install anywhere
in it. Proved in a container holding the tools and the packages and no
`node_modules`, rather than argued:

    Cannot find package '@xbam/shared'
    code: 'ERR_MODULE_NOT_FOUND'

That step is newer than the last release, so like the attestation it had never
once executed. Tagging would have been the first thing to find out.

Which is why this release is rehearsed before it is made. `dry_run` already
builds every platform and publishes nothing, but it is a `workflow_dispatch`
input and wants a browser or an authenticated CLI; a push can only push. A
`rehearsal-v*` tag now runs the same four platform builds and the same publish
job -- checksums, privacy scan, manifest, audit document, attestation -- and
stops before the release. Exactly one step in that workflow creates a release,
and it is off for both kinds of rehearsal. The tag is a test fixture and is
deleted afterwards; it is not release history.

### And a sixth, found by running the command rather than reading it

Every gate in this repository was green when the command on the README was
pasted into a terminal on a rate-limited address:

    AI17Z could not work out which release to install.
    Nothing on this PC was changed.
    The remote server returned an error: (403) Forbidden.

    Check your internet connection and run the command again.

The connection was fine. GitHub allows sixty API requests an hour to an address
that is not signed in, and a shared office, a university or a cloud box reaches
that on its own -- so the one person whose connection provably works is the one
being sent to check it. The refusal was right in every other respect: nothing
was changed, and the status was printed. Only the advice was wrong, and advice
is the part somebody acts on.

`install.ps1` now reads the status it already had. The two shell installers
cannot: `curl -f` collapses every 4xx into one exit code and the status cannot
leave the subshell `RELEASE_JSON="$(fetch_stdout ...)"` runs in, so their
sentence names both possibilities instead of picking one.

### What the rehearsal said

`rehearsal-v1.0.0-beta.17`, on the commit below the one this release is tagged
at. Twenty-six minutes, five jobs, every one green, and nothing published.

Every step of the publish job that had never executed ran: `npm ci`, the privacy
scan over all five packages, the manifest with nothing narrowed, the audit
document, and the attestation. The release itself was the only step skipped.

And it said so where it can be read. Actions logs need admin rights on this
repository -- the API answers 403 and so does the web interface -- so the report
leaves as a `::notice::` annotation, which is public:

    Nothing was published. A release from this commit would have attached:
      23348K AI17Z-App-1.0.0-beta.17.zip
      16588K AI17Z-Setup-1.0.0-beta.17.exe
          8K AI17Z-Setup-Audit-1.0.0-beta.17.json
      75812K AI17Z-macos-arm64-1.0.0-beta.17.tar.gz
      78956K AI17Z-macos-x64-1.0.0-beta.17.tar.gz
        140K Install-AI17Z-1.0.0-beta.17.ps1
          4K SHA256SUMS.txt
      54032K ai17z_1.0.0-beta.17_amd64.deb
      51684K ai17z_1.0.0-beta.17_arm64.deb
         20K install-ai17z-macos.sh
         24K install-ai17z-ubuntu.sh
         28K install.ps1
          8K release-manifest.json

    release-manifest.json, in summary:
      version 1.0.0-beta.17  tag v1.0.0-beta.17  schema 1
      windows: supported=true arch=x64
      macos:   supported=true arch=x64,arm64
      ubuntu:  supported=true arch=x64,arm64
      artifacts: 11

Thirteen files, plus this document, which is published from the checkout rather
than built and so is not in that directory. `supported=true` on all three is the
thing the manifest guard was added for: a missing package would have made one of
them false rather than failing.

**The release is tagged one commit later than the rehearsal.** What changed in
between is the wording of a refusal in the three installers, and the test that
pins it -- no workflow, no packaging, no asset name. The publish job the
rehearsal proved is the publish job the release ran, step for step; the changed
installers are exercised by the packaging validation workflow, on real Macs and
real Ubuntu machines, on the tagged commit. Saying which commit was rehearsed is
better than implying it was this one.

### The asset contract

Fourteen files, and not one of their names is typed anywhere but
`releaseManifest.ts` in `@xbam/shared`:

    AI17Z-Setup-1.0.0-beta.17.exe          the older full installer, unsigned
    Install-AI17Z-1.0.0-beta.17.ps1        the setup program, as a script
    AI17Z-App-1.0.0-beta.17.zip            the application it installs
    install.ps1                            the command on the README
    AI17Z-macos-arm64-1.0.0-beta.17.tar.gz
    AI17Z-macos-x64-1.0.0-beta.17.tar.gz
    ai17z_1.0.0-beta.17_amd64.deb
    ai17z_1.0.0-beta.17_arm64.deb
    install-ai17z-macos.sh                 read it, then run it
    install-ai17z-ubuntu.sh
    SHA256SUMS.txt                         what every installer checks against
    release-manifest.json                  what an updater reads
    AI17Z-Setup-Audit-1.0.0-beta.17.json   what the setup program may do
    RELEASE_VALIDATION_REPORT.md           this file

The release name renders as **AI17Z Beta 1.0.0 (17)**, from `releaseName()`, and
the installer derives the same string a second time in ISPP for Add/Remove
Programs. The two are checked against each other, because the failure is silent
and the uninstall list disagreeing with the version screen looks like two builds
installed at once.

### What happens after publication

Everything above was true before the tag existed, which is the most a document
attached to a release can ever be. What the published thing actually does is a
separate question, and until this release nothing asked it.

`.github/workflows/release-qualification.yml` now does, by itself, on
`release: published`. It takes nothing from the build:

- **the published bytes**, on Linux: every asset downloaded, every hash checked
  against the release's own `SHA256SUMS.txt`, `release-manifest.json` read back
  and compared against the files that actually arrived, and the attestations API
  asked whether each one carries provenance -- which is the check that would
  have caught Beta 1.0.0 (16) claiming provenance it did not have
- **real Macs**, `macos-15` and `macos-15-intel`: the *published*
  `install-ai17z-macos.sh`, hash-checked against the release and compared byte
  for byte with the one this commit holds, then run against the release over the
  network. What it installs is then asked what version and architecture it is,
  from its own bytes
- **real Ubuntu**, amd64 and arm64: the same, through apt, followed by the full
  package proof against what the release put on the machine
- **Windows**, looking only: `install.ps1` off the release, hash-checked, and
  run with `-WhatIfOnly`. The rest of the Windows route turns on a Windows
  feature and installs Docker Desktop, which a runner is the wrong place to
  learn about -- `npm run verify:install` is, and it runs on a real machine
  before anything is tagged

It holds `contents: read` and nothing else, so it cannot change the release it
is checking. A `qualify-v*` tag runs it again against a release that already
exists.

What that run found is added to this file in the repository afterwards, and
reaches a release asset with the version after this one.

### Not verified

Machine-run proof cannot represent a person at a computer. These are gaps, not
oversights:

- **Docker Desktop's own installation on macOS.** A hosted Mac has no Docker and
  cannot be given one without a person: a disk image, a graphical setup, and
  Docker's own licence, which AI17Z must never accept for somebody.
- **Gatekeeper and quarantine as a person meets them** -- a downloaded file's
  quarantine attribute, the dialog, Terminal's paste protection.
- **A real X sign-in**, on any platform, and the browser worker against an
  actual screen.
- **Ubuntu Desktop's session integration** and the desktop launcher.
- **A physical reboot**, on any platform.

`docs/MACOS_TEST_CHECKLIST.md` and `docs/UBUNTU_TEST_CHECKLIST.md` each end in
the list of those, as steps against this release, with what should happen at
each one.

---

## AI17Z Beta 1.0.0 (16)

The first release the terminal install command can actually install. Beta
1.0.0 (15) and everything before it predate the assets it looks for, so the
command refused them -- correctly, and with a PowerShell stack trace printed
underneath the refusal, which is the other half of what this release fixes.

### What a real person saw, and why

Pasting the command against Beta 1.0.0 (15) produced the right decision and the
wrong presentation:

    Release v1.0.0-beta.15 does not contain Install-AI17Z-1.0.0-beta.15.ps1.
    Nothing on this PC was changed.

    At line:152 char:3
    + throw $What
        + CategoryInfo          : OperationStopped: (...)
        + FullyQualifiedErrorId : ...

The refusal was correct: that release carries no setup script, and a command
that installs whatever it finds would be worse than one that stops. The stack
trace was not. `Stop-Install` threw to unwind -- `exit` would close the terminal
the command was pasted into -- and nothing caught it, so PowerShell rendered a
crash for something the program decided on purpose.

`Stop-Install` now throws a sentinel that an outermost boundary recognises by
`$_.TargetObject`, which a real fault leaves empty. Refusals print their own
explanation and nothing else. Genuine faults print one sentence and write the
detail to `%LOCALAPPDATA%\AI17Z-setup\install-command.log`. Both set
`$global:LASTEXITCODE`, so automation still sees a failure, and neither ends the
session.

The advice was wrong as well. "Install an earlier release" was impossible
during this migration -- no earlier release carries the asset either. The list
is now read and an earlier release is only ever named when its own assets prove
it would work.

### Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean, from a deleted `tsconfig.tsbuildinfo` |
| `npm run lint` | clean |
| `npm test` | 251 files, 3165 tests, 0 failures |
| `npm audit` | 0 vulnerabilities |
| `npm --workspace @xbam/web run build` | built |
| `npm run release:check` | 893 tracked files, nothing found, run after `git add` |

### Installing without Git

The recommended install is a release package that is downloaded and
hash-checked, never a clone, and this is the release that proves it rather than
asserting it. `npm run verify:install -- --no-git` removes every directory
holding a `git.exe` from the environment each shortcut is given, asserts
`Get-Command git` resolves to nothing, and only then installs.

    no-git: git does not resolve in the environment every shortcut is given

The whole run passed underneath that: two clean installs, two installations side
by side, the bootstrap install and update, the three-instance regression, and
the upgrade-over-the-top. Exit 0.

The one place `git` is still invoked on an installed copy is `Get-SourceStamp`
in `start-ai17z.ps1`, through `Invoke-Quiet`, which is written to return
`$null` when a command does not exist and falls back to the packager's stamp.
That is why grepping for `git` proves nothing here and taking it away proves
everything.

Git remains what a *source checkout* updates with. That is a different thing,
for people working on AI17Z.

### The release asset contract

Three files have to agree on names that nothing connects except somebody typing
the same string into all of them: the workflow decides what a release contains,
`install.ps1` decides what it goes looking for, and `Setup-AI17Z.ps1` decides
what it downloads next. A mismatch is invisible until a stranger pastes the
command.

`tests/unit/releaseAssetContract.test.ts` holds them to each other in both
directions -- every asset the install path verifies is hashed, and every asset
hashed is attached.

The artifacts were then built locally with the exact packaging the workflow
runs, and the chain driven against them:

    ok  every asset the install chain needs is present
    ok  SHA256SUMS.txt parses, and names both files the chain verifies
    ok  the setup script matches its published SHA-256
    ok  the published setup script is the file in the repository, byte for byte
    ok  installed 1.0.0-beta.16 from the release package, hash-checked

The setup script was executed the way `install.ps1` executes it -- read as bytes
and run as a scriptblock, never launched as a file -- because that is the
difference Windows' default execution policy cares about.

`sha256sum` writes `<hash> *<name>` on Windows and `<hash>  <name>` on the Linux
runner that produces the real file. Both parse.

### Multi-instance, unchanged and re-proved

    instances: AI17Z-alpha, AI17Z-beta, AI17Z-gamma installed, each with its
               own program, data and .env
    instances: updating AI17Z-beta through its own update-ai17z.ps1
    instances: AI17Z-alpha is byte for byte what it was (4779 files)
    instances: AI17Z-gamma is byte for byte what it was (4779 files)
    instances: asked to update AI17Z-alpha from inside AI17Z-beta, it refused
               and touched neither

### Not verified

- **A clean Windows machine.** Everything above ran on a developer machine that
  already had WSL, Docker Desktop, Node and Chrome, so every dependency step
  reported "already present" rather than installing anything. The install of a
  missing dependency, the restart-and-resume path, and Docker's own first-run
  terms are unexercised here and always have been.
- **The published command against the published release.** By definition this
  could not run before the release existed. What ran is the same chain against
  locally built artifacts with the same names and hashes.
- **The legacy `.exe`.** Inno Setup is not installed locally, so
  `AI17Z-Setup-<version>.exe` was not compiled or run here. The workflow builds
  and checks it, and it is not the recommended route.

---

## AI17Z Beta 1.0.0 (15)

One fix, and the reason it is a separate release: Beta 1.0.0 (14) published a
`/INSTANCE=` flag that does not work, and said in its notes that it does.

### What the gates said, and what they missed

Every gate below passed for Beta 1.0.0 (14) as well. The defect was found after
publishing, by running the published installer against a name that did not
exist -- which is the check that had never been run, because until (14) there
was no flag to run it against.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean, from a deleted `tsconfig.tsbuildinfo` |
| `npm run lint` | clean |
| `npm test` | 246 files, 3013 tests, 0 failures |
| `npm audit` | 0 vulnerabilities, with and without dev dependencies |
| `npm --workspace @xbam/web run build` | built |
| `npm run release:check` | 881 tracked files, nothing found |
| `npm run verify:install -- --twice --upgrade` | passed, including side by side and upgrade over the top |
| `/VERYSILENT /INSTANCE=` aims at the named instance | PENDING |

### The installer defect, and how it was proved

`/VERYSILENT /INSTANCE=AI17Z-probe`, on a machine holding AI17Z-test and
AI17Z-main:

    uninstall key    {8F3B...}_AI17Z-probe_is1
    display name     AI17Z-probe Beta 1.0.0 (14)
    Start Menu       AI17Z-probe
    desktop icon     AI17Z-probe
    files            ...\Programs\AI17Z-test          <-- not AI17Z-probe

Everything built from `InstanceName` was right; only `{app}` was wrong. That is
worse than the defect `/INSTANCE=` was added to fix: an installation named one
thing, living inside another, whose uninstaller is registered to delete a
program directory belonging to something else.

The cause is that **Inno runs `InitializeWizard` and calls `NextButtonClick`
for every page under `/VERYSILENT` as well** -- there is no window, and
everything else happens. The found-installations page ran, its first radio was
checked because it is the first, and `NextButtonClick` did what it exists to do
on that page: assign `WizardForm.DirEdit.Text`. `DefaultDirName` had already
resolved correctly and was overwritten afterwards.

Proved with a twenty-line Inno script of the same shape, traced under
`/VERYSILENT`. Before the guard:

    1  InitializeWizard ran, radio checked -> "yes"
    2  NextButtonClick on FoundPage, ChosenInstall -> "0"
    3  DirEdit forced to -> "...\Programs\HIJACKED"
    4  FINAL {app} -> "...\Programs\HIJACKED"

After, with the same command line:

    1  InitializeWizard ran, radio checked -> "yes"
    2  FINAL {app} -> "...\Programs\ZZWanted2"

and with no `/INSTANCE=` the radio still wins, because a wizard following its
own radio is the behaviour that clause exists for and had to survive.

Beta 1.0.0 (14) is unaffected for anyone not passing `/INSTANCE=`: without it
the name and the directory derive from the same choice and agree.

### What this says about the gates

The clean-room harness installs by reproducing what the installer does to a
disk rather than by running the installer, so no amount of `--twice --upgrade`
would have found this. The gap is now named: a flag that changes where files go
is checked by running the real installer against a name that does not exist,
before it is pointed at anything that matters.

---

## AI17Z Beta 1.0.0 (14)

Fifty-six new capabilities, grouped so an owner makes one decision instead of
sixty-eight. Which means the question this release has to answer is not "do the
new capabilities work" but "is an owner who wants none of them unaffected".

### Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean, from a deleted `tsconfig.tsbuildinfo` |
| `npm run lint` | clean |
| `npm test` | 246 files, 3010 tests, 0 failures |
| `npm audit` | 0 vulnerabilities, with and without dev dependencies |
| `npm --workspace @xbam/web run build` | built |
| `npm run release:check` | 879 tracked files, nothing found |
| `npm run verify:install -- --twice --upgrade` | passed |
| Migrations, new database | 71 applied, 0 pending, 0 drifted |
| Migrations, existing database | 71 applied, 0 pending, 0 drifted |

Two of those rows carry a condition, and both are there because the condition
has been got wrong before. The typecheck is from a deleted build info because
`tsc -b` reuses its cache, and a local green over a stale one has hidden errors
CI then found. `release:check` was run after `git add`, because it walks
tracked files and would otherwise skip exactly the new ones worth checking.

The suite was re-run from the final source after the last edit. The first run
was green too and is not the one being reported: it started before three source
files changed, which makes it evidence about something that is no longer what
is being shipped.

### Installing, from nothing, twice, and over the top

`npm run verify:install -- --twice --upgrade`. A new program directory, data
directory, Docker project and volumes each time, an environment scrubbed of
every `AI17Z_*` and `XBAM_*` variable, and every entry point driven rather than
one script run once.

    first:    71 migrations applied; API and interface answering; signed in and
              the agent list drew itself; diagnostics agree; stop stopped it;
              wrote nothing beside the program
    second:   the same, from nothing again
    sbs:      two installations running side by side, each with its own
              program, data, Docker project and volumes
    upgrade:  a row written, installed again over the top, and the row read
              back -- same project, same database, master key intact

"Signed in and the agent list drew itself" is a real headless browser, because
`GET /` returning 200 is nginx handing over an `index.html` with an empty div
in it, and Beta 1.0.0 shipped a black screen past a check that could not tell
the difference.

### The release invariant: an agent with every pack switched off

`tests/integration/packsOff.test.ts`. An owner who never wanted any of this
must be unaffected by all of it. The two halves of that are asserted
separately, and neither is inferred from the other: what the agent still does,
and what leaves the machine.

- With every pack off, a real event goes the whole way to `EXECUTED` — memory
  selected, model called, output validated, action completed, and both sides of
  the exchange remembered.
- The capability loop is asserted to be **on** for that agent first. Without
  that check the case could pass by never running the loop at all, which is the
  one way it could be green and prove nothing.
- No capability invocation is recorded, and nothing reaches the network.
- A model that names a switched-off capability anyway is refused at the
  invocation, and the refusal is recorded rather than swallowed. Leaving
  something off the menu saves a wasted step; it is not the guard.
- One pack switched on is offered, chosen, invoked and answered. Switched off
  again, the agent goes on working.

Nothing on the wire is proved by replacing `net.connect` and `tls.connect` for
the duration of each case, recording and refusing every connection that is not
the database. Deliberately at the socket rather than at `ask()` or
`safeFetch`: those are seams a future call site could go around without anybody
noticing, and the claim is not "no upstream family ran".

A guard that never fires and a system that never calls out look identical from
outside, so one case proves the guard catches a real `safeFetch` — to an
address literal, so it needs no resolver and still reaches the wire from
nowhere.

Mutation-checked. Each of these was applied to the source and the suite failed:

| Mutation | Cases that caught it |
| --- | --- |
| The model menu stops filtering on permission | 2 |
| `DISABLED` no longer refuses at the invocation | 1 |
| A pack switch reaches only its first capability | 2 |

### Toolspace, in the running interface

Driven in the application, not asserted from a fixture.

- Desktop and 375px wide. At 375, `scrollWidth === clientWidth === 375`: no
  horizontal overflow.
- No console errors. (Two 401s in the buffer predate the session and do not
  recur; every request after a reload is 200.)
- A pack switched off writes `DISABLED` for each of its members and survives a
  reload.
- One capability overridden individually shows the pack as `SOME`, counts
  `2 of 3 ready`, and warns that the group switch would replace that choice.
- A capability switched off is absent from what the model is offered — read
  through the production settings loader and the real loop rather than a
  hand-rolled map, which is the mistake that would have made a working switch
  look broken.
- No vendor plumbing in the primary interface: no RPC URLs, no WARC or CDX
  terms, no ABI fragments, no Crossref pools, no Wikidata property ids.

### Portability

Real files written to disk, read back off it, and imported as new agents.

| | SHARE | MOVE |
| --- | --- | --- |
| Checksum | matches | matches |
| Toolspace decisions carried | 4 of 4, identical | 4 of 4, identical |
| One of them switched off | carried | carried |
| Memories | 0 | 1 |
| Imported as a new agent | yes | yes |

The switched-off capability and the memory were written before the export on
purpose. A round trip carrying nothing distinguishing proves nothing.

### Two defects this validation found

**Company Filings could never be switched on.** `useSecContact` was written,
documented, and called by nothing, so the family reported itself unavailable on
every installation while telling owners to configure a contact that had no
configuration point. It now reads `AI17Z_SEC_CONTACT` at bootstrap, is
forwarded to both compose services, is in the environment template, and is
named in the message an owner reads. Unset stays unset and sends nothing.

Proved: unset reports unavailable, a configured address reports available, and
an address with no `@` is treated as unset. **No request was sent to the SEC.**
Declaring a placeholder address to a regulator is the thing this family exists
to refuse.

**The Web & Feeds pack described a screen that does not exist.** Its summary
offered to "follow sites that publish a feed". The watcher underneath is
complete — cursors, backoff, a poll loop in the worker — and nothing can create
a subscription for it: no route, no interface, no capability. The summary now
says what the pack does, which is read a feed on demand.

### Not verified

- **The SEC success path.** The refusal is proven against the live service: an
  honest User-Agent naming the project and its public repository was answered
  403, "Your Request Originates from an Undeclared Automated Tool". Parsing a
  real filing needs a contact address, and this release refuses to invent one,
  so the parser is source-reviewed and written defensively rather than
  observed. An owner who configures a contact exercises it on their first call.
- **Following a feed.** The subscription table, cursor and poll loop are tested
  and reachable from code; nothing an owner can press creates a subscription.
  Reading a feed on demand is what ships.
- **Wayback CDX and GDELT** were evaluated and not adopted. The measurements
  behind both decisions are in `docs/architecture/TOOLSPACE.md`.
