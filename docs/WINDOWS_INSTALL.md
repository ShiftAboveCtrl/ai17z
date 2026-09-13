# Installing AI17Z on Windows

## The short way

1. Download **`Install-AI17Z-<version>.exe`** from the
   [releases page](https://github.com/ShiftAboveCtrl/ai17z/releases).
2. Run it.
3. Follow the status screen.
4. AI17Z opens when it is ready.

**Only install AI17Z from the official repository above.** Nowhere else
distributes it.

Check what you downloaded against `SHA256SUMS.txt`, published beside it:

```powershell
Get-FileHash .\Install-AI17Z-1.0.0-beta.16.exe -Algorithm SHA256
```

If it does not match, stop. Do not run it.

## What that installer actually is

One PowerShell script —
[`packaging/windows/Setup-AI17Z.ps1`](../packaging/windows/Setup-AI17Z.ps1), in
this repository, in full — and a wrapper that extracts and runs it. It is a
script rather than compiled logic because it can turn on Windows features and
install system software, and that is exactly the kind of program somebody should
be able to read before running.

To see what it would do to this PC without doing any of it:

```powershell
.\Install-AI17Z-1.0.0-beta.16.exe /WHATIF
```

**[How to audit it](SETUP_AUDIT.md)** covers every privileged action, every
download, everything it writes, what it never does, and how to check the hash and
the signature. Read that first if you want to.

## About the warning you will see

While AI17Z's SignPath Foundation application is pending, the download is
**unsigned**, and Windows will say so. You will see "Windows protected your PC"
and have to choose **More info → Run anyway**.

That warning is doing its job. An unsigned installer is one Windows has no
publisher information for, and you should treat every unsigned download that way
— including this one. Verify the SHA-256 above against the release page before
you run it.

We will not ask you to turn off SmartScreen, Smart App Control, Defender or any
other protection. Once signing is in place the warning goes away on its own as
the signature accumulates reputation. See
[Windows trust and SmartScreen](WINDOWS_TRUST.md), which is honest about how long
that takes.

**Code signing policy:** [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md). Free
code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What it installs, and what it leaves alone

| | Why | Installed if missing |
| --- | --- | --- |
| **WSL 2** | what Docker Desktop runs on. No Linux distribution is added | `wsl --install --no-distribution` |
| **Docker Desktop** | runs PostgreSQL, the API and the interface | winget |
| **Node.js 22+** | runs the worker that drives your browser | winget |
| **Google Chrome** | AI17Z drives real Chrome, and nothing else substitutes for it | winget |

Anything already present and new enough is left exactly as it is. Everything
comes from **winget**, Microsoft's own package manager, or from Windows itself.
AI17Z never downloads an executable from a link of its own.

You will see **one** Windows administrator prompt, for WSL 2 and Docker Desktop,
explained on screen before it appears. Chrome and Node.js install per user and
need no prompt at all.

If Windows asks for a restart — it sometimes does, after turning on WSL 2 —
Setup says so, saves where it got to, and leaves **Continue AI17Z Setup** in your
Start Menu. Open that after the restart and it carries on. It re-checks
everything rather than trusting what it wrote down.

Prefer to install the prerequisites yourself? Do that first and Setup will find
them and skip all four. `-SkipDependencies` makes it check and never install.

## Watching it more closely

The status screen is deliberately quiet: one row per thing a person would
recognise, and everything each step runs goes to a log rather than scrolling
past. If you want the detail on screen as well, run the script with
`-ShowDetails`.

Either way the whole of it is written to
`%LOCALAPPDATA%\AI17Z-setup\setup-<date>.log`, with anything key-shaped blanked
on the way in. If something goes wrong, that file is what to look at — and what
to attach to an issue.

## Where things go

| | |
| --- | --- |
| Program | `%LOCALAPPDATA%\Programs\AI17Z` |
| Your data | `%LOCALAPPDATA%\AI17Z` |
| Setup log | `%LOCALAPPDATA%\AI17Z-setup` |

Per user: your own account, no administrator rights for AI17Z itself, nothing in
`Program Files`.

Your data is kept apart from the program on purpose. Updating replaces the
program directory and never touches the data directory, and the uninstaller has
to be asked before it removes it.

Five Start Menu entries: **AI17Z** to start and open it, **AI17Z diagnostics**,
**Stop AI17Z**, **Update AI17Z** and **Uninstall AI17Z**.

## First run

The first launch builds AI17Z's containers, which takes several minutes and
needs network. Later launches are quick. Setup waits for that and then checks
AI17Z actually works — that the API is healthy, the database is behind it, and
the page being served is the application — before it says it is ready.

AI17Z opens in your browser. Create your owner account, then add a model provider
and connect an X account when you are ready.

## A second installation

```powershell
.\Install-AI17Z-1.0.0-beta.16.exe /INSTANCE=AI17Z-test
```

Everything is derived from that one name: the program folder, the data folder,
the Start Menu group, the Add/Remove Programs entry, the Docker project and the
ports. A second installation shares nothing with the first — not its database,
not its browser profile, not its containers — and updating either one leaves the
other alone.

## Updating

AI17Z tells you when there is a newer version. **Settings → Version** shows what
changed and how this copy takes an update.

For a copy installed with AI17Z Setup, that is **Update AI17Z** in the Start
Menu: it stops this copy, downloads the new release, checks it against its
published SHA-256, replaces the program, applies any database migrations, starts
it again, and checks it works. If the hash does not match, nothing is replaced.

For a copy installed with the older full installer, `AI17Z-Setup-<version>.exe`,
it is a new one of those run over the top. Both routes keep working, and neither
touches `%LOCALAPPDATA%\AI17Z` — your agents, memories, knowledge, saved browser
sessions and encryption key all survive.

**Nothing updates itself.** There is no updater process, nothing restarts on its
own, and an update you ignore stays ignored. You can skip a version so it is
never mentioned again, or turn the check off entirely — off means no request is
made at all. See [Privacy](PRIVACY.md).

## The full installer

`AI17Z-Setup-<version>.exe` is still published. It carries the application inside
it rather than downloading it, which is useful on a machine with no network at
install time, and it is what installations made before AI17Z Setup existed update
with. It offers to install the prerequisites through winget but does not check
that Docker's engine is actually running before it finishes, which is the main
thing AI17Z Setup does differently.

Both produce the same program directory and the same data directory, and either
can update an installation the other made.

## If you forget your password

There is no email reset, because AI17Z has no servers and no account with us.
Recovery is local and requires access to this machine:

```powershell
npm run owner:password
```

See [WINDOWS_UNINSTALL.md](WINDOWS_UNINSTALL.md) for removal, and
[PRIVACY.md](PRIVACY.md) for what AI17Z does and does not send anywhere.
