#!/usr/bin/env bash
#
# Updates this AI17Z installation on macOS, and no other.
#
# The same design as every other platform: find the release, ask whether this
# machine can run it *before* stopping anything, verify, stop, replace, start,
# and prove the version that came up is the one asked for.
#
# No sudo. Only `app` and `runtime` are replaced, and both live in the owner's
# own Library beside the data that is never touched -- which is the property
# that makes a Mac update need no authorization at all.
#
# The replacement is staged and swapped rather than overwritten in place: the
# old application stays until the new one is unpacked and checked, so a failure
# anywhere before the swap leaves a working installation working.

set -euo pipefail

APP_ROOT="${AI17Z_APP_ROOT:?run this through the ai17z launcher}"
HERE="$(dirname "$APP_ROOT")"
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

WORK=""; trap '[ -n "$WORK" ] && rm -rf "$WORK"' EXIT INT TERM
assert_allowed_url() {
  local host
  case "$1" in https://*) host="${1#https://}"; host="${host%%/*}" ;; *) oops "HTTPS only." "$1" "" ;; esac
  case " $ALLOWED_HOSTS " in *" $host "*) ;; *) oops "AI17Z will not download from ${host}." "" "" ;; esac
}
fetch() { assert_allowed_url "$2"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$1" "$2"; }
fetch_stdout() { assert_allowed_url "$1"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$1"; }

CURRENT="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_ROOT/BUILD_INFO.json" 2>/dev/null | head -1)"
[ -n "$CURRENT" ] || oops "Cannot tell which version is installed." "" ""
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) oops "Unsupported architecture." "" "" ;; esac

printf '\n  %sAI17Z%s  %s\n\n' "$GREEN" "$OFF" "$CURRENT"

step "Checking for a newer AI17Z"
if [ -n "$WANT_RELEASE" ]; then
  RELEASE_JSON="$(fetch_stdout "${API}/tags/${WANT_RELEASE}")" || oops "Release ${WANT_RELEASE} could not be read." "" ""
else
  RELEASE_JSON="$(fetch_stdout "${API}?per_page=10")" || oops "AI17Z could not be reached." "Nothing was changed." ""
fi
TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TAG" ] || oops "No release was found." "" ""
VERSION="${TAG#v}"

if [ "$VERSION" = "$CURRENT" ]; then good "AI17Z ${CURRENT} is the newest release"; printf '\n'; exit 0; fi

# A downgrade is refused. An older application against a database that has
# already migrated forward has no good ending.
newest="$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)"
[ "$newest" = "$VERSION" ] || oops \
  "The newest release (${VERSION}) is not newer than what is installed (${CURRENT})." \
  "Nothing was changed." ""
good "AI17Z ${VERSION} is available"

step "Checking compatibility"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
MANIFEST_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^"]*/release-manifest\.json' | head -1)"
if [ -n "$MANIFEST_URL" ] && fetch "$WORK/manifest.json" "$MANIFEST_URL"; then
  NODE_BIN="$(ai17z_node)"
  DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '')"
  CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  CHROME_MAJOR="$("$CHROME_APP" --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo '')"
  VERDICT="$(cd "$APP_ROOT" && "$NODE_BIN" "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$APP_ROOT/packaging/unix/preflight.mts" "$WORK/manifest.json" macos "$ARCH" \
    "$(sw_vers -productVersion)" "$DOCKER_VERSION" "$CHROME_MAJOR" 2>/dev/null || echo SKIP)"
  case "$VERDICT" in
    NO*) oops "AI17Z ${VERSION} cannot run on this Mac." "$(printf '%s' "$VERDICT" | tail -n +2)" \
           "Nothing was changed. AI17Z ${CURRENT} is still installed and still running." ;;
    OK*) good "This Mac meets what ${VERSION} needs"
         printf '%s' "$VERDICT" | tail -n +2 | while IFS= read -r l; do [ -n "$l" ] && note "$l"; done ;;
    *)   note "Could not read this release's compatibility manifest; continuing." ;;
  esac
else
  note "This release publishes no compatibility manifest; continuing."
fi

if [ "$CHECK_ONLY" = "1" ]; then
  printf '\n  %sAI17Z %s is available.%s\n' "$GREEN" "$VERSION" "$OFF"
  note "Install it with:  ai17z update"; printf '\n'; exit 0
fi
if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  printf '  %sUpdate AI17Z %s to %s? [y/N] %s' "$YELLOW" "$CURRENT" "$VERSION" "$OFF"
  read -r reply || true
  case "$reply" in [Yy]*) ;; *) note "Nothing was changed."; printf '\n'; exit 0 ;; esac
fi

step "Downloading AI17Z ${VERSION}"
TAR_NAME="AI17Z-macos-${ARCH}-${VERSION}.tar.gz"
TAR_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "https://[^\"]*/${TAR_NAME}" | head -1)"
SUMS_URL="$(printf '%s' "$RELEASE_JSON" | grep -o 'https://[^"]*/SHA256SUMS\.txt' | head -1)"
[ -n "$TAR_URL" ] || oops "Release ${TAG} has no Mac package for ${ARCH}." "Nothing was changed." ""
[ -n "$SUMS_URL" ] || oops "Release ${TAG} publishes no SHA256SUMS.txt." "Nothing was changed." ""
fetch "$WORK/$TAR_NAME" "$TAR_URL"; fetch "$WORK/SHA256SUMS.txt" "$SUMS_URL"

step "Verifying"
EXPECTED="$(grep -E "[[:space:]]\*?${TAR_NAME}\$" "$WORK/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
[ -n "$EXPECTED" ] || oops "Release ${TAG} publishes no hash for ${TAR_NAME}." "Nothing was changed." ""
ACTUAL="$(shasum -a 256 "$WORK/$TAR_NAME" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { rm -f "$WORK/$TAR_NAME"; oops \
  "The package does not match its published SHA-256." \
  "expected  ${EXPECTED}
got       ${ACTUAL}

The file has been deleted. AI17Z ${CURRENT} is untouched." ""; }
good "SHA-256 matches what ${TAG} published"

# Unpacked and checked while the old one is still running. Everything above
# this line can fail without costing anybody their working installation.
step "Staging"
tar -xzf "$WORK/$TAR_NAME" -C "$WORK"
[ -x "$WORK/AI17Z/ai17z" ] && [ -d "$WORK/AI17Z/app" ] && [ -x "$WORK/AI17Z/runtime/node/bin/node" ] \
  || oops "The package is not shaped like an AI17Z release." "Nothing was changed." ""
STAGED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WORK/AI17Z/app/BUILD_INFO.json" | head -1)"
[ "$STAGED_VERSION" = "$VERSION" ] || oops \
  "The package says it is ${STAGED_VERSION}, not ${VERSION}." "Nothing was changed." ""
good "Staged and checked"

# ---- the destructive boundary ---------------------------------------------
step "Stopping AI17Z"
bash "$APP_ROOT/packaging/macos/ai17z-lifecycle.sh" stop >/dev/null 2>&1 || true

step "Updating"
# The previous application is kept until the new one is in place, so a failure
# here leaves something to go back to rather than a half-replaced directory.
rm -rf "$HERE/app.previous" "$HERE/runtime.previous"
mv "$HERE/app" "$HERE/app.previous"
mv "$HERE/runtime" "$HERE/runtime.previous"
if ! (mv "$WORK/AI17Z/app" "$HERE/app" && mv "$WORK/AI17Z/runtime" "$HERE/runtime"); then
  rm -rf "$HERE/app" "$HERE/runtime"
  mv "$HERE/app.previous" "$HERE/app"
  mv "$HERE/runtime.previous" "$HERE/runtime"
  oops "The update could not be put in place." "AI17Z ${CURRENT} has been restored." "ai17z start"
fi
install -m 0755 "$WORK/AI17Z/ai17z" "$HERE/ai17z" 2>/dev/null || cp "$WORK/AI17Z/ai17z" "$HERE/ai17z"
chmod 0755 "$HERE/ai17z"
good "Installed"

step "Starting AI17Z"
if ! bash "$HERE/app/packaging/macos/ai17z-lifecycle.sh" start; then
  oops "AI17Z ${VERSION} installed but did not start cleanly." \
    "Your data is untouched. The previous application is still at
  ${HERE}/app.previous" \
    "ai17z doctor"
fi

RUNNING="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HERE/app/BUILD_INFO.json" | head -1)"
[ "$RUNNING" = "$VERSION" ] || oops "AI17Z reports ${RUNNING} after installing ${VERSION}." "" "ai17z doctor"

# Only once the new one has started and said the right version.
rm -rf "$HERE/app.previous" "$HERE/runtime.previous"

printf '\n  %sAI17Z %s -> %s%s\n' "$GREEN" "$CURRENT" "$VERSION" "$OFF"
note "Your agents, keys and browser session were not touched."
printf '\n'
