# Installing AI17Z on Windows

## The short way

Open **Windows Terminal** and paste this:

```powershell
irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | iex
```

That is the whole installation. It checks what this PC has, installs anything
missing, installs AI17Z, starts it, checks it actually works, and opens it.

**Install AI17Z only with the command above.** It is published here and on the
[project page](https://github.com/ShiftAboveCtrl/ai17z), and nowhere else
distributes AI17Z.

## Why a command rather than a download

AI17Z is not signed. Free certificates for open-source projects are granted on
the strength of an existing user base; AI17Z applied and was turned down for not
having one yet.

So an AI17Z `.exe` would be an unsigned executable Windows has never seen, and
Windows would warn you about it, and Windows would be right. The answer to that
is not to talk you past the warning — it is to not ask for one.

**Nothing above is an executable, nothing is double-clicked, and no Windows
security feature is touched, turned off or argued with.** Not SmartScreen, not
Smart App Control, not Defender, not your execution policy. Windows' default
execution policy permits individual commands and refuses script files; the
command above is individual commands, and so is the way it runs what it fetches.

## What actually runs

[`install.ps1`](../install.ps1) is the file at that URL: around 200 lines of code
under a long comment explaining itself, in this repository, and short enough to
read before you paste anything. Open the URL in a browser first if you like —
that is what it is there for.

All it does is:

1. ask GitHub for the newest release;
2. download that release's setup program;
3. **check its SHA-256 against the hash that release published** — and stop, with
   nothing written and nothing run, if they disagree;
4. write the checked file to `%LOCALAPPDATA%\AI17Z-setup\Setup-AI17Z.checked.ps1`,
   where you can read it;
5. run the bytes it checked, in a separate process that hashes the file again
   first.

The setup program itself is
[`packaging/windows/Setup-AI17Z.ps1`](../packaging/windows/Setup-AI17Z.ps1) — the
whole installer, as a script, published with every release as
`Install-AI17Z-<version>.ps1`. It is a script rather than compiled logic because
it can turn on Windows features and install system software, and that is exactly
the kind of program somebody should be able to read before running.

To see what it would do to this PC without doing any of it:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1))) -WhatIfOnly
```

**[How to audit it](SETUP_AUDIT.md)** covers every privileged action, every
download, everything it writes, what it never does, how to check the hashes, and
— honestly — what that first URL does and does not protect you against. Read
that first if you want to.

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
past. If you want the detail on screen as well:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1))) -ShowDetails
```

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

A machine can hold as many AI17Z installations as you like. They share nothing —
not the database, not the browser profile, not the containers — and **updating
one leaves the others exactly as they are.**

```powershell
$s = irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1
& ([scriptblock]::Create($s)) -List                 # what is installed here
& ([scriptblock]::Create($s)) -NewInstance          # install another
& ([scriptblock]::Create($s)) -Instance AI17Z-test  # act on that one
```

Everything is derived from the one name: the program folder, the data folder, the
Start Menu group, the Add/Remove Programs entry, the Docker project and the
ports.

Run the plain command on a machine that already has AI17Z and it **asks** which
you meant rather than guessing. With several installed and nobody there to ask,
it stops and tells you how to name one. It never picks for you, because picking
wrong means replacing an installation somebody did not ask it to touch.

## Updating

AI17Z tells you when there is a newer version. **Settings → Version** shows what
changed and how this copy takes an update.

**An update updates one installation: the one it was started from.** *Update
AI17Z* in the Start Menu belongs to that installation, and the update screen in
the application updates the copy you are looking at. Neither goes looking for
another installation on the machine, and both refuse a request naming one that is
not their own.

An update stops that copy, downloads the new release, checks it against its
published SHA-256, replaces the program directory, applies any database
migrations, starts it again, and checks it works. If the hash does not match,
nothing is replaced.

A copy installed with the older full installer updates the same way, and so does
one installed with the command. Neither touches `%LOCALAPPDATA%\AI17Z` — your
agents, memories, knowledge, saved browser sessions and encryption key all
survive.

**Nothing updates itself.** There is no updater process, nothing restarts on its
own, and an update you ignore stays ignored. You can skip a version so it is
never mentioned again, or turn the check off entirely — off means no request is
made at all. See [Privacy](PRIVACY.md).

## The older full installer

`AI17Z-Setup-<version>.exe` is still published, and is **unsigned and not the
recommended route**. It carries the application inside it rather than downloading
it, which is useful on a machine with no network at install time, and it is what
installations made before the terminal route update with.

If you run it, Windows will warn you that it does not know the publisher, and
that is correct — it does not. We will not tell you to click past that. Use the
command at the top of this page instead.

Both routes produce the same program directory and the same data directory, and
either can update an installation the other made.

## If you forget your password

There is no email reset, because AI17Z has no servers and no account with us.
Recovery is local and requires access to this machine:

```powershell
npm run owner:password
```

See [WINDOWS_UNINSTALL.md](WINDOWS_UNINSTALL.md) for removal, and
[PRIVACY.md](PRIVACY.md) for what AI17Z does and does not send anywhere.
