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
ALLOWED_HOSTS="api.github.com github.com objects.githubusercontent.com release-assets.githubusercontent.com"
# Chrome's own floor, which is a Google decision rather than an AI17Z one.
# Docker Desktop separately supports the current and two previous macOS
# releases; on an older one it may refuse to install and will say so itself.
MIN_MACOS_MAJOR=13

RELEASE=""; ASSUME_YES=0; SKIP_START=0; INSTANCE="AI17Z"
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --instance) INSTANCE="$2"; shift 2 ;;
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

WORK=""; trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT INT TERM

assert_allowed_url() {
  local host
  case "$1" in https://*) host="${1#https://}"; host="${host%%/*}" ;;
    *) stop "AI17Z only downloads over HTTPS." "$1" "" ;; esac
  case " $ALLOWED_HOSTS " in *" $host "*) ;;
    *) stop "AI17Z will not download from ${host}." "It only downloads from its own GitHub release." "" ;; esac
}
fetch() { assert_allowed_url "$2"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$1" "$2"; }
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

if [ -n "$RELEASE" ]; then
  case "$RELEASE" in v[0-9]*|[0-9]*) ;; *) stop "\"$RELEASE\" is not a release version." "" "" ;; esac
  RELEASE_JSON="$(fetch_stdout "${API}/tags/${RELEASE}")" || stop "Release ${RELEASE} could not be read." "" ""
else
  RELEASE_JSON="$(fetch_stdout "${API}?per_page=10")" || stop "AI17Z could not be reached." \
    "Nothing on this Mac was changed." "Check your internet connection and try again."
fi
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
fetch "$WORK/$TAR_NAME" "$TAR_URL"
fetch "$WORK/SHA256SUMS.txt" "$SUMS_URL"

EXPECTED="$(grep -E "[[:space:]]\*?${TAR_NAME}\$" "$WORK/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
[ -n "$EXPECTED" ] || stop "Release ${TAG} publishes no hash for ${TAR_NAME}." "" ""
ACTUAL="$(shasum -a 256 "$WORK/$TAR_NAME" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  rm -f "$WORK/$TAR_NAME"
  stop "The package does not match its published SHA-256." \
    "expected  ${EXPECTED}
got       ${ACTUAL}

The file has been deleted and nothing was unpacked." \
    "If this happens twice, stop and report it at https://github.com/${REPOSITORY}/issues"
fi
good "SHA-256 matches what ${TAG} published"

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
  note "It comes from Docker, not from AI17Z, and installing it needs your"
  note "administrator password -- Docker's installer asks, not this script."
  if ask "Download Docker Desktop for $([ "$ARCH" = arm64 ] && echo "Apple Silicon" || echo "Intel") and open it?"; then
    DOCKER_DMG="$WORK/Docker.dmg"
    DOCKER_URL="https://desktop.docker.com/mac/main/$([ "$ARCH" = arm64 ] && echo arm64 || echo amd64)/Docker.dmg"
    note "Downloading from desktop.docker.com"
    if curl -fsSL --proto '=https' --tlsv1.2 -o "$DOCKER_DMG" "$DOCKER_URL"; then
      MOUNT="$WORK/dockermount"
      mkdir -p "$MOUNT"
      hdiutil attach -quiet -nobrowse -mountpoint "$MOUNT" "$DOCKER_DMG"
      note "Docker Desktop's installer is open. Follow it, including Docker's own"
      note "terms, then come back here."
      open "$MOUNT/Docker.app" 2>/dev/null || true
      printf '  %sPress return once Docker Desktop is installed and running. %s' "$YELLOW" "$OFF"
      read -r _ || true
      hdiutil detach -quiet "$MOUNT" 2>/dev/null || true
      docker_ready || stop "Docker still is not answering." \
        "AI17Z was not installed. Nothing on this Mac was changed by AI17Z." \
        "Finish Docker's setup, then run this installer again."
      good "Docker is answering"
    else
      stop "Docker Desktop could not be downloaded." "" \
        "Install it yourself from https://www.docker.com/products/docker-desktop/
then run this installer again."
    fi
  else
    stop "AI17Z needs Docker Desktop." "Nothing was installed." \
      "Install it from https://www.docker.com/products/docker-desktop/
then run this installer again."
  fi
fi

# ---------------------------------------------------------------------------
# 5. Install, into the owner's own Library
# ---------------------------------------------------------------------------
TARGET="$HOME/Library/Application Support/AI17Z/${INSTANCE}"
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
