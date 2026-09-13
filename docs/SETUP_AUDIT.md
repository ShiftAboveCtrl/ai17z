# Auditing AI17Z Setup

AI17Z Setup can turn on Windows features and install system software. That is a
lot of trust to ask for one pasted command, so this page is what it does, in
full, and how to check that for yourself rather than taking our word for it.

**Install AI17Z only from the official repository:
<https://github.com/ShiftAboveCtrl/ai17z>.** Nowhere else distributes it. A copy
from anywhere else is not AI17Z, whatever it is called.

---

## The short version

| | |
| --- | --- |
| What you paste | `irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 \| iex` |
| What that fetches | [`install.ps1`](../install.ps1) — around 200 lines of code under a long comment explaining itself, in this repository, and the entire file at that URL |
| What it does | asks GitHub for the newest release, downloads that release's setup script, **checks its SHA-256 against the release's own `SHA256SUMS.txt`**, writes it where you can read it, and runs the bytes it checked |
| What the setup program is | [`packaging/windows/Setup-AI17Z.ps1`](../packaging/windows/Setup-AI17Z.ps1) — the whole installer, as a script, published with every release as `Install-AI17Z-<version>.ps1` |
| What is not involved | no executable, no download to double-click, and no change to SmartScreen, Defender, UAC or your execution policy |
| What it installs | WSL 2, Docker Desktop, Node.js and Google Chrome — only the ones you do not already have |
| Where those come from | `wsl --install`, and **winget**, Microsoft's own package manager. Never a URL of ours |
| What it downloads itself | one file, `AI17Z-App-<version>.zip`, from this repository's release, checked against a SHA-256 |
| When it asks for administrator rights | once, for WSL 2 and Docker Desktop, with an explanation on screen first |
| What it leaves running | nothing. No service, no scheduled task, no startup entry |
| What it sends anywhere | nothing about you, this machine, or your agents |

---

## Why each dependency

AI17Z is not a program that runs on its own; it is a small system. Four things
have to be on the machine, and none of them can be shipped inside an installer.

**Docker Desktop** runs the PostgreSQL database that holds everything: your
agents, their memories, their relationships, the credentials they use. It is the
one dependency AI17Z genuinely cannot do without.

**WSL 2** is what Docker Desktop runs on. AI17Z does not use it directly and does
not install a Linux distribution: `wsl --install --no-distribution` turns on the
platform and nothing more. Docker Desktop brings the only distribution involved.
If you already use Ubuntu or anything else under WSL, it is untouched.

**Node.js 22 or newer** runs the part of AI17Z that drives your browser. That
part cannot live in a container, because a container has no browser and no
screen.

**Google Chrome** is the browser AI17Z acts through. It is the only one: AI17Z
attaches to real Chrome over a loopback debug port, and Chromium and Edge are
refused rather than quietly substituted. Setup will install AI17Z without it and
tell you what you cannot do until it is there.

Nothing else is required. **Git is not required** — the application is downloaded
as one file rather than cloned. Nothing is installed "for development".

---

## What it does, step by step

Every one of these is detect, decide, act, verify. Something already good enough
is left exactly as it is: run Setup twice and the second run installs no
prerequisite it installed the first time, and touches nothing in your data
folder. It does lay the application down again — that is what an update is, and
it is the same operation either way.

1. **Looks at this PC.** Windows build, 64-bit, whether virtualisation is
   available. Refuses below Windows 10 22H2, which is Docker Desktop's own
   requirement, rather than half-configuring a machine that cannot run it.
2. **WSL 2.** If it is present and new enough — 2.1.5, Docker Desktop's stated
   minimum — nothing happens. Otherwise `wsl --install --no-distribution` or
   `wsl --update`, elevated, once. If Windows says it needs a restart, Setup says
   so, saves where it got to, and puts **Continue AI17Z Setup** in your Start
   Menu.
3. **Docker Desktop.** Installed through winget if absent. Then Setup waits for
   the *engine* to answer, which is not the same thing as the program being
   installed: this is the step that existed as "install Docker, restart your PC,
   and run the installer again" before. If Docker Desktop is waiting for you to
   accept its own terms, Setup says that in plain English and stops, because
   accepting a vendor's agreement on your behalf is not something it will do.
4. **Google Chrome**, through winget, if real Chrome is not already there.
5. **Node.js**, through winget, if there is no Node 22 or newer.
6. **AI17Z.** One download, one hash check, extracted into the program folder.
7. **Starts it** and **checks it works** — that the API is healthy, that the
   database is behind it, and that the page being served is the application and
   not an empty shell.

---

## Administrator rights

Setup starts as an ordinary user and stays one. Two things need more than that,
and both are Microsoft's own commands:

- `wsl --install --no-distribution` / `wsl --update` — turning on a Windows
  feature
- `winget install --id Docker.DockerDesktop` — Docker Desktop installs for
  everyone on the PC

For each, Setup prints what it is about to do and why **before** the Windows
prompt appears, then starts one elevated child process that does that one job and
exits. Nothing else runs elevated, and nothing stays elevated. Chrome and Node.js
install per user and are not elevated at all.

If you say no at the prompt, Setup stops and tells you what was not done. Nothing
is half-applied.

---

## What it downloads, and from where

| Host | What for |
| --- | --- |
| `api.github.com` | asking which release to install |
| `github.com` | the release assets |
| `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | where GitHub redirects asset downloads |

That is the complete list, and the script refuses to start a request anywhere
else. It is not a guideline in a comment: `Assert-Ai17zAllowedUrl` checks every
address against it, requires HTTPS, and stops if it does not match.

Everything else — Docker Desktop, Node.js, Chrome, WSL — is fetched by **winget**
or by **Windows itself**, from Microsoft's and the vendors' own infrastructure.
AI17Z never downloads an executable from a link of its own, and if winget is not
available on the machine it says so and points you at the vendor's own download
page rather than fetching a binary instead.

---

## What it writes

| Path | What |
| --- | --- |
| `%LOCALAPPDATA%\Programs\AI17Z\` | the application. Replaced on every update |
| `%LOCALAPPDATA%\AI17Z\` | **your data.** Created if missing, never replaced |
| `%LOCALAPPDATA%\AI17Z\.env` | ports, the instance name, and the master key. Written once. Never overwritten |
| `%LOCALAPPDATA%\AI17Z\storage`, `browser-profiles` | files your agents own, and your signed-in browser session |
| `%LOCALAPPDATA%\AI17Z-setup\` | the setup log, `Setup-AI17Z.checked.ps1` — the copy whose hash was checked — and the resume note while a restart is pending |
| Start Menu → `AI17Z` | five shortcuts: start, diagnostics, stop, update, uninstall |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\...` | the Add/Remove Programs entry |
| `HKCU\Software\AI17Z\Installs` | so the next run finds this installation rather than making a second one |

Per user, under your own profile. Nothing is written to `Program Files`, nothing
machine-wide, no system files, no drivers.

**A second installation** made with `-NewInstance` or `-Instance <name>` derives
every one of those paths from that name and shares nothing with the first.

---

## More than one installation on a machine

This is an audit question as much as a feature one, because the failure it
guards against is an installer writing over an installation somebody did not ask
it to touch.

A machine can hold several AI17Z installations. Each one is a name, and that name
settles everything derived from it: the program folder, the data folder, the
Start Menu group, the Add/Remove Programs entry, the Docker project and the
ports. They share nothing.

- `-List` prints what is installed and does nothing else.
- `-NewInstance` installs another, under a name nothing is using.
- `-Instance <name>` acts on that one.
- With no arguments and one installation present, Setup **asks** rather than
  assuming, and with several it **stops** and tells you how to name one. It
  never picks for you.

Two rules hold this together, and both are tested:

**Where a run is going is decided by where it is, never by a file that claims
something.** `INSTALL_INFO.json` records *how* a copy was installed; if the
directory it names is not the directory it was found in, that record is treated
as untrustworthy and the run stops rather than acting on it. That is the Beta
1.0.0 (14) defect written down as a rule — an installation named one thing, with
its files written into another, and an uninstaller registered to delete a
directory belonging to something else.

**An update updates the installation it was started from.** *Update AI17Z* in the
Start Menu and the update screen in the application both act on their own copy,
and refuse a request naming a different one. There is no path that finds another
installation and updates it.

---

## What it leaves behind

Nothing that runs on its own.

There is **no service**, **no scheduled task**, and **no Run key**. The one thing
Setup ever creates that outlives it is a Start Menu shortcut called *Continue
AI17Z Setup*, created only when Windows has asked for a restart, and deleted the
moment setup finishes. A program that adds itself to a machine's startup is
indistinguishable from something that should not be there, and one restart does
not justify looking like it.

You can delete `%LOCALAPPDATA%\AI17Z-setup\` at any time. It holds a log and a
copy of the script.

---

## What it never does

These are the exact lines the program declares about itself — run it with
`-Manifest` and you get them back — and a test in this repository fails if this
list and that one ever differ. AI17Z Setup will never:

- download an executable from a URL of its own
- disable or exclude anything from Defender, SmartScreen or any antivirus
- accept a vendor agreement on your behalf
- send anything about you, this machine or your agents anywhere
- overwrite an existing .env, master key, database, browser profile or Docker volume
- uninstall Docker, Node, Chrome or WSL, even when AI17Z is removed

Two of those are worth a sentence each. It will never **tell you** to weaken a
security setting either; if a download does not verify, the answer is to stop,
not to click past something. And it may well have installed Docker, Node or
Chrome for you — which is not the same as owning them, because something else on
this machine may be using any of them.

### Execution policy, precisely

`Set-ExecutionPolicy` appears nowhere in AI17Z, nothing asks you to run it, and
**your machine's policy is never changed**. The install command does not need
it changed: Windows' default `Restricted` permits individual commands, and both
the command and the setup program it runs are individual commands rather than
script files being launched.

What is true and worth saying rather than glossing: the Start Menu shortcuts
AI17Z creates for **its own installed scripts** — start, stop, diagnostics,
update, uninstall — start their process with `-ExecutionPolicy Bypass`. That is
a setting on one process, it applies only to files AI17Z put there itself, and
it changes nothing about this machine or anything else that runs on it. The
older full installer does the same for the same scripts.

---

## Checking it yourself

### 1. Read the script

It is the whole program. Start here:

- [`packaging/windows/Setup-AI17Z.ps1`](../packaging/windows/Setup-AI17Z.ps1)

The `$script:Ai17zSetup` block at the top is the complete list of what it may
reach, install and write. Nothing below it adds a host or a package that is not
declared there.

### 2. Read the command's own script first

`irm ... | iex` fetches [`install.ps1`](../install.ps1) and runs it. You do not
have to take that on trust: the same URL in a browser shows you the file, and
this reads it without running any of it.

```powershell
irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | Out-File $env:TEMP\install.ps1
notepad $env:TEMP\install.ps1
```

It is short on purpose. Everything long enough to need auditing is the setup
program, which this fetches and checks before running.

### 3. Check what it fetched

`install.ps1` does this itself and stops if it fails. The file it checked is
written to `%LOCALAPPDATA%\AI17Z-setup\Setup-AI17Z.checked.ps1`, and is kept
there whenever anything goes wrong — or always, if you ask:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1))) -KeepDownload
Get-FileHash $env:LOCALAPPDATA\AI17Z-setup\Setup-AI17Z.checked.ps1 -Algorithm SHA256
```

On a clean run it is removed afterwards, because it is a copy of a published
file and nothing needs it once the install has finished.

Compare it to the `Install-AI17Z-<version>.ps1` line in `SHA256SUMS.txt` on the
release page. **If it does not match, stop. Do not run it.** Open an issue
rather than running it.

### 4. Check the release matches this repository

The setup program published with a release is the file in this repository at
that release's tag. Nothing is compiled, so the two can be compared byte for
byte:

```powershell
git -C <your clone> show v<version>:packaging/windows/Setup-AI17Z.ps1 > from-repo.ps1
Get-FileHash .\from-repo.ps1 -Algorithm SHA256
```

That hash is the one on the `Install-AI17Z-<version>.ps1` line of
`SHA256SUMS.txt`, and the one the command checked before it ran anything.

### 5. Make it tell you what it would do

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1))) -WhatIfOnly
```

It looks at the machine, prints what it would install, and changes nothing.

And to print the setup program's own declared permissions as JSON, from a copy
on disk — the one `-KeepDownload` left, or the `Install-AI17Z-<version>.ps1`
asset downloaded from the release page:

```powershell
& ([scriptblock]::Create((Get-Content -Raw $env:LOCALAPPDATA\AI17Z-setup\Setup-AI17Z.checked.ps1))) -Manifest
```

Read as a command rather than launched as a file, which is what lets it run
under Windows' default execution policy without that policy being changed.

That output is where this page's tables come from, and a test in this repository
fails if the two ever disagree.

Every release also publishes **`AI17Z-Setup-Audit-<version>.json`**, which is
that same declaration plus what this particular release is: the tag, the commit,
the workflow run that built it, whether it was signed — it is not — and the
SHA-256 of every file published beside it. It is generated in the publish job
from the files that are actually published, so its hashes are the ones you will
get.

### 6. Have something else read it

A second pair of eyes on an installer is a good habit, and a model is a
reasonable second pair of eyes for this particular job — it will read 1,200 lines
of PowerShell without skimming. Give it the script and this repository and ask:

> Audit this installer/bootstrap. Explain every privileged action, network
> download, persistence mechanism, and file modification. Verify that it matches
> the public AI17Z repository.

**This is a second opinion, not the root of trust.** A model can be wrong, can be
shown a different file than the one you are about to run, and cannot check a
signature. What actually protects you is the list above it: the official
repository, the published source, the published hash checked before anything
runs, and the fact that everything Setup installs comes from Microsoft's package
manager rather than from us.

---

## Installing the dependencies yourself

Nothing here is magic and none of it has to be done by us. If you would rather
install the prerequisites by hand, do that first and Setup will find them and
skip every one:

- WSL 2 — [Microsoft's instructions](https://learn.microsoft.com/windows/wsl/install)
- Docker Desktop — <https://www.docker.com/products/docker-desktop/>
- Node.js (22 or newer) — <https://nodejs.org/en/download>
- Google Chrome — <https://www.google.com/chrome/>

Then run Setup and watch it tick all four off without touching anything.

`-SkipDependencies` goes further: it checks them, reports what it found, and
installs nothing whatever the answer.

---

## What the hashes actually protect against

Worth being precise, because "verified" is a word that gets used loosely. There
are two hash checks, and they cover different things.

**The setup program.** `install.ps1` reads the release's `SHA256SUMS.txt`, hashes
the setup script it downloaded **in memory, before writing anything**, and stops
on a mismatch having written nothing and run nothing. The file it then writes is
re-hashed by the process that runs it, so replacing that file in the moment
between the check and the run does not get it executed.

**The application.** The setup program downloads one file,
`AI17Z-App-<version>.zip`, and checks it the same way against the same
`SHA256SUMS.txt`. A mismatch deletes the file. There is **no flag to skip either
check**, in either script.

Both catch a truncated download, a corrupted one, and a mismatched asset.
Neither is a defence against a compromised release: a checksum published by the
release it describes is
**not** a defence against a release that has itself been tampered with,
because the checksum file and the payload would have been replaced together.
What stands against that is that releases are built by a public GitHub workflow
from a public tag, never uploaded from anybody's laptop, and that every published
file is a file you can read.

### What the first URL costs, said plainly

The command fetches `install.ps1` from `main`, which is a **moving** reference:
what it returns is whatever that branch holds at the moment you paste it, and
nothing in the command pins it. That is the one unpinned step, and it is where
the chain starts rather than something the chain covers.

What follows it is pinned: a specific release, read from GitHub's API; a specific
asset; a hash from that release compared before a byte is written; and the same
hash checked again by the process that runs it. So the honest statement is that
you are trusting **GitHub's copy of this repository at the moment you run it** —
the same thing you trust when you `git clone` it — and after that you are
trusting a hash.

If that is not a trade you want to make, do not paste the command. Clone the
repository at a tag you have looked at, and run
`packaging/windows/Setup-AI17Z.ps1` out of your clone.

---

## What this defends against, and what it does not

Written out rather than implied, because "verified" and "secure" are words that
cover a lot of ground and the interesting part is always the edge of it.

| | |
| --- | --- |
| **A corrupted or truncated download** | caught. The SHA-256 is checked before anything is written, and a mismatch deletes the file |
| **The wrong file served for the right name** | caught, the same way |
| **Somebody intercepting the network** | HTTPS with certificate validation, which is never disabled, and a host allow-list applied before any request. The hash is checked on top of that |
| **A link in this script rotting or being replaced** | there are no links to installers in this script. Everything installable comes from winget or from Windows |
| **A hostile archive** | every entry is judged before any is written: no `..`, no absolute path, no drive letter, no control character, and the resolved path is checked against the destination a second time |
| **A flag being used to run something else** | `install.ps1` hands the child process a fixed command string and passes every value through the environment. An instance name is reduced to `[A-Za-z0-9._-]` first, and nothing from the network reaches a command line, a filename or a path |
| **A release tag becoming a path** | the tag is the one value that arrives in a remote document and turns into a filename. Both scripts check it is a version number — no separator, no colon, no drive letter — before anything is derived from it, and **refuse** rather than repair one they do not recognise |
| **A tampered resume note** | it is read for which instance was being set up and nothing else. Every step re-probes the machine, and a note from another instance, another schema or another day is discarded |
| **Secrets in the log** | anything key-shaped is blanked as it is written, not as it is read |
| **A compromised GitHub release** | **not defended against by the hash.** The checksum file and the package would have been replaced together. The defence is that releases are built by a public workflow from a public tag, never uploaded from anybody's machine |
| **A compromised `main` branch** | **not defended against**, and it is the first thing the command fetches. See [What the first URL costs](#what-the-first-url-costs-said-plainly) above. Clone at a tag instead if that matters to you |
| **A compromised winget package** | not ours to defend. It is the same trust you place in winget every other time you use it, which is the argument for using it rather than fetching binaries ourselves |
| **Windows warning you about an unsigned program** | there is no unsigned program to warn about. Nothing here is downloaded to be double-clicked, so SmartScreen's reputation check never applies, and no security setting is changed to achieve that. See [Windows trust and SmartScreen](WINDOWS_TRUST.md) |

## Removing it

**Add/Remove Programs**, or *Uninstall AI17Z* in the Start Menu.

The program always goes. **Your data is kept unless you say otherwise**, and the
default answer to that question is no — it holds your agents, their memories, and
the key your provider credentials are sealed with, and reinstalling after keeping
it picks up exactly where you left off.

Docker, Node.js, Chrome and WSL are left alone. See
[WINDOWS_UNINSTALL.md](WINDOWS_UNINSTALL.md).

---

## Reporting something

If a hash does not match, or Setup does something this page does not describe:
**stop, and open an issue** at
<https://github.com/ShiftAboveCtrl/ai17z/issues>. For anything you think is a
security problem, [SECURITY.md](../SECURITY.md) says how to report it privately.
