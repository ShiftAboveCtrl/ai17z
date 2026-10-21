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
| What proves where it came from? | a Sigstore signature by AI17Z's release key, in the public transparency log: release provenance, **not** Apple notarization |
| Which Macs? | Apple silicon (M1 or newer) and Intel, each with its own package |
| Built on a Mac? | Assembled on Linux from the files a Mac would install, and refused unless every native file is byte for byte one a real Mac built and ran; [how](#how-the-mac-packages-are-made) |

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
| Administrator password when installing Docker Desktop | **`sudo`, for Docker's own installer** | It puts an application in /Applications and registers a privileged helper. AI17Z does not ask for it and never sees it, and you can decline and drag Docker across yourself instead. |
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

**What stands against that** is that releases are built by AI17Z Code's release pipeline, its own Forgejo Actions on runners that take nothing but this repository's tags, from a public tag, never uploaded from
anybody's machine, and that every published file is one you can read.

**Sigstore provenance** signs every published file with AI17Z's release key,
whose public half is `.forgejo/cosign.pub` in this repository: a bundle beside
each file, named `<file>.sigstore.json`, saying these exact bytes were signed
by that key, and recorded in Sigstore's public transparency log. That is release
provenance. It is **not** Apple notarization, **not** code
signing, and **not** a claim that any platform vendor has examined AI17Z.
Verifying it needs `cosign` and is never required to install AI17Z.

## How the Mac packages are made

AI17Z Code has no Mac. The Mac packages are assembled on its Linux release
runner from exactly what a Mac would have installed: Node's own build for that
Mac from nodejs.org, checked against Node's published SHA-256, and the prebuilt
packages npm publishes for that Mac (esbuild, @napi-rs/canvas, fsevents),
checked against the lockfile's integrity hashes. AI17Z compiles nothing, so
there is no step a Mac would have done differently.

That is a claim, so it is compared rather than trusted. Every native file in a
package (anything whose first bytes say it is executable code, whatever it is
called) must be byte for byte the file in a reference package that was built on
a real Mac of that processor and tested there: Apple silicon and Intel, both
built for v1.0.0-beta.76 on GitHub's hosted Macs and pinned by hash in
`.forgejo/native-references.json`. One file different, new or missing and the
package is refused. The release then goes out without Mac packages, says why,
and a Mac installs or stays on the newest release that has one.

What this does not do is run the new package on a Mac before publishing it.
Its JavaScript runs during the build, and every native file in it has already
run on a Mac inside the reference. The release notes say this on every release.

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

With `cosign`, the provenance as well:

```bash
cosign verify-blob AI17Z-macos-arm64-<version>.tar.gz \
  --bundle AI17Z-macos-arm64-<version>.tar.gz.sigstore.json \
  --certificate-identity "https://code.ai17z.io/AI17Z/ai17z//.gitlab-ci.yml@refs/tags/v<version>" \
  --certificate-oidc-issuer https://gitlab.com
```

## Reporting a problem

If a hash does not match, or AI17Z does something this page does not describe:
**stop, and open an issue** at
<https://code.ai17z.io/AI17Z/ai17z/issues>. For anything you believe is a
security problem, [SECURITY.md](../SECURITY.md) says how to report it privately.

## What is written here has not been watched happen

Every prompt described above is derived from Apple's documented behaviour
and from how the package is built -- not from somebody sitting at a Mac
watching it. No Mac has been available. The difference matters, so it is
stated rather than glossed over.

[What still needs a Mac](MACOS_TEST_CHECKLIST.md) lists each unobserved
item. If you run it and something here is wrong, that document is where to
record it.
