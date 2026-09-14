#!/usr/bin/env bash
#
# Installs AI17Z on Ubuntu.
#
#   curl -fsSLO https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install-ai17z-ubuntu.sh
#   less install-ai17z-ubuntu.sh      # read it first. That is why it is short.
#   bash install-ai17z-ubuntu.sh
#
# It resolves the newest AI17Z release, downloads the .deb for this
# architecture, **checks its SHA-256 against the hash that release published**,
# and installs it with apt. A mismatch stops everything, and there is no flag to
# skip the check.
#
# Run it as yourself, not with sudo. It asks for sudo exactly where a system
# package genuinely needs it, and your agents, keys and browser session are
# yours -- created in your home, owned by you.
#
# What it will never do: install Docker or Chrome behind your back, accept a
# vendor's licence on your behalf, add you to a group without saying what that
# grants, open a firewall port, or bind AI17Z to anything but loopback.

set -euo pipefail

REPOSITORY="ShiftAboveCtrl/ai17z"
API="https://api.github.com/repos/${REPOSITORY}/releases"
# The same list the other installers declare. A request that does not start at
# one of these is refused rather than followed.
ALLOWED_HOSTS="api.github.com github.com objects.githubusercontent.com release-assets.githubusercontent.com"
# Ubuntu releases where the whole stack is supported: Docker Engine's own list,
# intersected with what AI17Z needs. Checked rather than assumed.
SUPPORTED_UBUNTU="22.04 24.04 26.04"

RELEASE=""            # --release vX.Y.Z
ASSUME_YES=0          # --yes
SKIP_START=0          # --no-start
# A package somebody already has, and the hash they expect it to have.
#
# The offline route, and the one the packaging workflow uses to test this script
# against the package a run has just built -- which is the only way to exercise
# an installer without publishing a release first. Windows' setup program has had
# -LocalPackage and -ExpectedSha256 for the same two reasons.
#
# --sha256 is required with it. An installer that will install a local file
# without checking it is a different program from this one.
LOCAL_PACKAGE=""      # --package <file>
EXPECT_SHA=""         # --sha256 <hex>
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --package) LOCAL_PACKAGE="$2"; shift 2 ;;
    --sha256) EXPECT_SHA="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-start) SKIP_START=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    '') shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Saying things
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; GREY=$'\033[90m'; OFF=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; CYAN=""; GREY=""; OFF=""
fi
step()  { printf '  %s%s%s\n' "$CYAN" "$1" "$OFF"; }
good()  { printf '  %s+ %s%s\n' "$GREEN" "$1" "$OFF"; }
note()  { printf '  %s%s%s\n' "$GREY" "$1" "$OFF"; }
warn()  { printf '  %s! %s%s\n' "$YELLOW" "$1" "$OFF"; }

stop() { # what why do
  printf '\n  %s%s%s\n' "$RED" "$1" "$OFF"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | while IFS= read -r l; do printf '  %s%s%s\n' "$GREY" "$l" "$OFF"; done
  if [ -n "${3:-}" ]; then
    printf '\n'
    printf '%s\n' "$3" | while IFS= read -r l; do printf '  %s%s%s\n' "$YELLOW" "$l" "$OFF"; done
  fi
  printf '\n'
  exit 1
}

ask() { # question -> 0 yes, 1 no
  [ "$ASSUME_YES" = "1" ] && return 0
  [ -t 0 ] || return 1
  local reply=""
  printf '  %s%s [y/N] %s' "$YELLOW" "$1" "$OFF"
  read -r reply || true
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

assert_allowed_url() {
  local host
  case "$1" in
    https://*) host="${1#https://}"; host="${host%%/*}" ;;
    *) stop "AI17Z only downloads over HTTPS." "This address is not: $1" "Report this." ;;
  esac
  case " $ALLOWED_HOSTS " in
    *" $host "*) return 0 ;;
    *) stop "AI17Z will not download from ${host}." "It only downloads from its own GitHub release." \
         "Stop, and install AI17Z from https://github.com/${REPOSITORY}" ;;
  esac
}

fetch() { assert_allowed_url "$2"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$1" "$2"; }
fetch_stdout() { assert_allowed_url "$1"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$1"; }

printf '\n  %sAI17Z%s\n\n' "$GREEN" "$OFF"

# ---------------------------------------------------------------------------
# 1. Is this a machine AI17Z runs on?
# ---------------------------------------------------------------------------
step "Checking this computer"

[ "$(id -u)" != "0" ] || stop \
  "Run this as yourself, not with sudo." \
  "AI17Z's agents, keys and browser session belong to you, and a root install
makes files in your home that you cannot then read or delete." \
  "Run it again without sudo:
  bash $0"

command -v sudo >/dev/null 2>&1 || stop "sudo is not installed." \
  "Installing a system package needs it." "Install sudo, or ask an administrator to."

[ -r /etc/os-release ] || stop "This does not look like Ubuntu." "There is no /etc/os-release." ""
# shellcheck disable=SC1091
. /etc/os-release

if [ "${ID:-}" != "ubuntu" ]; then
  # Derivatives are not automatically supported, and saying so is more honest
  # than installing and leaving somebody to discover which half works.
  stop "AI17Z's package is built and tested for Ubuntu." \
    "This is ${PRETTY_NAME:-${ID:-unknown}}. Ubuntu derivatives often work, but
AI17Z does not test them and will not claim they are supported." \
    "Install from source instead:
  https://github.com/${REPOSITORY}#from-source"
fi

UBUNTU_VERSION="${VERSION_ID:-}"
case " $SUPPORTED_UBUNTU " in
  *" $UBUNTU_VERSION "*) ;;
  *) stop "AI17Z supports Ubuntu ${SUPPORTED_UBUNTU// /, }." \
       "This is Ubuntu ${UBUNTU_VERSION:-unknown}. The whole stack -- Docker Engine,
Google Chrome and AI17Z's own runtime -- is only supported together on those." \
       "Upgrade Ubuntu, or install from source:
  https://github.com/${REPOSITORY}#from-source" ;;
esac

case "$(dpkg --print-architecture)" in
  amd64) ARCH=amd64 ;;
  arm64) ARCH=arm64 ;;
  *) stop "AI17Z has no package for this architecture." \
       "dpkg reports $(dpkg --print-architecture). AI17Z builds amd64 and arm64." "" ;;
esac
good "Ubuntu ${UBUNTU_VERSION} (${ARCH})"

# A graphical session is what decides whether browser support is even possible.
# A server is not a broken desktop, and nothing here installs a desktop to
# pretend otherwise.
if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
  HAS_DESKTOP=1; good "Graphical session detected"
else
  HAS_DESKTOP=0; note "No graphical session: AI17Z will install backend-only."
fi

for tool in curl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || stop "${tool} is not installed." \
    "The installer needs it to download and check the package." \
    "sudo apt install -y curl coreutils"
done

# ---------------------------------------------------------------------------
# 2. Which release, and what it published
# ---------------------------------------------------------------------------
step "Finding the newest AI17Z release"

WORK="$(mktemp -d)"
chmod 700 "$WORK"

if [ -n "$LOCAL_PACKAGE" ]; then
  [ -n "$EXPECT_SHA" ] || stop "--package needs --sha256." \
    "AI17Z will not install a file it cannot check, wherever the file came from." \
    "Pass the hash you expect:
  bash $0 --package <file> --sha256 <hex>"
  [ -f "$LOCAL_PACKAGE" ] || stop "There is no file at ${LOCAL_PACKAGE}." "" ""
  DEB_NAME="$(basename "$LOCAL_PACKAGE")"
  case "$DEB_NAME" in
    ai17z_*_"${ARCH}".deb) ;;
    ai17z_*) stop "That package is not for this computer." \
      "It is named ${DEB_NAME}, and this computer is ${ARCH}." "" ;;
    *) stop "That does not look like an AI17Z package." "${DEB_NAME}" "" ;;
  esac
  VERSION="${DEB_NAME#ai17z_}"; VERSION="${VERSION%_${ARCH}.deb}"
  TAG="v${VERSION}"
  cp "$LOCAL_PACKAGE" "$WORK/$DEB_NAME"
  EXPECTED="$EXPECT_SHA"
  note "Installing from a file rather than from a release: ${LOCAL_PACKAGE}"
  good "AI17Z ${VERSION}"
elif [ -n "$RELEASE" ]; then
  case "$RELEASE" in
    v[0-9]*|[0-9]*) ;;
    *) stop "\"$RELEASE\" is not a release version." "Releases are named like v1.0.0 or v1.0.0-beta.1." "" ;;
  esac
  RELEASE_JSON="$(fetch_stdout "${API}/tags/${RELEASE}")" || stop \
    "Release ${RELEASE} could not be read." "Nothing on this computer was changed." \
    "Check the name at https://github.com/${REPOSITORY}/releases"
else
  # Not /releases/latest: that hides prereleases, and every AI17Z release so far
  # is one.
  # The advice names no cause, because this cannot know one: `curl -f` collapses
  # every 4xx into one exit code, and the status cannot come back out of the
  # subshell this runs in. It used to say the connection was at fault, which is
  # the single explanation that is definitely wrong when GitHub is rate limiting.
  RELEASE_JSON="$(fetch_stdout "${API}?per_page=10")" || stop \
    "AI17Z could not be reached." "Nothing on this computer was changed." \
    "GitHub did not answer. That can be this connection, or GitHub refusing requests from this address -- it allows sixty an hour to anybody who is not signed in, which a shared network reaches on its own.
Wait a few minutes and run this again."
fi

if [ -z "$LOCAL_PACKAGE" ]; then
# One python-free pass over the JSON. `grep -o` on the fields wanted rather than
# a parser, because the only thing here that must be exact is a name and a URL,
# and both are checked against what this asked for afterwards.
TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TAG" ] || stop "That release does not exist." "" "See https://github.com/${REPOSITORY}/releases"
VERSION="${TAG#v}"

DEB_NAME="ai17z_${VERSION}_${ARCH}.deb"
DEB_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "https://[^\"]*/${DEB_NAME}" | head -1)"
SUMS_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^"]*/SHA256SUMS\.txt' | head -1)"

if [ -z "$DEB_URL" ]; then
  stop "Release ${TAG} does not contain ${DEB_NAME}." \
    "Nothing on this computer was changed." \
    "AI17Z published Ubuntu packages from the first release that had them.
If this is an older release, install a newer one:
  bash $0 --release <tag>
  https://github.com/${REPOSITORY}/releases"
fi
[ -n "$SUMS_URL" ] || stop "Release ${TAG} publishes no SHA256SUMS.txt." \
  "AI17Z will not install a package it cannot check." ""
good "AI17Z ${VERSION}"
fi

# ---------------------------------------------------------------------------
# 3. Download, and check before anything is installed
# ---------------------------------------------------------------------------
step "Downloading and checking the package"

if [ -z "$LOCAL_PACKAGE" ]; then
  fetch "$WORK/$DEB_NAME" "$DEB_URL"
  fetch "$WORK/SHA256SUMS.txt" "$SUMS_URL"

  EXPECTED="$(grep -E "[[:space:]]\*?${DEB_NAME}\$" "$WORK/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
  [ -n "$EXPECTED" ] || stop "Release ${TAG} publishes no hash for ${DEB_NAME}." \
    "AI17Z will not install a package it cannot check." ""
fi

# One check, whichever route the bytes arrived by.
ACTUAL="$(sha256sum "$WORK/$DEB_NAME" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  rm -f "$WORK/$DEB_NAME"
  stop "The package does not match its published SHA-256." \
    "expected  ${EXPECTED}
got       ${ACTUAL}

The file has been deleted and nothing was installed." \
    "Do not try again on the same network without thinking about why.
If it happens twice, stop and report it at https://github.com/${REPOSITORY}/issues"
fi
if [ -n "$LOCAL_PACKAGE" ]; then
  good "SHA-256 matches what was asked for"
else
  good "SHA-256 matches what ${TAG} published"
fi

# Downgrades are refused rather than attempted: apt would take it, and an older
# application against a newer database is a failure mode with no good ending.
if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Status}' ai17z 2>/dev/null | grep -q "install ok installed"; then
  INSTALLED="$(dpkg-query -W -f='${Version}' ai17z 2>/dev/null || echo '')"
  if [ -n "$INSTALLED" ] && [ "$INSTALLED" != "$VERSION" ]; then
    if ! dpkg --compare-versions "$VERSION" gt "$INSTALLED"; then
      stop "AI17Z ${INSTALLED} is already installed, and ${VERSION} is not newer." \
        "Nothing was changed. Installing an older AI17Z over a newer one would
leave the application behind the database it has already migrated." \
        "To reinstall this exact version anyway:
  sudo apt install --reinstall --allow-downgrades ./${DEB_NAME}"
    fi
    note "Upgrading AI17Z ${INSTALLED} to ${VERSION}. Your data is not touched."
  fi
fi

# ---------------------------------------------------------------------------
# 4. Docker, which AI17Z needs and does not own
# ---------------------------------------------------------------------------
step "Checking Docker"

# Docker Engine, installed the way Docker documents it.
#
# Not `curl https://get.docker.com | sh`: that is Docker's convenience script,
# which Docker itself says is not for production, and it is the same
# fetch-and-run pattern this installer exists to avoid. Not `apt-key` either --
# deprecated, and it puts a key in a keyring that signs everything.
#
# What this does is the current documented path: Docker's key in its own file
# under /etc/apt/keyrings, and a DEB822 .sources entry that binds that key to
# that repository and nothing else.
install_docker_engine() {
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL --proto '=https' --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg     -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc

  # The codename comes from the release this actually is. UBUNTU_CODENAME is
  # empty on some derivatives, and VERSION_CODENAME is the fallback Ubuntu's own
  # instructions use.
  local codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  [ -n "$codename" ] || stop "Cannot tell which Ubuntu release this is."     "/etc/os-release names no codename." "Install Docker yourself:
  https://docs.docker.com/engine/install/ubuntu/"

  sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${codename}
Components: stable
Architectures: ${ARCH}
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES

  note "Installing Docker Engine from download.docker.com"
  sudo apt-get update -qq
  # Named exactly. `docker-ce` and its compose plugin, and nothing that would
  # remove container tooling somebody already has.
  # Through a pipe rather than `sudo cmd > file`: the redirect happens as
  # this user either way, and a pipe says so. pipefail carries apt's exit
  # status through the tee, so a failed install is still a failed install.
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>&1 | tee "$WORK/docker-install.log" >/dev/null || {
      tail -20 "$WORK/docker-install.log" >&2
      stop "Docker Engine would not install." "The apt output above says why."         "Install it yourself: https://docs.docker.com/engine/install/ubuntu/"
    }
  sudo systemctl enable --now docker >/dev/null 2>&1 || true
}

docker_state() {
  command -v docker >/dev/null 2>&1 || { echo missing; return; }
  if docker info >/dev/null 2>&1; then
    docker compose version >/dev/null 2>&1 && echo ready || echo no-compose
  elif sudo -n docker info >/dev/null 2>&1; then
    echo needs-group
  else
    echo not-running
  fi
}

DOCKER_STATE="$(docker_state)"
case "$DOCKER_STATE" in
  ready)
    good "Docker is installed and answering ($(docker --version | sed 's/,.*//'))"
    ;;
  no-compose)
    stop "Docker is running, but the Compose plugin is missing." \
      "AI17Z runs its database and services with 'docker compose'." \
      "sudo apt install -y docker-compose-plugin
Then run this installer again."
    ;;
  not-running)
    warn "Docker is installed but its engine is not answering."
    if ask "Start Docker now (sudo systemctl start docker)?"; then
      sudo systemctl start docker || true
      sleep 3
      DOCKER_STATE="$(docker_state)"
    fi
    [ "$DOCKER_STATE" = "ready" ] || stop "Docker's engine still is not answering." \
      "AI17Z cannot run without it." \
      "Start it and run this again:
  sudo systemctl start docker
  docker info"
    good "Docker is answering"
    ;;
  needs-group)
    # Root-equivalent access, and nobody gets added to that group quietly.
    warn "Docker works for root but not for you."
    note "Adding yourself to the 'docker' group grants control of the Docker"
    note "daemon, which is equivalent to root on this machine. That is a real"
    note "decision, not a formality."
    if ask "Add $(id -un) to the docker group?"; then
      sudo usermod -aG docker "$(id -un)"
      good "Added. This takes effect on your next login."
      note "Log out and back in, then run this installer again."
      note "Or, without logging out:  newgrp docker"
      exit 0
    fi
    stop "AI17Z needs to reach Docker as you." \
      "Nothing was installed." \
      "Either add yourself to the docker group, or set up rootless Docker:
  https://docs.docker.com/engine/security/rootless/"
    ;;
  missing)
    warn "Docker is not installed."
    note "AI17Z needs it for the database. Docker is not AI17Z's software, so"
    note "this installs it from Docker's own APT repository -- the method"
    note "Docker documents -- and nothing else."
    if ask "Install Docker Engine from Docker's official repository?"; then
      install_docker_engine
      DOCKER_STATE="$(docker_state)"
      case "$DOCKER_STATE" in
        ready) good "Docker is installed and answering" ;;
        needs-group)
          good "Docker is installed."
          note "You are not yet in the 'docker' group, which grants root-equivalent"
          note "control of the daemon."
          if ask "Add $(id -un) to the docker group?"; then
            sudo usermod -aG docker "$(id -un)"
            good "Added. Log out and back in, then run this installer again."
            exit 0
          fi
          stop "AI17Z needs to reach Docker as you." "Nothing further was installed." \
            "Add yourself to the docker group, or use rootless Docker."
          ;;
        *) stop "Docker was installed but its engine is not answering." "" \
             "sudo systemctl start docker
Then run this installer again." ;;
      esac
    else
      stop "AI17Z needs Docker." "Nothing was installed." \
        "Install it yourself and run this again:
  https://docs.docker.com/engine/install/ubuntu/"
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# 5. Install
# ---------------------------------------------------------------------------
step "Installing AI17Z"
# `apt install ./file.deb` rather than `dpkg -i`: apt resolves the package's
# dependencies, dpkg leaves them broken and tells somebody to fix it themselves.
sudo apt-get install -y "$WORK/$DEB_NAME" 2>&1 | tee "$WORK/apt.log" >/dev/null || {
  tail -20 "$WORK/apt.log" >&2
  stop "The package would not install." "The apt output above says why." ""
}
good "AI17Z ${VERSION} installed"

# ---------------------------------------------------------------------------
# 6. Chrome, which is optional and which AI17Z also does not own
# ---------------------------------------------------------------------------
step "Checking Google Chrome"
if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then
  good "Google Chrome $(google-chrome --version 2>/dev/null | grep -o '[0-9.]*' | head -1 || echo present)"
elif [ "$HAS_DESKTOP" = "0" ]; then
  note "No graphical session, so Chrome is not useful here."
  note "AI17Z installs backend-only: everything except browser-backed channels."
else
  note "Google Chrome is not installed."
  note "AI17Z drives real Chrome for X and other browser-backed channels."
  note "Without it everything else works and those stay unavailable."
  if ask "Install Google Chrome from Google's official package?"; then
    CHROME_DEB="google-chrome-stable_current_${ARCH}.deb"
    if curl -fsSL --proto '=https' -o "$WORK/$CHROME_DEB" \
         "https://dl.google.com/linux/direct/${CHROME_DEB}"; then
      note "Google's package adds Google's own APT repository, so Chrome updates"
      note "with the rest of your system from then on. That is Google's design."
      sudo apt-get install -y "$WORK/$CHROME_DEB" 2>&1 | tee "$WORK/chrome.log" >/dev/null \
        && good "Google Chrome installed" \
        || warn "Chrome would not install. AI17Z is fine; browser features stay unavailable."
    else
      warn "Google does not publish a Chrome package for ${ARCH} at that address."
      note "AI17Z is installed. Browser features stay unavailable until Chrome is."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 7. Start it, and prove it works
# ---------------------------------------------------------------------------
if [ "$SKIP_START" = "1" ]; then
  printf '\n  %sAI17Z %s is installed.%s\n\n' "$GREEN" "$VERSION" "$OFF"
  note "Start it with:  ai17z start"
  printf '\n'
  exit 0
fi

step "Starting AI17Z"
note "The first start builds AI17Z's containers. That takes a few minutes."
if ai17z start; then
  printf '\n  %sAI17Z is ready.%s\n\n' "$GREEN" "$OFF"
  note "ai17z doctor     what is installed, running and healthy"
  note "ai17z stop       stop it"
  note "ai17z update     check for a newer AI17Z"
  printf '\n'
else
  stop "AI17Z installed, but did not start cleanly." \
    "The package is installed and your data is safe." \
    "Find out what is wrong:
  ai17z doctor"
fi
