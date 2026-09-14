# macOS: what has been tested, and what needs a Mac

AI17Z's macOS packages are now built and run on real Macs, on every push:
`macos-15` for Apple Silicon and `macos-15-intel` for Intel. The package, the
runtime, the architecture of both binaries, every workspace import, the
lifecycle, the compatibility gate and the installer are all exercised there --
see "Hosted platform validation" in `RELEASE_VALIDATION_REPORT.md`.

What a hosted runner cannot represent is a person at a Mac: the dialogs, the
downloads, and Docker Desktop's own setup. That is what is left here, and it is
a much shorter list than it was.

Nothing below is a promise about behaviour that has not been observed.

## Proved on a real Mac, on every push

`.github/scripts/prove-macos-package.sh` and `prove-macos-installer.sh`, run by
the `macos-15` and `macos-15-intel` jobs. Both green.

- the bundled Node starts and reports `darwin` and the right architecture
- `file` confirms Node **and** esbuild are genuinely that architecture
- esbuild runs; tsx transforms TypeScript
- all ten workspace packages import
- the launcher runs from a path with a space in it
- an unknown command is refused; root is refused
- `data`, `logs` and `browser-profiles` are created 0700, beside the program
- `doctor` produces a report from a packaged layout
- the compatibility gate answers both ways, and no Chrome is a note not a refusal
- the installer refuses a bad hash, a missing file, the other architecture and
  an unknown option -- and installs, reruns keeping the master key, and leaves
  the owner's data alone on uninstall
- the finished tarball is unpacked and scanned

## Also proved on Linux, against real artifacts

These run in `packaging/macos/test-tarball.sh`, which builds the real package
with the real script — including fetching Node's darwin binaries from nodejs.org
and verifying them against the published `SHASUMS256.txt`.

- Both packages build: `AI17Z-macos-arm64-<version>.tar.gz` and
  `AI17Z-macos-x64-<version>.tar.gz`
- Each carries a Node binary that `file` confirms is genuinely that
  architecture — an arm64 package holding an x86_64 runtime fails the build
- A Node archive that cannot be verified stops the build
- The package carries the launcher, `app`, `runtime`, `VERSION` and `LICENSE`
- Permissions come from what each file is, not from what the build host said
- No corepack, no Windows shims, no Python
- **No `.env`, no `storage`, no browser profile can reach a package** — planted
  in three places and the build must strip all of them, while keeping
  `.env.example`
- The installer refuses a non-Mac, refuses macOS below 13, refuses root
- The installer never runs `spctl`, `xattr -d`, `--master-disable`, `codesign`
  or `sudo`
- The installer states that the package is not signed and not notarized

## BLOCKED: needs a Mac

Every item here is unobserved. Do not describe any of it as working.

### The package actually running

- [x] `runtime/node/bin/node --version` runs and reports the bundled version  *(hosted, both architectures)*
- [x] `node -p 'process.arch'` matches the package's architecture  *(hosted, both architectures)*
- [x] `tsx` transforms TypeScript using the bundled runtime  *(hosted, both architectures)*
- [x] native modules load — particularly `esbuild` and anything the worker needs  *(hosted, both architectures)*
- [ ] on Apple Silicon, the arm64 package runs **without** Rosetta

### Gatekeeper, quarantine and Terminal

The reason the package is a tarball rather than a `.app`. All of it is theory
until somebody watches it.

- [ ] downloading `install-ai17z-macos.sh` with `curl` — does it carry a
      quarantine attribute? (`xattr -l install-ai17z-macos.sh`)
- [ ] downloading it with **Safari**, which quarantines differently
- [ ] `bash install-ai17z-macos.sh` — any Gatekeeper prompt at all?
- [ ] the downloaded `.tar.gz` — quarantine attribute present?
- [ ] the extracted tree — do quarantine attributes propagate to `ai17z` or to
      the bundled `node`?
- [ ] running `ai17z` for the first time — any prompt?
- [ ] pasting a long command into Terminal — what does macOS say, on the
      current release?

**Record what actually happens, including nothing happening.** If a legitimate
prompt appears, document it precisely in `MACOS_TRUST.md` and categorise it:
platform authorization, vendor authorization, or AI17Z-caused. The goal is zero
AI17Z-caused prompts, not zero prompts.

**Do not** resolve any prompt by disabling a protection. If one appears that
cannot be removed by architecture, it gets documented, not bypassed.

### Docker Desktop

- [ ] detected when already installed and running
- [ ] `open -a Docker` starts it and the bounded wait works
- [ ] the DMG downloads for the right architecture
- [ ] `hdiutil attach` and Docker's own installer open correctly
- [ ] Docker collects its **own** licence acceptance — AI17Z never does
- [ ] the installer resumes correctly after Docker's first-run setup
- [ ] `docker info` and `docker compose version` both answer before AI17Z
      continues

### Chrome and the browser worker

- [ ] real Chrome found at `/Applications` and at `~/Applications`
- [ ] a dedicated profile is used, never the owner's everyday one
- [ ] the worker starts only when a graphical session exists
- [ ] `launchctl print gui/$(id -u)` is a correct screen test over ssh
- [ ] the worker survives a Chrome restart and a Docker restart
- [ ] stopping kills the process tree, not just the recorded pid

### The full lifecycle

- [ ] `ai17z start` brings up containers and reaches health
- [ ] paths containing spaces work throughout — `Application Support` has one
- [ ] `ai17z doctor` reports truthfully on a real Mac
- [ ] `ai17z update` stages, swaps, and keeps the previous app until the new one
      reports the right version
- [ ] a failed update restores the previous application
- [ ] `ai17z uninstall` keeps data; `--remove-data` lists before removing
- [ ] a second `--instance` shares nothing with the first
- [ ] **updating one instance leaves the others byte-identical** — the macOS
      equivalent of the Windows three-instance regression

### Intel specifically

- [ ] the x64 package installs and runs on a real Intel Mac
- [ ] GitHub's `macos-13` runner is still available when the release is built

## How to record results

Put observations in `docs/RELEASE_VALIDATION_REPORT.md` under the release they
were made for, with the macOS version and hardware. An unchecked box here is
more useful than a checked one nobody can trace.

---

## Against the published Beta 1.0.0 (17), on a Mac you own

Everything above is machine proof. This is the part that needs a person, in the
order a person would meet it. Each step says what should happen, so a
disagreement is a finding rather than a feeling.

Nothing here asks you to lower a macOS protection. If any step seems to, stop.

**1. Fetch the installer and read it.**

```bash
cd ~/Downloads
curl -fsSLO https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install-ai17z-macos.sh
less install-ai17z-macos.sh
```

*Expected:* a shell script you can read end to end. It should mention
`SHA256SUMS.txt`, and it should say the package is not signed or notarized
before it unpacks anything.

**2. Check what a browser download actually carries.**

The installer uses `curl`, which sets no quarantine attribute. A file you
download in Safari or Chrome does. Do both, and look:

```bash
xattr -p com.apple.quarantine ~/Downloads/install-ai17z-macos.sh 2>&1
```

*Expected:* `No such xattr` for the `curl` copy, and a value for a browser copy.
**Do not remove it.** Note what macOS then does when you run each.

**3. Install.**

```bash
bash install-ai17z-macos.sh
```

*Expected:* it works out Apple Silicon or Intel, names the package it is
fetching, prints the SHA-256 it checked and says it matched, tells you the
packages are unsigned, and never asks for `sudo`. Everything lands in
`~/Library/Application Support/AI17Z/<instance>/`, and a launcher is symlinked
into `~/.local/bin` -- never `/usr/local/bin`, which would need `sudo`.

*Write down:* which architecture it chose, and whether that is the machine you
are on.

**4. Docker Desktop, if it is not already there.**

*Expected:* AI17Z offers Docker's own installer and hands you to Docker's own
first run and licence. **AI17Z must never accept a licence for you.** If a
licence is accepted without you reading and clicking it, that is a defect worth
reporting immediately.

**5. Start it, and watch the first run.**

*Expected:* the images build on this machine (there is no registry), then the
interface opens. The first build is slow -- minutes -- and should say what it is
doing rather than sitting silent.

**6. The diagnostics.**

The installer symlinks a launcher into `~/.local/bin`, and says so -- including
what to add to your shell profile when that is not on your `PATH`. Either form
works:

```bash
ai17z doctor
"$HOME/Library/Application Support/AI17Z/AI17Z/ai17z" doctor
```

*Expected:* it finds the installation, reports the ports, and says whether
browser support is available. On a Mac with Chrome it should be available.

*Also check:* it never asked for `sudo`, and nothing was written outside your
home. The second form is the installation's own launcher, under
`~/Library/Application Support/AI17Z/<instance>/`, where `<instance>` is `AI17Z`
unless you asked for another name.

**7. Sign in to X through a real Chrome window.** This is the one thing no
runner can do.

*Expected:* AI17Z opens a Chrome window with a profile of its own and **touches
nothing on the page**. You type. If X asks for a code, a CAPTCHA, or confirms an
unusual login, AI17Z should stop and leave the window alone -- it must never
answer a security challenge. Your everyday Chrome profile must be untouched.

**8. Update.**

```bash
ai17z update
```

*Expected:* the compatibility check runs **before anything stops**, so a Mac
that cannot run the arriving version keeps the one it has, running. Your `.env`,
master key, database and signed-in profile all survive. The Version panel in
Settings shows the same thing and names the installation it belongs to; AI17Z
never updates itself without being asked.

**9. Reboot the Mac, and start AI17Z again.**

*Expected:* Docker comes back, the containers come back, and the signed-in X
session is still signed in.

### Verifying the download yourself

```bash
shasum -a 256 AI17Z-macos-arm64-1.0.0-beta.17.tar.gz
curl -fsSL https://github.com/ShiftAboveCtrl/ai17z/releases/download/v1.0.0-beta.17/SHA256SUMS.txt
```

And the provenance, which needs the GitHub CLI and is never required to install:

```bash
gh attestation verify AI17Z-macos-arm64-1.0.0-beta.17.tar.gz --repo ShiftAboveCtrl/ai17z
```

*Expected:* the hashes agree, and the attestation verifies against this
repository's release workflow. That is build provenance -- **not** Apple
notarization, and not a claim that Apple has examined AI17Z.

### If something disagrees

Say what actually happened, including nothing happening, at
<https://github.com/ShiftAboveCtrl/ai17z/issues>. A step that behaved
differently from the sentence above is worth reporting even if it worked.
