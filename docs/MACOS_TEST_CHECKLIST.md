# macOS: what has been tested, and what needs a Mac

AI17Z's macOS support is implemented and its packaging is verified. What has
**not** happened is anyone running it on a Mac, because no Mac hardware or
runner has been available. This page is the honest split, so that the first
person with a Mac knows exactly what to look at rather than starting from
nothing.

Nothing below is a promise about behaviour that has not been observed.

## Proved, on Linux, against real artifacts

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

- [ ] `runtime/node/bin/node --version` runs and reports the bundled version
- [ ] `node -p 'process.arch'` matches the package's architecture
- [ ] `tsx` transforms TypeScript using the bundled runtime
- [ ] native modules load — particularly `esbuild` and anything the worker needs
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
