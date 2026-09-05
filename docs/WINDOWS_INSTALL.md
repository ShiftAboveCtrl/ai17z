# Installing AI17Z on Windows

## Download

Get `AI17Z-Setup-<version>.exe` from the
[releases page](https://github.com/ShiftAboveCtrl/ai17z/releases).

Check it against `SHA256SUMS.txt`, published beside it:

```powershell
Get-FileHash .\AI17Z-Setup-0.1.0.exe -Algorithm SHA256
```

**Code signing policy:** see [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

## About the warning you will see

While AI17Z's SignPath Foundation application is pending, the installer is
**unsigned**, and Windows will say so. You will see "Windows protected your PC"
and have to choose **More info → Run anyway**.

That warning is doing its job. An unsigned installer is one Windows has no
publisher information for, and you should treat every unsigned download that way
— including this one. Verify the SHA-256 above against the release page before
you run it.

We will not ask you to turn off SmartScreen, Smart App Control, Defender or any
other protection. Once signing is in place the warning goes away on its own as
the signature accumulates reputation.

## What you need first

AI17Z does not install other software on your machine. The installer checks for
these and tells you what is missing:

| | Why | Where |
| --- | --- | --- |
| **Node.js 20+** | runs AI17Z | <https://nodejs.org/en/download> |
| **Docker Desktop** | runs PostgreSQL and the API | <https://www.docker.com/products/docker-desktop/> |
| **Google Chrome** | AI17Z drives the real Chrome, and nothing else substitutes for it | <https://www.google.com/chrome/> |

Setup finishes either way. If something is missing, install it and start AI17Z
again.

## Installing

Run the installer. It is **per-user**: it installs to your own account, needs no
administrator rights, and raises no UAC prompt.

| | |
| --- | --- |
| Program | `%LOCALAPPDATA%\Programs\AI17Z` |
| Your data | `%LOCALAPPDATA%\AI17Z` |

You get three Start Menu entries: **AI17Z** to start and open it, **AI17Z
diagnostics** to check what is missing, and **Stop AI17Z**. A desktop shortcut
is offered and is off by default.

## First run

The first launch builds AI17Z's containers, which takes several minutes and
needs network. Later launches are quick.

AI17Z opens in your browser. Create your owner account, then add a model
provider and connect an X account when you are ready.

## Upgrading

Run the newer installer over the top. It replaces the program directory and
**never touches `%LOCALAPPDATA%\AI17Z`**, so your agents, memories, knowledge,
saved browser sessions and encryption key all survive.

## If you forget your password

There is no email reset, because AI17Z has no servers and no account with us.
Recovery is local and requires access to this machine:

```powershell
npm run owner:password
```

See [WINDOWS_UNINSTALL.md](WINDOWS_UNINSTALL.md) for removal, and
[PRIVACY.md](PRIVACY.md) for what AI17Z does and does not send anywhere.
