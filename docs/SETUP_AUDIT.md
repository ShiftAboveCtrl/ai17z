# Auditing AI17Z Setup

AI17Z Setup can turn on Windows features and install system software. That is a
lot of trust to ask for a download, so this page is what it does, in full, and
how to check that for yourself rather than taking our word for it.

**Install AI17Z only from the official repository:
<https://github.com/ShiftAboveCtrl/ai17z/releases>.** Nowhere else distributes
it. A copy from anywhere else is not AI17Z, whatever it is called.

---

## The short version

| | |
| --- | --- |
| What you download | `Install-AI17Z-<version>.exe` |
| What it actually is | a wrapper that extracts two files — [`packaging/windows/Setup-AI17Z.ps1`](../packaging/windows/Setup-AI17Z.ps1), which is the whole program, and an icon — and runs the first one |
| Where that script is | in this repository, in full, and published beside the .exe as `Install-AI17Z-<version>.ps1` |
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
| `%LOCALAPPDATA%\AI17Z-setup\` | the setup log, the copy of the script, and the resume note while a restart is pending |
| Start Menu → `AI17Z` | five shortcuts: start, diagnostics, stop, update, uninstall |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\...` | the Add/Remove Programs entry |
| `HKCU\Software\AI17Z\Installs` | so the next run finds this installation rather than making a second one |

Per user, under your own profile. Nothing is written to `Program Files`, nothing
machine-wide, no system files, no drivers.

**A second installation** made with `/INSTANCE=<name>` derives every one of those
paths from that name and shares nothing with the first.

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

---

## Checking it yourself

### 1. Read the script

It is the whole program. Start here:

- [`packaging/windows/Setup-AI17Z.ps1`](../packaging/windows/Setup-AI17Z.ps1)

The `$script:Ai17zSetup` block at the top is the complete list of what it may
reach, install and write. Nothing below it adds a host or a package that is not
declared there.

### 2. Check what you downloaded

```powershell
Get-FileHash .\Install-AI17Z-<version>.exe -Algorithm SHA256
```

Compare it to `SHA256SUMS.txt` on the release page. **If it does not match, stop.
Do not run it.** Delete it and download it again; if it still does not match,
open an issue rather than running it.

### 3. Check the signature

```powershell
Get-AuthenticodeSignature .\Install-AI17Z-<version>.exe | Format-List Status, SignerCertificate
```

`Status` must be `Valid` and the signer must be the publisher named in
[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).

While AI17Z's [SignPath Foundation](https://signpath.org) application is pending,
releases are **unsigned and say so on the release page**. Until then the SHA-256
above is the check that matters. See
[Windows trust and SmartScreen](WINDOWS_TRUST.md) for what that means and what
Windows will show you.

### 4. Check the .exe contains the script in this repository

Both are published. The `.ps1` asset on the release page is the file the `.exe`
extracts and runs:

```powershell
Get-FileHash .\Install-AI17Z-<version>.ps1 -Algorithm SHA256
```

Compare that to the file in the repository at the release's tag:

```powershell
git -C <your clone> show v<version>:packaging/windows/Setup-AI17Z.ps1 > from-repo.ps1
Get-FileHash .\from-repo.ps1 -Algorithm SHA256
```

The two hashes are the same file. To see the copy inside the `.exe`, run the
installer once: it extracts to `%LOCALAPPDATA%\AI17Z-setup\Setup-AI17Z.ps1`
before doing anything else, and that file stays there afterwards for exactly this
reason.

### 5. Make it tell you what it would do

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-AI17Z-<version>.ps1 -WhatIfOnly
```

It looks at the machine, prints what it would install, and changes nothing. The
`.exe` does the same with `/WHATIF`.

And to print its own declared permissions as JSON:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-AI17Z-<version>.ps1 -Manifest
```

That output is where this page's tables come from, and a test in this repository
fails if the two ever disagree.

Every release also publishes **`AI17Z-Setup-Audit-<version>.json`**, which is
that same declaration plus what this particular release is: the tag, the commit,
the workflow run that built it, whether it was signed, and the SHA-256 of every
file published beside it. It is generated after signing, from the files that are
actually published, so its hashes are the ones you will get.

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
repository, the published source, the signed artifact, the published hash, and
the fact that everything Setup installs comes from Microsoft's package manager
rather than from us.

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

## What the hash actually protects against

Worth being precise, because "verified" is a word that gets used loosely.

The `.exe` compiled for a release carries **the exact release tag and the exact
SHA-256** of the application package for that release. So a signed `.exe` is a
pin on the payload, not just on a filename: the bytes that get installed are the
bytes that were built alongside the setup program that you checked the signature
of.

Run the `.ps1` directly without those arguments and it falls back to the newest
release and to the hash published in that release's own `SHA256SUMS.txt`. That
still catches a truncated download, a corrupted one, and a mismatched asset. It
is **not** a defence against a release that has itself been tampered with,
because the checksum file and the package would have been replaced together. The
defence against that is the signature on the artifacts and the fact that releases
are built by a GitHub workflow from a public tag, not uploaded from anybody's
laptop.

Neither the `.exe` nor the `.ps1` will install a package whose hash it cannot
establish. There is no flag to skip the check.

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
| **A flag being used to run something else** | the `.exe` forwards two arguments and one of them is reduced to `[A-Za-z0-9._-]` first. There is no general pass-through |
| **A tampered resume note** | it is read for which instance was being set up and nothing else. Every step re-probes the machine, and a note from another instance, another schema or another day is discarded |
| **Secrets in the log** | anything key-shaped is blanked as it is written, not as it is read |
| **A compromised GitHub release** | **not defended against by the hash.** The checksum file and the package would have been replaced together. The defences are the signature on the artifacts and the fact that releases are built by a public workflow from a public tag, never uploaded from anybody's machine |
| **A compromised winget package** | not ours to defend. It is the same trust you place in winget every other time you use it, which is the argument for using it rather than fetching binaries ourselves |
| **Windows warning you anyway** | expected, while the artifacts are unsigned. See [Windows trust and SmartScreen](WINDOWS_TRUST.md), which is honest about how long a signature takes to stop that |

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

If a hash does not match, a signature does not validate, or Setup does something
this page does not describe: **stop, and open an issue** at
<https://github.com/ShiftAboveCtrl/ai17z/issues>. For anything you think is a
security problem, [SECURITY.md](../SECURITY.md) says how to report it privately.
