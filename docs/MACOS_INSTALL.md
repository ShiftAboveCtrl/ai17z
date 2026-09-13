# Installing AI17Z on macOS

## The short way

```bash
curl -fsSLO https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install-ai17z-macos.sh
less install-ai17z-macos.sh
bash install-ai17z-macos.sh
```

Downloading and reading before running is the documented route, not a fallback.
macOS increasingly warns about long commands pasted from web pages into
Terminal, and it is right to: an installer you cannot read is one you cannot
check. The file is short so that reading it is reasonable.

**Install AI17Z only with the command published here.** Nowhere else
distributes it.

## Before anything else: what is and is not signed

**AI17Z's macOS packages are not signed with an Apple Developer ID and are not
notarized.** See [MACOS_TRUST.md](MACOS_TRUST.md) for what that means in
practice, what you will and will not be asked, and why the package is a tarball
rather than a `.app`, `.pkg` or `.dmg`.

AI17Z does not disable Gatekeeper, strip quarantine attributes, or self-sign
anything and call it trusted.

## Supported versions

| | |
| --- | --- |
| macOS | 13 Ventura and newer |
| Architectures | Apple Silicon (arm64) and Intel (x86_64) |

macOS 13 is **Google's** floor for Chrome, which AI17Z drives — not a number
AI17Z chose. Docker Desktop separately supports only the current and two
previous macOS releases; on an older-but-supported macOS, Docker Desktop may
refuse to install and will say so itself.

Both architectures are built natively, on their own runners. An arm64 package is
never an Intel build wearing a different name.

## What AI17Z brings, and what it does not

**AI17Z brings its own Node.** The package carries the exact Node it was built
against, verified against nodejs.org's published checksums, and the architecture
of that binary is checked at build time. You do not need Node, Homebrew, Git or
any developer tooling, and installing or removing them cannot change how AI17Z
behaves.

**Docker Desktop is yours, not AI17Z's.** It supplies the Linux VM that runs the
database, API, interface and jobs worker. The installer:

- uses it if it is already running
- starts it and waits for the engine to actually answer if it is installed
- offers to download it from Docker's own host if it is missing, then opens
  **Docker's own installer** so Docker collects its own licence acceptance

AI17Z never accepts a vendor's agreement on your behalf. If Docker asks you to
accept terms or finish first-run setup, AI17Z says so and waits for you.

Installing Docker Desktop needs your administrator password. **Docker's
installer asks for it, not AI17Z.**

**Chrome is optional.** AI17Z drives real Google Chrome — never Chromium — for X
and other browser-backed channels, using a dedicated profile that is not the one
you browse with. Without Chrome everything else works and those channels stay
unavailable.

## Where things go

Everything is in your own Library. Nothing is installed system-wide and **no
part of AI17Z ever needs `sudo`**.

```
~/Library/Application Support/AI17Z/AI17Z/
    ai17z              the command
    app/               replaced by an update
    runtime/node/      the private Node this installation runs
    data/              .env, the master key, storage  — never replaced
    browser-profiles/  your signed-in Chrome session — never replaced
    logs/
```

The installer also links `ai17z` into `~/.local/bin` and tells you if that is
not on your `PATH`. It never writes to `/usr/local/bin`, which would need `sudo`.

## Using it

```
ai17z start        start AI17Z
ai17z launch       start it and open the interface
ai17z stop         stop this installation
ai17z status       what is running right now
ai17z logs         follow the logs
ai17z doctor       what is installed, running, healthy or missing
ai17z update       check for a newer AI17Z and install it
ai17z uninstall    how to remove AI17Z, and what that keeps
```

## More than one AI17Z

```bash
bash install-ai17z-macos.sh --instance AI17Z-test
```

Each installation is its own directory under `Application Support`, with its own
agents, database, browser profile and ports. They share nothing, and updating
one leaves the others exactly as they are.

## Updating

```bash
ai17z update
```

**No `sudo`, and no Git.** Everything AI17Z replaces is in your own Library.

It checks whether this Mac can run the new release **before stopping anything**,
verifies the package against its published hash, and stages the new application
in a temporary directory — confirming the package says the version it was asked
for — before swapping it in. The previous `app` and `runtime` are kept until the
new one has started and reported the right version.

A failure anywhere before the swap leaves your working installation working. A
failure during the swap puts the old one back.

Your `data` and `browser-profiles` are never part of what is replaced.

## Removing it

```bash
ai17z uninstall                 # stops it, and says what is where
ai17z uninstall --remove-data   # everything, after listing it and asking
```

The default keeps everything you made. Removing the program alone is deleting
`app/` and `runtime/` from the installation directory; the command tells you
exactly that.

Docker Desktop and Chrome are left alone whether or not AI17Z helped install
them. Removing AI17Z never removes unrelated containers or volumes.

## If something is wrong

```bash
ai17z doctor
```

If Docker Desktop is installed but AI17Z says its engine is not answering, open
Docker and finish whatever it is asking for — first-run setup or its own terms.
AI17Z waits for the engine to genuinely answer rather than assuming that Docker
being installed is the same as Docker being ready.
