# Ubuntu: what has been tested, and what needs a real machine

The package is built on real Ubuntu machines of both architectures and
installed and exercised on every release this project claims to support --
22.04, 24.04 and 26.04 -- on every push. See "Hosted platform validation" in
`RELEASE_VALIDATION_REPORT.md`.

What none of those has is a screen. That is what is left here.

Nothing below is a promise about behaviour that has not been observed.

## Proved, in a real Ubuntu 24.04 container

`packaging/ubuntu/test-deb.sh`, `test-installer.sh` (15 cases),
`test-lifecycle.sh` (19 cases) and `packaging/unix/test-paths.sh` (15 cases)
all run against the real scripts and the real package.

### The package

- `ai17z_<version>_amd64.deb` and `..._arm64.deb` build
- `lintian` reports **0 errors**
- `dpkg -I` and `dpkg -c` agree with what was intended
- the bundled Node is fetched from nodejs.org and verified against the published
  `SHASUMS256.txt`; an unverifiable archive stops the build
- no corepack, no `.ps1`, no `.cmd`, no Python shims
- `changelog.Debian.gz` is present and correctly formed
- every lintian override carries its reason
- **no `.env`, no `storage`, no browser profile can reach a package** — planted
  and the build must strip them, while keeping `.env.example`
- `dpkg -i` installs, `dpkg -r` removes, `dpkg -P` purges, and a purge leaves the
  owner's data in `~/.local/share/ai17z` alone

### The installer script

- refuses root, refuses a non-Ubuntu OS, refuses an unsupported architecture
- refuses to downgrade
- verifies the `.deb` against the release's SHA-256 before installing
- downloads only from the declared hosts
- never runs `apt-key`, never fetches `get.docker.com`, never
  `--no-sandbox`, never disables a security control
- an unknown option is reported rather than ignored
- `--help` explains the download-and-read-first route

### The lifecycle

- `ai17z` refuses to run as root
- XDG directories are created 0700 and `XDG_*` overrides are honoured
- `start`, `stop`, `restart`, `status`, `logs`, `doctor`, `uninstall` each behave
- the launcher resolves the environment file through the one resolver
- `doctor` reports the install channel from `AI17Z_INSTALL_CHANNEL`, then
  `INSTALL_INFO.json`, then "checkout" — never by asking what is on PATH
- `update` runs preflight **before** stopping anything
- `shellcheck -S warning -x` is clean across every shell file in the repository

## BLOCKED: needs a real machine

### A graphical session

Everything about the browser is untested on Ubuntu, because the container has no
screen and installing one to pretend otherwise is exactly what the mission
forbids.

- [x] `ai17z doctor` on a headless server reports browser support NOT AVAILABLE
      and everything else healthy  *(hosted, and in every release container)*
- [ ] on a desktop, a `DISPLAY`/`WAYLAND_DISPLAY` session is detected correctly
- [ ] Chrome installs from Google's own APT repository, amd64 and arm64
- [ ] Chrome is **never** run as root and **never** with `--no-sandbox`
- [ ] a dedicated profile under `~/.local/share/ai17z/browser-profiles` is used
- [ ] the worker starts only where there is a screen
- [ ] sign-in in a real window persists across a restart
- [ ] stopping kills the process tree

### Docker Engine, for real

- [ ] `install_docker_engine()` adds Docker's DEB822 `.sources` and key correctly
- [ ] the keyring lands at `/etc/apt/keyrings/docker.asc` with the right mode
- [ ] `apt-get install` succeeds and `docker info` answers
- [ ] the owner is added to the `docker` group, and the installer says plainly
      that this is equivalent to root and needs a re-login
- [ ] AI17Z never accepts a Docker agreement

### Releases other than 24.04

- [x] Ubuntu 22.04 — the oldest declared supported  *(hosted, every push)*
- [x] Ubuntu 26.04 — the newest  *(hosted, every push)*
- [x] the `.deb`'s declared dependencies are satisfiable on each  *(hosted, every push)*

### arm64

- [x] the arm64 `.deb` installs and runs on real arm64 hardware  *(hosted, every push)*
- [x] the bundled Node reports `arm64`  *(hosted, every push)*
- [x] `ubuntu-24.04-arm` is still an available runner when the release is built  *(hosted, every push)*

### The full lifecycle on real hardware

- [ ] `ai17z start` brings up containers and reaches health
- [ ] the API answers, the web interface loads, migrations apply
- [ ] `ai17z update` upgrades in place and keeps the data
- [ ] a failed update leaves the working version running
- [ ] a second `--instance` shares nothing with the first
- [ ] **updating one instance leaves the others byte-identical** — the Ubuntu
      equivalent of the Windows three-instance regression
- [ ] a reboot: containers come back, nothing is lost
- [ ] `systemd --user` behaviour without lingering enabled

## How to record results

Put observations in `docs/RELEASE_VALIDATION_REPORT.md` under the release they
were made for, with the Ubuntu version and architecture. An unchecked box here
is more useful than a checked one nobody can trace.

---

## Against the published Beta 1.0.0 (17), on a machine you own

Everything above is machine proof, on real amd64 and arm64 runners and in
22.04, 24.04 and 26.04 containers. This is the part that needs a person: a real
session, a real screen or the deliberate absence of one, and a reboot.

Nothing here asks you to weaken APT verification or to add a repository that is
not Docker's own. If any step seems to, stop.

**1. Fetch the installer and read it.**

```bash
curl -fsSLO https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install-ai17z-ubuntu.sh
less install-ai17z-ubuntu.sh
```

*Expected:* a shell script you can read end to end, mentioning `SHA256SUMS.txt`
and Docker's own APT repository. It must not contain `get.docker.com` or
`apt-key`.

**2. Try it as root, and be refused.**

```bash
sudo bash install-ai17z-ubuntu.sh
```

*Expected:* it refuses, and says why: your agents, keys and browser session
belong to you, and a root install leaves files in your home you cannot delete.
Nothing should have been installed.

**3. Install as yourself.**

```bash
bash install-ai17z-ubuntu.sh
```

*Expected:* it picks the `.deb` for your architecture, prints the SHA-256 it
checked and says it matched, asks for `sudo` only where installing a system
package needs it, and says -- before offering it -- that adding yourself to the
`docker` group is equivalent to root on this machine.

*Write down:* the architecture it chose, and whether that is the machine you are
on (`dpkg --print-architecture`).

**4. The diagnostics, on whatever kind of machine this is.**

```bash
ai17z doctor
```

*Expected on a desktop:* browser support available.
*Expected on a server:* browser support **not available**, reported as a state
rather than as a failure, with everything else running. Nothing should have
installed a desktop, an X server or a virtual framebuffer.

**5. Where it listens.**

```bash
ss -ltnp | grep -E '8080|8787|55432'
```

*Expected:* `127.0.0.1` and nothing else. If you have deliberately changed that,
`ai17z doctor` should tell you every time it runs.

To reach a server from elsewhere, forward a port rather than opening one:

```bash
ssh -L 8080:127.0.0.1:8080 you@your-server
```

**6. Sign in to X through a real Chrome window.** Desktop only; this is the one
thing no runner can do.

*Expected:* AI17Z opens a Chrome window with a profile of its own and **touches
nothing on the page**. If X asks for a code, a CAPTCHA, or confirms an unusual
login, AI17Z stops and leaves the window alone. Your everyday profile is
untouched.

**7. Update.**

```bash
ai17z update
```

*Expected:* the compatibility check runs **before anything stops**, so a machine
that cannot run the new version keeps the one it has. Your `.env`, master key,
database and signed-in profile all survive.

**8. Reboot, and start it again.**

*Expected:* Docker comes back, the containers come back, and the signed-in X
session is still signed in.

**9. Remove it, and keep your data.**

```bash
ai17z uninstall     # explains what removing it leaves behind
sudo apt remove ai17z
```

*Expected:* the program goes and everything you made stays --
`~/.config/ai17z`, which holds `.env` and the key your provider credentials are
sealed with, and `~/.local/share/ai17z`, which holds storage and your signed-in
browser session. Nothing on any path through the package's own `postrm` touches
either. If you want them gone, remove them yourself.

### Verifying the download yourself

```bash
sha256sum ai17z_1.0.0-beta.17_amd64.deb
curl -fsSL https://github.com/ShiftAboveCtrl/ai17z/releases/download/v1.0.0-beta.17/SHA256SUMS.txt
```

And the provenance, which needs the GitHub CLI and is never required to install:

```bash
gh attestation verify ai17z_1.0.0-beta.17_amd64.deb --repo ShiftAboveCtrl/ai17z
```

*Expected:* the hashes agree, and the attestation verifies against this
repository's release workflow. That is build provenance -- **not** Canonical
signing, and not a claim that anybody has examined AI17Z.

### If something disagrees

Say what actually happened, including nothing happening, at
<https://github.com/ShiftAboveCtrl/ai17z/issues>. A step that behaved
differently from the sentence above is worth reporting even if it worked.
