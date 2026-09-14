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
