# Windows trust, SmartScreen, and what is actually true

Written because most advice on this subject is out of date, including advice
this project's own documentation gave until now.

## The short version

| | |
| --- | --- |
| Unsigned installer | Windows warns. You choose "Run anyway". Verify the SHA-256 first |
| Signed installer, new | Windows still warns at first. Reputation accrues with downloads |
| Signed installer, established | No warning |
| Microsoft Store app | No warning, ever |

AI17Z is currently the first row and is applying for the second.

## EV certificates no longer skip SmartScreen

They used to. They do not now. Microsoft:

> EV certificates no longer bypass SmartScreen. Years ago, signing files with an
> Extended Validation (EV) code signing certificate would result in positive
> SmartScreen reputation by default, but this behavior no longer exists.

The change was made in 2024. An EV-signed file builds reputation exactly as an
OV-signed one does, so **paying the EV premium purely to avoid SmartScreen buys
nothing**. EV still means stricter identity validation, which can matter for
enterprise procurement. It does not affect what a user sees on download.

This project's own notes said otherwise until this was written down. They were
wrong.

## How reputation actually accrues

SmartScreen weighs two things: whether the publisher's signing certificate is
known and trusted, and whether this specific file has been downloaded by enough
people without trouble.

An unsigned file starts from zero **every release**, because there is no
publisher identity for reputation to attach to. A signed file lets reputation
accumulate against the certificate, so later releases can inherit trust from
earlier ones — which is the real argument for signing.

Microsoft's own estimate for a new file is "several weeks and hundreds of clean
installs from a wide audience".

## There is no way to ask Microsoft for reputation

This is the part people get wrong most often. Microsoft:

> There is no need (or mechanism) to manually submit a file for SmartScreen
> reputation review for consumer endpoints. Reputation builds organically
> through download volume.

**Two different systems, often confused:**

| | Purpose | Who it is for |
| --- | --- | --- |
| **SmartScreen application reputation** | whether a download is familiar enough not to warn | nobody submits to this; it is earned |
| **[Microsoft Security Intelligence submission](https://www.microsoft.com/en-us/wdsi/filesubmission)** | reporting malware, or a false positive on clean software | anybody, for a *detection* problem |

If AI17Z is ever wrongly flagged as malware or unwanted software, the second is
the right channel and we will use it. It is **not** a way to whitelist an
installer for reputation, and describing it that way would be misleading.

Enterprise administrators may submit files there to accelerate trust inside
their own managed estate. That is a different situation from a public download.

## Smart App Control

On Windows 11, Smart App Control can supersede SmartScreen application
reputation. Microsoft describes it as using app intelligence to decide whether
software is trusted, with a trusted signature as one path to that; software it
cannot establish as trusted may be blocked, and its checks apply to all
executables rather than only downloaded ones.

Stated that way deliberately. It is tempting to write "it blocks everything
unsigned", and that is broader than Microsoft claims. The practical conclusion
does not need the exaggeration: a trusted signature matters for more than
avoiding one warning dialog.

## What AI17Z will never ask of you

**We will not ask you to disable SmartScreen, Smart App Control, Defender or
your antivirus, or to add an exclusion for AI17Z.** Not in the installer, not in
the documentation, not in a support answer.

If a download needs you to lower your defences before it will run, that is worth
knowing about the download. Verify the SHA-256 against the release page instead,
and read [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) for how our builds are
produced and who can approve a signature.

## Why not the Microsoft Store

Store apps are re-signed by Microsoft and never trigger SmartScreen, and
registration is free. It is the strongest trust outcome available and it is
currently impractical for AI17Z, for architectural reasons rather than policy
ones:

- AI17Z drives **the real Google Chrome** the owner already has, spawned and
  attached to over a loopback debug port. Playwright's bundled Chromium is
  explicitly not a substitute anywhere in this codebase.
- It needs **PostgreSQL**, through Docker Desktop or an existing server.
- It runs a **long-lived local service** that binds loopback ports, spawns
  processes, and writes browser profiles it must find again.

A packaged Win32 app with full trust could bind loopback and spawn processes.
What it cannot do is bring Chrome, Postgres and Docker with it, and an app whose
first run is "now install three other things" is not what Store certification is
for.

Not impossible forever. A Store-shaped AI17Z would need an embedded database, no
Docker, and a settled answer to the Chrome dependency — and that is a decision
about what AI17Z is, not a packaging exercise.

## Sources

- [Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [SignPath Foundation conditions for open source projects](https://signpath.org/terms.html)
