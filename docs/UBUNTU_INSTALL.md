# Installing AI17Z on Ubuntu

## The short way

```bash
curl -fsSLO https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install-ai17z-ubuntu.sh
less install-ai17z-ubuntu.sh
bash install-ai17z-ubuntu.sh
```

Reading it first is the documented route, not a fallback. The installer is
short on purpose so that looking at it before running it is a reasonable thing
to do rather than a gesture.

**Install AI17Z only with the command published here.** Nowhere else
distributes it.

### What it does

Resolves the newest AI17Z release, downloads the `.deb` for your architecture,
**checks its SHA-256 against the hash that release published**, and installs it
with `apt`. A mismatch deletes the file and stops. There is no flag past it.

You run it as yourself. It asks for `sudo` exactly where installing a system
package genuinely needs it, and nowhere else.

## Supported versions

| | |
| --- | --- |
| Ubuntu | 22.04, 24.04 and 26.04 LTS |
| Architectures | amd64 and arm64 |
| Ubuntu derivatives | not supported, and the installer says so rather than guessing |

Those are the releases where the whole stack is supported together: Docker
Engine's own supported list, intersected with what AI17Z needs. An older Ubuntu
is refused rather than half-installed.

## What AI17Z brings, and what it does not

**AI17Z brings its own Node.** The package carries the exact Node it was built
and tested against, verified against nodejs.org's published checksums at build
time. Nothing consults your `PATH`, nothing is installed system-wide, and
removing or upgrading a system Node cannot change how AI17Z behaves. Most
desktop Ubuntu users have no Node at all, and they do not need one.

**Docker is yours, not AI17Z's.** AI17Z needs it for the database and will not
take ownership of it:

- Docker already works → **left completely alone**, whatever installed it
- rootless Docker already works → left alone, and stays rootless
- installed but stopped → offers to start it
- missing → offers to install Docker Engine from **Docker's own APT repository**,
  using the keyring and `.sources` method Docker documents

It never uses `get.docker.com`, which Docker itself says is not for production,
and never `apt-key`, which is deprecated. It never removes container tooling you
already have.

**The `docker` group is a real decision.** Membership grants control of the
Docker daemon, which is equivalent to root on the machine. AI17Z says that in
those words and asks. It never adds you quietly.

**Chrome is optional.** AI17Z drives real Google Chrome for X and other
browser-backed channels. Without it everything else works and those stay
unavailable — that is a normal state, not a broken install. If you want it, the
installer offers Google's official package and tells you that installing it adds
Google's APT repository, because that is Google's design and you should know
about it.

## Where things go

| | |
| --- | --- |
| Program | `/usr/lib/ai17z` (root-owned, replaced by `apt`) |
| Command | `/usr/bin/ai17z` |
| Your configuration | `~/.config/ai17z` — including the master key |
| Your data | `~/.local/share/ai17z` — storage, browser profiles |
| Logs | `~/.local/state/ai17z` |

Every one honours its `XDG_*` override. Nothing an owner makes is ever written
under `/usr`, which is what makes an upgrade safe: `apt` replaces the program and
cannot touch your agents.

The directories are created the first time you run `ai17z`, as you, with mode
`0700` — the first thing in them is the key your provider credentials are sealed
with.

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

`ai17z` refuses to run as root. A browser profile owned by root is one you
cannot read afterwards, and a stack started as root writes files into your home
you then cannot delete.

## Ubuntu Server

AI17Z installs and runs backend-only on a machine with no graphical session.
That is a supported arrangement, not a degraded one:

- the database, API, interface and jobs worker all run
- browser support reports **not available**, because there is no screen
- `ai17z doctor` says so rather than reporting a failure

Nothing installs a desktop, an X server or a virtual framebuffer to pretend
otherwise.

**Reaching it from another machine:** AI17Z binds to loopback and stays there.
Use an SSH tunnel rather than exposing it:

```bash
ssh -L 8080:127.0.0.1:8080 you@your-server
```

Then open `http://127.0.0.1:8080` on your own machine. AI17Z never opens a
firewall port and never binds to a public address by itself.

## Updating

```bash
ai17z update
```

It finds the newest release, **checks whether this machine can run it before
stopping anything**, verifies the package against its published hash, stops this
installation, installs, starts, and confirms the version that came up is the one
that was asked for.

If the new release needs something this machine does not have — a newer Docker,
a supported Ubuntu — it says so and changes nothing. The version you have keeps
running. AI17Z will not update Docker or Chrome while updating itself.

A downgrade is refused. An older application against a database that has already
migrated forward has no good ending.

`sudo apt install ./ai17z_<version>_<arch>.deb` also works and preserves your
data in exactly the same way.

## Removing it

```bash
sudo apt remove ai17z      # the program. Your data is untouched.
ai17z uninstall            # what that keeps, and where it is
ai17z uninstall --remove-data   # everything, after listing it and asking
```

`apt purge` removes what the package installed and **nothing an owner made**.
The maintainer scripts never scan home directories and never touch `/root`.

Docker and Chrome are left alone, whether or not AI17Z helped install them.
Removing AI17Z never removes unrelated containers or volumes.

## If something is wrong

```bash
ai17z doctor
```

It distinguishes what is installed, running, healthy, unavailable and needing
action, rather than collapsing everything into pass or fail. See
[UBUNTU_SECURITY.md](UBUNTU_SECURITY.md) for what AI17Z does and does not do to
your machine.
