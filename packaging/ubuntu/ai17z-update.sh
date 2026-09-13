#!/usr/bin/env bash
#
# Updates this AI17Z installation, and no other.
#
# The same shape as every other platform's updater, because they are one design
# with different hands: find the release, check the machine can run it *before*
# stopping anything, verify the package, stop this installation, install,
# restart, and prove the version that came up is the one that was asked for.
#
# Nothing here uses Git. Nothing here needs a global Node. Your data is in your
# home directory and is never part of what gets replaced.

set -euo pipefail

APP_ROOT="${AI17Z_APP_ROOT:-/usr/lib/ai17z/app}"
# shellcheck source=../unix/ai17z-paths.sh
. "$APP_ROOT/packaging/unix/ai17z-paths.sh"
ai17z_resolve_paths "$APP_ROOT"

REPOSITORY="ShiftAboveCtrl/ai17z"
API="https://api.github.com/repos/${REPOSITORY}/releases"
ALLOWED_HOSTS="api.github.com github.com objects.githubusercontent.com release-assets.githubusercontent.com"

CHECK_ONLY=0; ASSUME_YES=0; WANT_RELEASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --release) WANT_RELEASE="$2"; shift 2 ;;
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
oops() {
  printf '\n  %s%s%s\n' "$RED" "$1" "$OFF"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | while IFS= read -r l; do printf '  %s%s%s\n' "$GREY" "$l" "$OFF"; done
  [ -n "${3:-}" ] && { printf '\n'; printf '%s\n' "$3" | while IFS= read -r l; do printf '  %s%s%s\n' "$YELLOW" "$l" "$OFF"; done; }
  printf '\n'; exit 1
}

[ "$(id -u)" != "0" ] || oops "Run this as yourself, not with sudo." \
  "It asks for sudo only where the package manager genuinely needs it." "ai17z update"

WORK=""; trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT INT TERM

assert_allowed_url() {
  local host
  case "$1" in https://*) host="${1#https://}"; host="${host%%/*}" ;;
    *) oops "AI17Z only downloads over HTTPS." "$1" "" ;; esac
  case " $ALLOWED_HOSTS " in *" $host "*) ;;
    *) oops "AI17Z will not download from ${host}." "" "" ;; esac
}
fetch() { assert_allowed_url "$2"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$1" "$2"; }
fetch_stdout() { assert_allowed_url "$1"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$1"; }

CURRENT="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_ROOT/BUILD_INFO.json" 2>/dev/null | head -1)"
[ -n "$CURRENT" ] || oops "Cannot tell which version is installed." "$APP_ROOT/BUILD_INFO.json is missing or unreadable." ""
ARCH="$(dpkg --print-architecture)"

printf '\n  %sAI17Z%s  %s\n\n' "$GREEN" "$OFF" "$CURRENT"

# ---------------------------------------------------------------------------
# 1. Which release
# ---------------------------------------------------------------------------
step "Checking for a newer AI17Z"
if [ -n "$WANT_RELEASE" ]; then
  RELEASE_JSON="$(fetch_stdout "${API}/tags/${WANT_RELEASE}")" || oops "Release ${WANT_RELEASE} could not be read." "" ""
else
  RELEASE_JSON="$(fetch_stdout "${API}?per_page=10")" || oops "AI17Z could not be reached." \
    "Nothing was changed." "Check your internet connection and try again."
fi
TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TAG" ] || oops "No release was found." "" ""
VERSION="${TAG#v}"

if [ "$VERSION" = "$CURRENT" ]; then
  good "AI17Z ${CURRENT} is the newest release"
  printf '\n'; exit 0
fi
if ! dpkg --compare-versions "$VERSION" gt "$CURRENT"; then
  oops "The newest release (${VERSION}) is not newer than what is installed (${CURRENT})." \
    "Nothing was changed. AI17Z does not install an older version over a newer one:
the database has already been migrated forward and an older application
cannot read it." ""
fi
good "AI17Z ${VERSION} is available"

# ---------------------------------------------------------------------------
# 2. Can this machine run it? Asked before anything stops.
#
# The whole point of doing this first: "no" has to be survivable. An update that
# discovers the problem after replacing the application has already taken the
# working version away from somebody.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# What it means when the check could not answer
#
# Two completely different situations produce the same silence. An installation
# made before the gate existed, offered a release published before manifests
# existed, has nothing to ask and nothing to ask it with -- and refusing there
# would strand exactly the installations this exists to move forward. An
# installation new enough to ship the gate, whose gate did not answer, is a copy
# with something wrong with it, and the next thing this script does is stop it
# and replace it.
#
# The schema this installation recorded about itself is what separates them, and
# the decision lives in @xbam/shared so that three updaters cannot drift about
# it. Where even the bridge cannot run, the fallback is the cautious half: an
# installation that records the gate's schema and cannot run the gate is exactly
# the case that must not proceed.
# ---------------------------------------------------------------------------
installed_schema() {
  info="$APP_ROOT/INSTALL_INFO.json"
  [ -f "$info" ] || { printf ''; return; }
  sed -n 's/.*"schema"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$info" | head -1
}

gate_said_nothing() { # why
  schema="$(installed_schema)"
  decision=""
  if [ -f "$APP_ROOT/node_modules/tsx/dist/cli.mjs" ] && [ -f "$APP_ROOT/packaging/preflight.mts" ]; then
    decision="$(cd "$APP_ROOT" && "$(ai17z_node)" "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
      "$APP_ROOT/packaging/preflight.mts" --decide "$schema" "$1" 2>/dev/null || printf '')"
  fi
  if [ -z "$decision" ]; then
    # The bridge itself could not run. An installation that predates it says so
    # by having no schema at all; anything else is a fault, and a fault here
    # stops the update rather than finding out afterwards.
    if [ -z "$schema" ] || [ "$schema" -lt 3 ] 2>/dev/null; then
      note "This installation predates the compatibility check; continuing."
      return 0
    fi
    oops "AI17Z could not check whether ${VERSION} can run on this machine." \
      "The check is part of how this installation updates, and it did not run." \
      "Nothing was changed. AI17Z ${CURRENT} is still installed and still running."
  fi
  case "$decision" in
    GO*) printf '%s' "$decision" | tail -n +2 | while IFS= read -r l; do [ -n "$l" ] && note "$l"; done ;;
    *)   oops "AI17Z could not check whether ${VERSION} can run on this machine." \
           "$(printf '%s' "$decision" | tail -n +2)" \
           "Nothing was changed. AI17Z ${CURRENT} is still installed and still running." ;;
  esac
}

step "Checking compatibility"
MANIFEST_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^"]*/release-manifest\.json' | head -1)"
if [ -n "$MANIFEST_URL" ]; then
  WORK="$(mktemp -d)"; chmod 700 "$WORK"
  if fetch "$WORK/manifest.json" "$MANIFEST_URL"; then
    NODE_BIN="$(ai17z_node)"
    DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '')"
    CHROME_MAJOR="$(google-chrome --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo '')"
    UBUNTU_VERSION="$(. /etc/os-release && echo "${VERSION_ID:-}")"
    # Through the bundled tsx, against the shared decision in @xbam/shared, so
    # three platforms cannot drift apart about what "compatible" means.
    VERDICT="$(cd "$APP_ROOT" && "$NODE_BIN" "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
      "$APP_ROOT/packaging/preflight.mts" \
      "$WORK/manifest.json" ubuntu "$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)" \
      "$UBUNTU_VERSION" "$DOCKER_VERSION" "$CHROME_MAJOR" 2>/dev/null || echo SKIP)"
    case "$VERDICT" in
      NO*) oops "AI17Z ${VERSION} cannot run on this machine." \
             "$(printf '%s' "$VERDICT" | tail -n +2)" \
             "Nothing was changed. AI17Z ${CURRENT} is still installed and still running." ;;
      OK*) good "This machine meets what ${VERSION} needs"
           printf '%s' "$VERDICT" | tail -n +2 | while IFS= read -r l; do [ -n "$l" ] && note "$l"; done ;;
      *)   gate_said_nothing unreadable ;;
    esac
  else
    gate_said_nothing no-manifest
  fi
else
  gate_said_nothing no-manifest
fi

if [ "$CHECK_ONLY" = "1" ]; then
  printf '\n  %sAI17Z %s is available.%s\n' "$GREEN" "$VERSION" "$OFF"
  note "Install it with:  ai17z update"
  printf '\n'; exit 0
fi

if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  printf '  %sUpdate AI17Z %s to %s? [y/N] %s' "$YELLOW" "$CURRENT" "$VERSION" "$OFF"
  read -r reply || true
  case "$reply" in [Yy]*) ;; *) note "Nothing was changed."; printf '\n'; exit 0 ;; esac
fi

# ---------------------------------------------------------------------------
# 3. Download and verify, still before anything stops
# ---------------------------------------------------------------------------
step "Downloading AI17Z ${VERSION}"
[ -n "$WORK" ] || { WORK="$(mktemp -d)"; chmod 700 "$WORK"; }
DEB_NAME="ai17z_${VERSION}_${ARCH}.deb"
DEB_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "https://[^\"]*/${DEB_NAME}" | head -1)"
SUMS_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^"]*/SHA256SUMS\.txt' | head -1)"
[ -n "$DEB_URL" ] || oops "Release ${TAG} has no package for ${ARCH}." \
  "Nothing was changed. AI17Z ${CURRENT} is still installed." ""
[ -n "$SUMS_URL" ] || oops "Release ${TAG} publishes no SHA256SUMS.txt." \
  "AI17Z will not install a package it cannot check. Nothing was changed." ""

fetch "$WORK/$DEB_NAME" "$DEB_URL"
fetch "$WORK/SHA256SUMS.txt" "$SUMS_URL"

step "Verifying"
EXPECTED="$(grep -E "[[:space:]]\*?${DEB_NAME}\$" "$WORK/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
[ -n "$EXPECTED" ] || oops "Release ${TAG} publishes no hash for ${DEB_NAME}." "Nothing was changed." ""
ACTUAL="$(sha256sum "$WORK/$DEB_NAME" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  rm -f "$WORK/$DEB_NAME"
  oops "The package does not match its published SHA-256." \
    "expected  ${EXPECTED}
got       ${ACTUAL}

The file has been deleted. Nothing was changed and AI17Z ${CURRENT} is
still installed." \
    "If this happens twice, stop and report it at https://github.com/${REPOSITORY}/issues"
fi
good "SHA-256 matches what ${TAG} published"

# ---------------------------------------------------------------------------
# 4. The destructive boundary. Everything above could fail safely; from here
#    the installation is being changed.
# ---------------------------------------------------------------------------
step "Stopping AI17Z"
bash "$APP_ROOT/packaging/ubuntu/ai17z-lifecycle.sh" stop >/dev/null 2>&1 || true
good "Stopped"

step "Installing AI17Z ${VERSION}"
sudo apt-get install -y "$WORK/$DEB_NAME" 2>&1 | tee "$WORK/apt.log" >/dev/null || {
  tail -20 "$WORK/apt.log" >&2
  oops "The package would not install." \
    "AI17Z ${CURRENT} may still be installed; apt does not remove the old
package until the new one is unpacked." \
    "Look at what apt said above, then:  ai17z doctor"
}
good "Installed"

# ---------------------------------------------------------------------------
# 5. Prove the thing that came up is the thing that was asked for
# ---------------------------------------------------------------------------
step "Starting AI17Z"
if ! bash "$APP_ROOT/packaging/ubuntu/ai17z-lifecycle.sh" start; then
  oops "AI17Z ${VERSION} installed but did not start cleanly." \
    "Your data is untouched." "ai17z doctor"
fi

RUNNING="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_ROOT/BUILD_INFO.json" 2>/dev/null | head -1)"
if [ "$RUNNING" != "$VERSION" ]; then
  oops "AI17Z reports ${RUNNING} after installing ${VERSION}." \
    "The package installed but the application on disk is not the one expected." \
    "ai17z doctor"
fi

printf '\n  %sAI17Z %s -> %s%s\n' "$GREEN" "$CURRENT" "$VERSION" "$OFF"
note "Your agents, keys and browser session were not touched."
printf '\n'
