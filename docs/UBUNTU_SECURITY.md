# AI17Z on Ubuntu: what it touches, and what it does not

Ubuntu has no SmartScreen and no Gatekeeper. What it has is `sudo`, APT's own
signature checking, and file permissions — and AI17Z works with all three rather
than around any of them.

## What asks for sudo, and why

| Step | Needs sudo | Why |
| --- | --- | --- |
| Downloading and checking the package | no | it goes into a temporary directory you own |
| `apt install ./ai17z_*.deb` | **yes** | installing a system package writes under `/usr` |
| Installing Docker Engine, if you ask for it | **yes** | same reason, and it is Docker's repository |
| Installing Chrome, if you ask for it | **yes** | same reason, and it is Google's package |
| Starting Docker, if it is stopped | **yes** | `systemctl start docker` |
| Everything AI17Z itself does afterwards | **no** | your data is in your home |

The installer **refuses to run as root**. It asks for `sudo` per command, where a
system change genuinely needs it, so that everything else runs as you and the
files it creates belong to you.

Running the whole thing under `sudo` would put your agents, your master key and
your signed-in browser profile in root-owned files in your own home. That is why
it is refused rather than merely discouraged.

## The docker group

Being in the `docker` group means being able to control the Docker daemon, and
that is **equivalent to root on the machine** — a container can mount the host
filesystem. This is not a formality and AI17Z does not treat it as one.

- AI17Z never adds you to it silently.
- It explains what the group grants, in those words, before offering.
- It tells you the change takes effect at your next login.
- If you say no, it stops and points at rootless Docker instead.

**Rootless Docker that already works is left rootless.** AI17Z does not replace
a working rootless setup with a rooted one.

## APT and repository trust

If AI17Z installs Docker Engine for you, it uses Docker's own APT repository the
way Docker currently documents it:

- the key in its own file at `/etc/apt/keyrings/docker.asc`
- a DEB822 `.sources` entry binding that key to that repository and nothing else
- the codename of the Ubuntu release you actually have

It does **not** use `apt-key`, which is deprecated and puts a key in a keyring
that signs everything. It does **not** use `get.docker.com`, which Docker itself
says is not for production and which is the fetch-and-run pattern AI17Z's own
installer exists to avoid.

Installing Google Chrome adds Google's APT repository, so Chrome updates with
the rest of your system from then on. That is Google's design, not AI17Z's
choice, and the installer says so before doing it.

AI17Z never removes container tooling you already have, and never replaces
working Docker because it came from a different source.

## Network exposure

**AI17Z binds to loopback and stays there.** The interface, the API and the
database are published on `127.0.0.1` only.

- No firewall rules are added or changed. `ufw` is never touched.
- Nothing is bound to a public address by default.
- If you configure a non-loopback bind, `ai17z doctor` warns about it.

To reach a server installation from elsewhere, tunnel rather than expose:

```bash
ssh -L 8080:127.0.0.1:8080 you@your-server
```

## Secrets and permissions

`~/.config/ai17z` is created mode `0700` before anything is written into it,
because the first thing it holds is the key every stored provider credential is
sealed with. The environment file itself is `0600`.

Each installation generates its own database password, once, on first run. A
shipped default would be the same password on every machine that ever installed
AI17Z. Neither it nor the master key is ever regenerated — doing so on an update
would point a working installation at an empty database, which looks exactly
like having lost everything.

Nothing AI17Z logs contains a key, a token or a password.

## What the package does to your machine

`dpkg -c` will show you, but in short:

- `/usr/lib/ai17z` — the application and its private Node runtime
- `/usr/bin/ai17z` — the command
- `/usr/share/applications/ai17z.desktop` — the launcher
- `/usr/share/doc/ai17z` — copyright and changelog

The maintainer scripts are deliberately almost empty. They create no user,
initialise no home directory, touch nothing under `/root`, and never scan
`/home`. They run as root, and the blast radius of a wrong path there is
somebody else's data.

`apt purge` removes what the package installed and **nothing you made**. Your
agents, memories, keys and browser session are in your home and survive it. That
is asserted by a test that installs the package, purges it, and checks the
directories are still there.

## Chrome and the browser worker

Chrome is never run as root and never with `--no-sandbox`. AI17Z uses a
dedicated profile under your own data directory, not the Chrome profile you
browse with.

On a machine with no graphical session, the browser worker is not started at
all. A worker restarting for ever against a screen that does not exist is worse
than one that never began, and `ai17z doctor` reports **not available** rather
than a failure.

## What has been tested, and where

The package, the installer and the lifecycle are exercised against a real
Ubuntu 24.04. A container has no screen and is one release, so Chrome,
Docker Engine, 22.04, 26.04 and arm64 hardware are described here from
their vendors' documentation rather than from having been run.

[What still needs a real machine](UBUNTU_TEST_CHECKLIST.md) lists each one.
