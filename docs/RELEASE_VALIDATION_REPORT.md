# Release validation

What was checked before a release was published, how, and what it found. Every
claim here is something somebody ran; anything taken on trust says so, and the
last section is the list of things this release did not verify.

The release workflow attaches this file to the release.

---

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
- **A real multi-platform release.** The workflow builds five jobs and has not
  yet run: no tag has been pushed since it was written.

Each of those is broken down item by item, so that whoever gets the hardware
knows exactly what to look at: [what still needs a
Mac](MACOS_TEST_CHECKLIST.md) and [what still needs a real Ubuntu
machine](UBUNTU_TEST_CHECKLIST.md). Record what you observe in this file,
under the release you observed it on, with the OS version and the hardware.

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
