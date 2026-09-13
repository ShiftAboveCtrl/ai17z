#!/usr/bin/env bash
#
# Builds the AI17Z macOS package.
#
# A tarball, and that is a decision rather than a shortcut. AI17Z has no Apple
# Developer ID, so a `.app`, a `.pkg` or a `.dmg` downloaded from the internet
# meets Gatekeeper as an unidentified developer -- a dialog nobody should be
# talked past, and one this project has already decided not to ask for on
# Windows. A tar extracted by a script the owner read first does not become a
# quarantined bundle.
#
# Runs on macOS in CI, per architecture. Building arm64 on an Intel runner and
# relabelling it would ship native modules that cannot load, so this refuses to
# guess: the architecture is passed in and checked against what was produced.
#
#   build-tarball.sh --stage <dir> --version <x.y.z> --arch arm64|x64 --node vX.Y.Z --out <dir>

set -euo pipefail

STAGE=""; VERSION=""; ARCH=""; NODE_VERSION=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --node) NODE_VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    '') shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
for required in STAGE VERSION ARCH NODE_VERSION OUT; do
  eval "value=\${$required}"
  [ -n "$value" ] || { echo "missing --$(echo "$required" | tr '[:upper:]' '[:lower:]')" >&2; exit 2; }
done
case "$ARCH" in arm64|x64) ;; *) echo "unsupported architecture: $ARCH" >&2; exit 2 ;; esac

say() { printf '  %s\n' "$1"; }

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
PKG="$ROOT/AI17Z"

say "assembling AI17Z ${VERSION} (macos ${ARCH})"
mkdir -p "$PKG"

# ---------------------------------------------------------------------------
# The application
# ---------------------------------------------------------------------------
cp -R "$STAGE" "$PKG/app"

# Permissions from what each file is, never from what the build host said.
find "$PKG/app" -type d -exec chmod 0755 {} +
find "$PKG/app" -type f -exec chmod 0644 {} +
find "$PKG/app" -type f -name '*.sh' -exec chmod 0755 {} +
find "$PKG/app" -type f -perm -u+x -name '*.mjs' -exec chmod 0755 {} + 2>/dev/null || true

# ---------------------------------------------------------------------------
# The private Node runtime
#
# From nodejs.org, checked against Node's own SHASUMS256.txt before a byte is
# unpacked. A Mac user has no reason to own Node, and an AI17Z that depended on
# whatever `node` means today would break the day they changed it.
# ---------------------------------------------------------------------------
NODE_TAR="node-${NODE_VERSION}-darwin-${ARCH}.tar.gz"
say "fetching ${NODE_TAR}"
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$ROOT/$NODE_TAR" \
  "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$ROOT/SHASUMS256.txt" \
  "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"

EXPECTED="$(grep " ${NODE_TAR}\$" "$ROOT/SHASUMS256.txt" | awk '{print $1}')"
[ -n "$EXPECTED" ] || { echo "  nodejs.org publishes no checksum for ${NODE_TAR}" >&2; exit 1; }
ACTUAL="$(shasum -a 256 "$ROOT/$NODE_TAR" 2>/dev/null | awk '{print $1}' || sha256sum "$ROOT/$NODE_TAR" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "  the Node runtime does not match its published SHA-256" >&2
  echo "    expected $EXPECTED" >&2
  echo "    got      $ACTUAL" >&2
  exit 1
fi
say "node runtime verified (${ACTUAL:0:12})"

mkdir -p "$PKG/runtime"
tar -xzf "$ROOT/$NODE_TAR" -C "$ROOT"
mv "$ROOT/node-${NODE_VERSION}-darwin-${ARCH}" "$PKG/runtime/node"
rm -rf "$PKG/runtime/node/share/doc" "$PKG/runtime/node/share/man" "$PKG/runtime/node/include"
# Windows shims and the Python that node-gyp brings, neither of which a Mac
# installation ever runs.
find "$PKG/runtime/node" \( -name '*.ps1' -o -name '*.cmd' -o -name '*.bat' -o -name '*.py' \) -delete
rm -rf "$PKG/runtime/node/lib/node_modules/corepack" "$PKG/runtime/node/bin/corepack" \
       "$PKG/runtime/node/lib/node_modules/npm/node_modules/node-gyp"

# The architecture is proved, not trusted. A Node built for the other
# architecture runs under Rosetta and reports the wrong thing everywhere after.
if command -v file >/dev/null 2>&1; then
  FILE_SAYS="$(file -b "$PKG/runtime/node/bin/node")"
  case "$ARCH:$FILE_SAYS" in
    arm64:*arm64*|x64:*x86_64*) say "node binary is ${ARCH}, as asked" ;;
    *) echo "  the Node binary is not ${ARCH}: ${FILE_SAYS}" >&2; exit 1 ;;
  esac
fi

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
install -m 0755 "$STAGE/packaging/macos/ai17z" "$PKG/ai17z"
cp "$STAGE/LICENSE" "$PKG/LICENSE"
printf '%s\n' "$VERSION" > "$PKG/VERSION"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
mkdir -p "$OUT"
TARBALL="$OUT/AI17Z-macos-${ARCH}-${VERSION}.tar.gz"
# `--no-xattrs` where tar supports it: macOS extended attributes in a tarball
# are noise at best, and a quarantine flag travelling inside an archive is
# exactly the kind of surprise this packaging exists to avoid.
tar --version 2>/dev/null | grep -qi bsdtar \
  && tar --no-xattrs -czf "$TARBALL" -C "$ROOT" AI17Z \
  || tar -czf "$TARBALL" -C "$ROOT" AI17Z
say "built $(basename "$TARBALL")"
echo "AI17Z_TARBALL=$TARBALL"
