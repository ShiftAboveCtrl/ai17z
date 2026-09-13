# macOS trust, Gatekeeper, and what is actually true

Written to be precise rather than reassuring. Every claim here is one AI17Z can
stand behind, and the things it cannot claim are named as such.

## The short version

| | |
| --- | --- |
| Is the macOS package signed with an Apple Developer ID? | **No** |
| Is it notarized? | **No** |
| Does AI17Z disable Gatekeeper, or tell you to? | **No, and it never will** |
| Does it strip quarantine attributes to get past a warning? | **No** |
| Does it self-sign and present that as trusted? | **No** |
| What verifies the package instead? | a SHA-256 published by the release, checked before anything is unpacked |
| What proves where it came from? | GitHub artifact attestation — build provenance, **not** Apple notarization |

## Why it is a tarball

A `.app`, a `.pkg` or a `.dmg` downloaded from the internet is quarantined by
macOS and, without a Developer ID signature, meets Gatekeeper as an unidentified
developer. That produces a dialog whose correct answer for an unknown download
is "don't open it" — and the only ways past it are to talk somebody through
overriding a security decision, or to disable the protection. AI17Z will do
neither.

So the recommended route does not produce one of those files. You download a
shell script, read it, and run it; it downloads a `.tar.gz`, checks its hash,
and extracts it into your own Library. A tar extracted by a script you ran
yourself does not become a quarantined application bundle.

**This is not a way around Gatekeeper and this page will not describe it as
one.** Gatekeeper's job is to make an opinion about applications you downloaded
and launched. A script you read and ran deliberately is a different operation,
and the check does not apply rather than being defeated.

## What you may still legitimately be asked

AI17Z's own installation asks for nothing: no administrator password, no
security prompt, no override. Everything it writes is in your own home.

What can still ask you, legitimately, and why:

| Prompt | Who is asking | Why |
| --- | --- | --- |
| Administrator password when installing Docker Desktop | **Docker's installer** | It installs a system component. AI17Z does not ask for it and never sees it. |
| Docker's Subscription Service Agreement | **Docker** | Their terms, collected by them. AI17Z never accepts a vendor agreement for you. |
| Docker asking to finish first-run setup | **Docker** | AI17Z waits for the engine to answer rather than assuming it is ready. |
| Google Chrome's first-run screens | **Google** | Their terms, their software. |
| Terminal asking about a pasted command | **macOS** | Modern macOS warns about long commands pasted from web pages, which is exactly why AI17Z's documented route is to download and read the installer instead. |

If any of those appear, they are the operating system or a vendor doing their
job. None of them is AI17Z asking you to lower a defence.

## What is not verified, and by what

Being exact about this matters more than sounding secure.

**A SHA-256 published by a release is not a signature.** It proves the bytes you
got are the bytes that release published. If the release itself were tampered
with, the checksum would have been replaced alongside the payload and nothing in
the chain would notice.

**What stands against that** is that releases are built by a public GitHub
workflow from a public tag, never uploaded from anybody's machine, and that
every published file is one you can read.

**GitHub artifact attestation** signs a statement that these exact bytes came out
of that workflow, at that commit, in that repository. That is build provenance.
It is **not** Apple notarization, **not** code signing, and **not** a claim that
any platform vendor has examined AI17Z. Verifying it needs the GitHub CLI and is
never required to install AI17Z.

## Why not notarize

Notarization requires an Apple Developer Program membership, which is a paid
account tied to a real identity. AI17Z does not currently have one. When that
changes, this page changes with it — and until then it says so rather than
implying a signature is on the way.

The same reasoning produced the Windows answer: AI17Z applied for free
open-source code signing, was declined for not yet having a user base, and chose
a route that does not need one rather than shipping an unsigned executable and
explaining the warning away.

## What AI17Z will never ask of you

**It will never ask you to disable Gatekeeper, turn off System Integrity
Protection, run `spctl`, remove a quarantine attribute, or click past a security
warning.** Not in the installer, not in the documentation, not in a support
answer.

A test in this repository fails if any of those commands appears in the
installer, and another fails if the sentence disclosing that the package is
unsigned is removed.

If something asks you to lower a macOS protection in order to run AI17Z, it is
not AI17Z.

## Verifying what you downloaded

```bash
shasum -a 256 AI17Z-macos-arm64-<version>.tar.gz
```

Compare it to the line in `SHA256SUMS.txt` on the release page. The installer
does this itself and refuses on a mismatch, having written nothing.

With the GitHub CLI, the provenance as well:

```bash
gh attestation verify AI17Z-macos-arm64-<version>.tar.gz --repo ShiftAboveCtrl/ai17z
```

## Reporting a problem

If a hash does not match, or AI17Z does something this page does not describe:
**stop, and open an issue** at
<https://github.com/ShiftAboveCtrl/ai17z/issues>. For anything you believe is a
security problem, [SECURITY.md](../SECURITY.md) says how to report it privately.

## What is written here has not been watched happen

Every prompt described above is derived from Apple's documented behaviour
and from how the package is built -- not from somebody sitting at a Mac
watching it. No Mac has been available. The difference matters, so it is
stated rather than glossed over.

[What still needs a Mac](MACOS_TEST_CHECKLIST.md) lists each unobserved
item. If you run it and something here is wrong, that document is where to
record it.
