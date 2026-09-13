# Code signing policy

What AI17Z signs, what it does not, and what stands in place of a signature.

**AI17Z is not code signed.** This page says so first, because a code signing
policy that buries that under three paragraphs of process is a document written
to look reassuring rather than to be read.

---

## The short version

| | |
| --- | --- |
| Is anything signed? | No |
| Is that going to change? | Not soon, and not by us paying to look trustworthy |
| What is the recommended way in, then? | A terminal command that downloads nothing you double-click |
| What checks what you get? | A SHA-256, checked before anything is written and again before anything is run |

---

## Why not

Certificates that would actually help cost money AI17Z does not spend, and the
free route for open-source projects is conditional on something AI17Z does not
have.

**The free route.** [SignPath Foundation](https://signpath.org) provides
certificates to open-source projects, and AI17Z applied. The application was
**declined**, for the stated reason that the project does not yet have enough
users. That is a reasonable rule — a certificate is a scarce thing to hand to a
project nobody is running yet — and it is not one there is a way around. It is
worth re-applying when that changes, and this page will change with it.

**The paid route.** An ordinary certificate costs a few hundred a year and buys
less than people expect. Since 2024 an EV certificate no longer carries
SmartScreen reputation on day one either: reputation is built by the file being
downloaded and run, which a new release of a small project does not get.
[WINDOWS_TRUST.md](WINDOWS_TRUST.md) covers that in detail.

So the choice was between shipping an unsigned executable and finding a way in
that does not need one.

## What we do instead

**The recommended route downloads no executable.** Installation is a command
pasted into Windows Terminal:

```powershell
irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | iex
```

Nothing is double-clicked, so SmartScreen's reputation check — which is about
downloaded executables — never applies. **Nothing is disabled, excluded or
turned off to achieve that**, and nothing needs to be: Windows' default
execution policy permits individual commands, and everything above and
everything it runs are individual commands rather than script files being
launched. Your execution policy is not changed, and you are never asked to
change it.

**What replaces a signature is a hash and a public build.** `install.ps1` reads
the release's own `SHA256SUMS.txt`, hashes the setup program it downloaded before
writing it anywhere, and refuses to go on if the two disagree. The process that
then runs it hashes the file again. There is no flag to skip either check.

Every release is built by a public GitHub workflow from a public tag, from a
lockfile, on a hosted runner — never uploaded from a maintainer's machine — and
publishes the SHA-256 of every file in it. [SETUP_AUDIT.md](SETUP_AUDIT.md) is
the full account, including the parts a hash does not cover.

## The one executable that still exists

`AI17Z-Setup-<version>.exe`, the older full installer, is still built and still
published. It is **unsigned**, it is labelled as such on the release page, and it
is not the recommended route. It exists because installations made with it
update by running a newer one, and breaking those to tidy the architecture would
be the wrong trade.

If you run it, Windows will warn you, and Windows is right to. We will not tell
you to click past that warning. Use the command instead.

## Who could approve a signature

Nobody, currently, because there is nothing to approve. If AI17Z is ever signed,
this is the arrangement it will be signed under, and this section changes before
any of it happens rather than after:

| Role | Who |
| --- | --- |
| **Authors** — may write code and open pull requests | [@ShiftAboveCtrl](https://github.com/ShiftAboveCtrl) |
| **Reviewers** — review changes before they reach `main` | [@ShiftAboveCtrl](https://github.com/ShiftAboveCtrl) |
| **Approvers** — would approve a signing request | [@ShiftAboveCtrl](https://github.com/ShiftAboveCtrl) |

Any signing request would be approved **manually**, never by a policy that signs
on a push, so a compromised workflow could not produce a signed artifact without
a person approving it. Multi-factor authentication is required for every person
holding any of those roles, on both GitHub and any signing service, which is the
only thing standing between a stolen password and a signed release.

AI17Z is maintained by one person, and this table says so rather than inventing
a team. If more maintainers join, it changes before they are given a role.

## What would not be signed, if anything were

- Anything built from a fork, or from a branch that is not the release tag
- Anything a maintainer built locally
- Any artifact whose origin a signing service cannot verify
- Anything containing a component that is not open source

## Reporting a problem

Security issues: see [SECURITY.md](../SECURITY.md).

If you believe an AI17Z installation has been tampered with, do not run it. Open
a security report and include the SHA-256 of the file you have. Every release
publishes `SHA256SUMS.txt` beside every artifact in it.
