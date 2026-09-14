#!/usr/bin/env bash
#
# Installs AI17Z on macOS.
#
#   curl -fsSLO https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install-ai17z-macos.sh
#   less install-ai17z-macos.sh      # read it first. That is why it is short.
#   bash install-ai17z-macos.sh
#
# Downloading and reading before running is the documented route, not a
# fallback. macOS increasingly warns about long commands pasted from web pages
# into Terminal, and it is right to: an installer you cannot read is one you
# cannot check.
#
# AI17Z's Mac packages are **not** signed with an Apple Developer ID and are not
# notarized. Nothing here disables Gatekeeper, strips a quarantine flag, or
# pretends otherwise. What is offered instead is a readable installer, an exact
# release, and a SHA-256 checked before anything is unpacked.
#
# Everything AI17Z installs goes in your own Library. No sudo, ever, for AI17Z
# itself.

set -euo pipefail

REPOSITORY="ShiftAboveCtrl/ai17z"
API="https://api.github.com/repos/${REPOSITORY}/releases"
ALLOWED_HOSTS="api.github.com github.com objects.githubusercontent.com release-assets.githubusercontent.com desktop.docker.com"
# desktop.docker.com is Docker's own, and the only host here that is not
# AI17Z's release. It is in the list rather than reached around it: the
# Docker download used a bare curl, so the declared list was not the whole
# list, which is the kind of gap that makes a declaration worth nothing.
# Chrome's own floor, which is a Google decision rather than an AI17Z one.
# Docker Desktop separately supports the current and two previous macOS
# releases; on an older one it may refuse to install and will say so itself.
MIN_MACOS_MAJOR=13

RELEASE=""; ASSUME_YES=0; SKIP_START=0; INSTANCE="AI17Z"
# A package somebody already has, and the hash they expect it to have.
#
# The offline route, and the one the packaging workflow uses to test this script
# against the package a run has just built -- which is the only way to exercise
# an installer without publishing a release first. Windows' setup program has had
# -LocalPackage and -ExpectedSha256 for the same two reasons.
#
# --sha256 is required with it. An installer that will unpack a local file
# without checking it is a different program from this one: the hash is not a
# formality it can be talked out of, it is the whole reason there is a check.
LOCAL_PACKAGE=""; EXPECT_SHA=""; TARGET_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    --package) LOCAL_PACKAGE="$2"; shift 2 ;;
    --sha256) EXPECT_SHA="$2"; shift 2 ;;
    --into) TARGET_OVERRIDE="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-start) SKIP_START=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    '') shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; GREY=$'\033[90m'; OFF=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; CYAN=""; GREY=""; OFF=""
fi
step() { printf '  %s%s%s\n' "$CYAN" "$1" "$OFF"; }
good() { printf '  %s+ %s%s\n' "$GREEN" "$1" "$OFF"; }
note() { printf '  %s%s%s\n' "$GREY" "$1" "$OFF"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$OFF"; }
stop() {
  printf '\n  %s%s%s\n' "$RED" "$1" "$OFF"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | while IFS= read -r l; do printf '  %s%s%s\n' "$GREY" "$l" "$OFF"; done
  [ -n "${3:-}" ] && { printf '\n'; printf '%s\n' "$3" | while IFS= read -r l; do printf '  %s%s%s\n' "$YELLOW" "$l" "$OFF"; done; }
  printf '\n'; exit 1
}
ask() {
  [ "$ASSUME_YES" = "1" ] && return 0
  [ -t 0 ] || return 1
  local reply=""; printf '  %s%s [y/N] %s' "$YELLOW" "$1" "$OFF"; read -r reply || true
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# Anything mounted inside the work directory is detached before the directory
# is removed.
#
# The Docker Desktop path mounts a disk image in here. `rm -rf` on a mounted
# read-only volume does not remove it -- it walks the whole of Docker.app
# printing "Read-only file system" for every file inside, and leaves the volume
# mounted afterwards. On a hosted Mac that was several hundred lines of error
# about somebody else's application.
WORK=""
ai17z_cleanup() {
  [ -n "$WORK" ] || return 0
  if [ -d "$WORK/dockermount" ]; then
    hdiutil detach -quiet -force "$WORK/dockermount" 2>/dev/null || true
  fi
  rm -rf "$WORK" 2>/dev/null || true
}
trap ai17z_cleanup EXIT INT TERM

assert_allowed_url() {
  local host
  case "$1" in https://*) host="${1#https://}"; host="${host%%/*}" ;;
    *) stop "AI17Z only downloads over HTTPS." "$1" "" ;; esac
  case " $ALLOWED_HOSTS " in *" $host "*) ;;
    *) stop "AI17Z will not download from ${host}." "It only downloads from its own GitHub release." "" ;; esac
}
fetch() { assert_allowed_url "$2"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$1" "$2"; }
# The same, with a progress bar. Docker Desktop is several hundred megabytes
# and a silent terminal for four minutes reads as a hang.
fetch_watched() { assert_allowed_url "$2"; curl -fL --proto '=https' --tlsv1.2 --retry 3 --progress-bar -o "$1" "$2"; }
fetch_stdout() { assert_allowed_url "$1"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$1"; }

printf '\n  %sAI17Z%s\n\n' "$GREEN" "$OFF"

# ---------------------------------------------------------------------------
# 1. Is this a Mac AI17Z runs on?
# ---------------------------------------------------------------------------
step "Checking this Mac"

[ "$(uname -s)" = "Darwin" ] || stop "This is not a Mac." \
  "uname says $(uname -s)." "On Ubuntu use install-ai17z-ubuntu.sh; on Windows see the README."

[ "$(id -u)" != "0" ] || stop "Run this as yourself, not with sudo." \
  "AI17Z installs into your own Library and needs no administrator rights.
A root install makes files you cannot then read or delete." \
  "bash $0"

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 0)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
if [ "${MACOS_MAJOR:-0}" -lt "$MIN_MACOS_MAJOR" ] 2>/dev/null; then
  stop "AI17Z needs macOS ${MIN_MACOS_MAJOR} or newer." \
    "This is macOS ${MACOS_VERSION}. Google Chrome, which AI17Z drives, requires
macOS ${MIN_MACOS_MAJOR}, and Docker Desktop supports only recent releases." \
    "Update macOS, or install from source:
  https://github.com/${REPOSITORY}#from-source"
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) stop "AI17Z has no package for this architecture." "uname says $(uname -m)." "" ;;
esac
good "macOS ${MACOS_VERSION} ($([ "$ARCH" = arm64 ] && echo "Apple Silicon" || echo "Intel"))"

# ---------------------------------------------------------------------------
# 2. Which release
# ---------------------------------------------------------------------------
step "Finding the newest AI17Z release"
WORK="$(mktemp -d)"; chmod 700 "$WORK"

if [ -n "$LOCAL_PACKAGE" ]; then
  [ -n "$EXPECT_SHA" ] || stop "--package needs --sha256." \
    "AI17Z will not unpack a file it cannot check, wherever the file came from." \
    "Pass the hash you expect:
  bash $0 --package <file> --sha256 <hex>"
  [ -f "$LOCAL_PACKAGE" ] || stop "There is no file at ${LOCAL_PACKAGE}." "" ""
  TAR_NAME="$(basename "$LOCAL_PACKAGE")"
  case "$TAR_NAME" in
    AI17Z-macos-"${ARCH}"-*.tar.gz) ;;
    AI17Z-macos-*) stop "That package is not for this Mac." \
      "It is named ${TAR_NAME}, and this Mac is ${ARCH}." "" ;;
    *) stop "That does not look like an AI17Z macOS package." "${TAR_NAME}" "" ;;
  esac
  VERSION="${TAR_NAME#AI17Z-macos-"${ARCH}"-}"; VERSION="${VERSION%.tar.gz}"
  TAG="v${VERSION}"
  cp "$LOCAL_PACKAGE" "$WORK/$TAR_NAME"
  EXPECTED="$EXPECT_SHA"
  note "Installing from a file rather than from a release: ${LOCAL_PACKAGE}"
  good "AI17Z ${VERSION}"
elif [ -n "$RELEASE" ]; then
  case "$RELEASE" in v[0-9]*|[0-9]*) ;; *) stop "\"$RELEASE\" is not a release version." "" "" ;; esac
  RELEASE_JSON="$(fetch_stdout "${API}/tags/${RELEASE}")" || stop "Release ${RELEASE} could not be read." "" ""
else
  # The advice names no cause, because this cannot know one: `curl -f` collapses
  # every 4xx into one exit code, and the status cannot come back out of the
  # subshell this runs in. It used to say the connection was at fault, which is
  # the single explanation that is definitely wrong when GitHub is rate limiting.
  RELEASE_JSON="$(fetch_stdout "${API}?per_page=10")" || stop "AI17Z could not be reached." \
    "Nothing on this Mac was changed." "GitHub did not answer. That can be this connection, or GitHub refusing requests from this address -- it allows sixty an hour to anybody who is not signed in, which a shared network reaches on its own.
Wait a few minutes and run this again."
fi

if [ -z "$LOCAL_PACKAGE" ]; then
TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TAG" ] || stop "That release does not exist." "" ""
VERSION="${TAG#v}"

TAR_NAME="AI17Z-macos-${ARCH}-${VERSION}.tar.gz"
TAR_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "https://[^\"]*/${TAR_NAME}" | head -1)"
SUMS_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^"]*/SHA256SUMS\.txt' | head -1)"
[ -n "$TAR_URL" ] || stop "Release ${TAG} does not contain ${TAR_NAME}." \
  "Nothing on this Mac was changed." \
  "AI17Z published Mac packages from the first release that had them.
Install a newer one, or see https://github.com/${REPOSITORY}/releases"
[ -n "$SUMS_URL" ] || stop "Release ${TAG} publishes no SHA256SUMS.txt." \
  "AI17Z will not unpack something it cannot check." ""
good "AI17Z ${VERSION}"

# ---------------------------------------------------------------------------
# 3. Download and check before anything is unpacked
# ---------------------------------------------------------------------------
step "Downloading and checking"
if [ -z "$LOCAL_PACKAGE" ]; then
  # Named, because this is the one moment the choice between Apple Silicon and
  # Intel is visible, and somebody reading the output should be able to see
  # which one was made rather than infer it afterwards.
  note "$TAR_NAME"
  fetch "$WORK/$TAR_NAME" "$TAR_URL"
  fetch "$WORK/SHA256SUMS.txt" "$SUMS_URL"
fi

EXPECTED="$(grep -E "[[:space:]]\*?${TAR_NAME}\$" "$WORK/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
[ -n "$EXPECTED" ] || stop "Release ${TAG} publishes no hash for ${TAR_NAME}." "" ""
fi

# One check, whichever route the bytes arrived by. A local file is not trusted
# more than a downloaded one -- it is only a file whose hash the caller already
# knew.
ACTUAL="$(shasum -a 256 "$WORK/$TAR_NAME" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  rm -f "$WORK/$TAR_NAME"
  stop "The package does not match its published SHA-256." \
    "expected  ${EXPECTED}
got       ${ACTUAL}

The file has been deleted and nothing was unpacked." \
    "If this happens twice, stop and report it at https://github.com/${REPOSITORY}/issues"
fi
if [ -n "$LOCAL_PACKAGE" ]; then
  good "SHA-256 matches what was asked for"
else
  good "SHA-256 matches what ${TAG} published"
fi

# ---------------------------------------------------------------------------
# 4. Docker Desktop, which AI17Z needs and does not own
# ---------------------------------------------------------------------------
step "Checking Docker Desktop"
docker_ready() { docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

if docker_ready; then
  good "Docker is installed and answering"
elif [ -d "/Applications/Docker.app" ]; then
  note "Docker Desktop is installed but its engine is not answering."
  if ask "Start Docker Desktop now?"; then
    open -a Docker 2>/dev/null || true
    note "Waiting for Docker's virtual machine (up to three minutes)..."
    deadline=$(( $(date +%s) + 180 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do docker_ready && break; sleep 3; done
  fi
  docker_ready && good "Docker is answering" || stop \
    "Docker Desktop is installed but its engine did not answer." \
    "If Docker is asking you to accept its terms or finish first-run setup, do
that first. AI17Z will never accept a vendor's agreement on your behalf." \
    "Open Docker, complete whatever it asks, then run this installer again."
else
  note "Docker Desktop is not installed. AI17Z needs it for the database."
  note "It comes from Docker, not from AI17Z. Docker's own installer puts it in"
  note "your Applications folder, and Docker asks you to accept its terms the"
  note "first time it runs. AI17Z never answers that for anybody."
  if ask "Download Docker Desktop for $([ "$ARCH" = arm64 ] && echo "Apple Silicon" || echo "Intel") from Docker?"; then
    DOCKER_DMG="$WORK/Docker.dmg"
    DOCKER_URL="https://desktop.docker.com/mac/main/$([ "$ARCH" = arm64 ] && echo arm64 || echo amd64)/Docker.dmg"
    note "Downloading from desktop.docker.com. This is a large file."
    fetch_watched "$DOCKER_DMG" "$DOCKER_URL" || stop \
      "Docker Desktop could not be downloaded." \
      "Nothing on this Mac was changed by AI17Z." \
      "Install it yourself from https://www.docker.com/products/docker-desktop/
then run this installer again."

    MOUNT="$WORK/dockermount"
    mkdir -p "$MOUNT"
    hdiutil attach -quiet -nobrowse -mountpoint "$MOUNT" "$DOCKER_DMG" || stop \
      "Docker's disk image could not be opened." \
      "Nothing on this Mac was changed by AI17Z." \
      "Install Docker Desktop yourself from https://www.docker.com/products/docker-desktop/
then run this installer again."

    # A .dmg is a disk image, not an installer.
    #
    # This used to `open` Docker.app from inside the mounted image and tell
    # somebody to follow an installer that does not exist. That launches Docker
    # from a read-only volume which is then ejected out from under it, so
    # nothing ever reaches /Applications and the engine never comes up --
    # reported from a real Mac, where it looked like Docker had simply failed.
    #
    # What installs it is Docker's own command-line installer, inside the image,
    # documented by Docker:
    #
    #   sudo /Volumes/Docker/Docker.app/Contents/MacOS/install
    #
    # It needs administrator rights because it puts an application in
    # /Applications and registers a privileged helper, and sudo asks for the
    # password rather than this script. It does **not** accept Docker's licence:
    # Docker asks that on first launch, and `--accept-license`, which that
    # binary does support, appears nowhere here and must never be added.
    DOCKER_INSTALL="$MOUNT/Docker.app/Contents/MacOS/install"
    if [ -x "$DOCKER_INSTALL" ] && [ -t 0 ] \
       && ask "Let Docker's own installer put it in Applications? It needs your administrator password."; then
      note "Running Docker's installer. sudo will ask for your password."
      sudo "$DOCKER_INSTALL" || warn "Docker's installer did not finish. You can still do it by hand."
    fi

    if [ ! -d "/Applications/Docker.app" ]; then
      # By hand, which is what a disk image is for. The window that opens holds
      # Docker.app and a shortcut to Applications beside it; dragging one onto
      # the other is the whole of it.
      note ""
      note "Opening Docker's disk image in Finder."
      note "Drag Docker.app onto the Applications folder in that window."
      open "$MOUNT" 2>/dev/null || true
      if [ -t 0 ]; then
        # Waited for by looking, not by asking for a keypress. A keypress proves
        # somebody pressed a key; this proves the application is there.
        note "Waiting for Docker.app to appear in Applications (up to six minutes)..."
        waited=0
        while [ ! -d "/Applications/Docker.app" ] && [ "$waited" -lt 180 ]; do
          sleep 2
          waited=$((waited + 1))
          [ $((waited % 15)) -eq 0 ] && note "  still waiting..."
        done
      else
        hdiutil detach -quiet -force "$MOUNT" 2>/dev/null || true
        stop "Docker Desktop needs somebody to put it in Applications." \
          "Its disk image was downloaded, and this is not running where anyone can drag it.
Nothing on this Mac was changed by AI17Z." \
          "Install Docker Desktop yourself, then run this installer again."
      fi
    fi

    if [ ! -d "/Applications/Docker.app" ]; then
      hdiutil detach -quiet -force "$MOUNT" 2>/dev/null || true
      stop "Docker Desktop is not in your Applications folder." \
        "Nothing on this Mac was changed by AI17Z." \
        "Drag Docker.app from Docker's disk image into Applications, or install it from
https://www.docker.com/products/docker-desktop/ -- then run this installer again."
    fi
    good "Docker Desktop is in Applications"

    # Only now. Ejecting while the copy was still being made is how the last
    # version of this left nothing behind.
    hdiutil detach -quiet -force "$MOUNT" 2>/dev/null || true

    note "Starting Docker Desktop. Accept Docker's terms if it asks you to."
    open -a Docker 2>/dev/null || true
    note "Waiting for Docker's virtual machine (up to three minutes)..."
    waited=0
    while ! docker_ready && [ "$waited" -lt 90 ]; do
      sleep 2
      waited=$((waited + 1))
    done
    docker_ready || stop "Docker Desktop is installed but its engine is not answering." \
      "If Docker is asking you to accept its terms or finish first-run setup, do
that first -- AI17Z cannot and will not answer it for you.
AI17Z was not installed. Nothing on this Mac was changed by AI17Z." \
      "Finish Docker's setup, then run this installer again."
    good "Docker is answering"
  else
    stop "AI17Z needs Docker Desktop." "Nothing was installed." \
      "Install it from https://www.docker.com/products/docker-desktop/
then run this installer again."
  fi
fi

# ---------------------------------------------------------------------------
# 5. Install, into the owner's own Library
# ---------------------------------------------------------------------------
# Somewhere else entirely, for a test that must not write into the person's own
# Library. Never used by the documented route.
if [ -n "$TARGET_OVERRIDE" ]; then
  TARGET="$TARGET_OVERRIDE"
else
  TARGET="$HOME/Library/Application Support/AI17Z/${INSTANCE}"
fi
# Said to the person running it, not only in a comment and a document.
#
# AI17Z has no Apple Developer ID, so its Mac packages are not signed and not
# notarized. Nothing here disables Gatekeeper, strips a quarantine attribute, or
# argues with either -- and somebody installing software that is unsigned should
# hear it from the installer rather than find out later. docs/MACOS_TRUST.md is
# the long version.
note "This package is not signed with an Apple Developer ID and is not notarized."
note "AI17Z does not disable Gatekeeper or strip quarantine attributes to work"
note "around that. What it means is written out in docs/MACOS_TRUST.md."

step "Installing to ${TARGET}"

if [ -d "$TARGET/app" ]; then
  note "An AI17Z is already installed there."
  ask "Replace the application? Your agents, keys and browser session are kept." \
    || stop "Nothing was changed." "" "To install a second, separate AI17Z:
  bash $0 --instance AI17Z-second"
  # Only the replaceable halves. Everything the owner made is beside them.
  rm -rf "$TARGET/app" "$TARGET/runtime"
fi

mkdir -p "$TARGET"
tar -xzf "$WORK/$TAR_NAME" -C "$WORK"
# The tarball holds one directory; its contents become the installation.
cp -R "$WORK/AI17Z/." "$TARGET/"
chmod 0755 "$TARGET/ai17z"
good "AI17Z ${VERSION} installed"

# A launcher on PATH if there is somewhere sensible to put one, and a clear
# instruction if not. Never /usr/local/bin without asking: that needs sudo.
LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR"
ln -sf "$TARGET/ai17z" "$LINK_DIR/ai17z"
case ":$PATH:" in
  *":$LINK_DIR:"*) good "ai17z is on your PATH" ;;
  *) note "Add this to your shell profile to get the 'ai17z' command:"
     note "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# ---------------------------------------------------------------------------
# 6. Chrome, optional
# ---------------------------------------------------------------------------
step "Checking Google Chrome"
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] \
   || [ -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  good "Google Chrome is installed"
else
  note "Google Chrome is not installed."
  note "AI17Z drives real Chrome for X and other browser-backed channels."
  note "Everything else works without it."
  note "Get it from https://www.google.com/chrome/ when you want those."
fi

# ---------------------------------------------------------------------------
# 7. Start
# ---------------------------------------------------------------------------
if [ "$SKIP_START" = "1" ]; then
  printf '\n  %sAI17Z %s is installed.%s\n\n' "$GREEN" "$VERSION" "$OFF"
  note "Start it with:  ${TARGET}/ai17z start"
  printf '\n'; exit 0
fi

step "Starting AI17Z"
note "The first start builds AI17Z's containers. That takes a few minutes."
if "$TARGET/ai17z" start; then
  printf '\n  %sAI17Z is ready.%s\n\n' "$GREEN" "$OFF"
  note "ai17z doctor     what is installed, running and healthy"
  note "ai17z stop       stop it"
  note "ai17z update     check for a newer AI17Z"
  printf '\n'
else
  stop "AI17Z installed, but did not start cleanly." \
    "Everything is installed and your data is safe." \
    "Find out what is wrong:
  ${TARGET}/ai17z doctor"
fi
