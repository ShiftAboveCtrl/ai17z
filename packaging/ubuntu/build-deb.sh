#!/usr/bin/env bash
#
# Builds the AI17Z Debian package.
#
# Runs on Ubuntu -- in CI, or in a container from a developer machine that is
# not Ubuntu. It assembles a package root, fetches the private Node runtime from
# nodejs.org and **verifies it against Node's own published SHA256SUMS**, and
# calls dpkg-deb.
#
# The application payload is staged by tools/package-unix.mts before this runs,
# so this script does no npm work: its job is layout, the runtime, and metadata.
#
#   build-deb.sh --stage <dir> --version <x.y.z> --arch amd64|arm64 --node vX.Y.Z --out <dir>

set -euo pipefail

STAGE=""; VERSION=""; ARCH=""; NODE_VERSION=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --node) NODE_VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
for required in STAGE VERSION ARCH NODE_VERSION OUT; do
  if [ -z "${!required}" ]; then echo "missing --${required,,}" >&2; exit 2; fi
done
case "$ARCH" in amd64|arm64) ;; *) echo "unsupported architecture: $ARCH" >&2; exit 2 ;; esac

# Node names x86-64 `x64`; Debian names it `amd64`. One place converts.
NODE_ARCH="$ARCH"; [ "$ARCH" = "amd64" ] && NODE_ARCH="x64"

say() { printf '  %s\n' "$1"; }

# shellcheck source=../unix/pack-permissions.sh
. "$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../unix" && pwd)/pack-permissions.sh"

# Whatever the stage was handed, nothing of an owner's leaves here.
#
# The stager filters these already. This is the second gate on purpose: a
# packaging script that ships somebody's master key because its input was dirty
# is still a packaging script that shipped somebody's master key. `.env.example`
# is deliberately kept -- it is the template the first run builds from, its key
# line is empty, and leaving it out was an installed build's very first failure.
# Linter configuration, npm bookkeeping and CI descriptions that dependencies
# publish to npm along with their code. Nothing loads any of it at runtime, and
# every one of them is a lintian error in a Debian package.
#
# Pruned rather than overridden, because an override is a note saying a file
# that should not be there is allowed to be there. These simply should not be
# there: they make the package bigger and they are somebody else's repository
# furniture.
#
# Named one by one, and only files nothing can read at runtime. Dependency
# `test/` directories are deliberately left alone -- a package that loads a
# fixture at runtime is rare and real, and a smaller package is not worth
# finding out which one does.
prune_dependency_cruft() { # root
  find "$1" -path '*/node_modules/*' \( \
    -name '.eslintrc' -o -name '.eslintrc.*' -o -name 'eslint.config.*' -o \
    -name '.npmignore' -o -name '.editorconfig' -o -name '.travis.yml' -o \
    -name '.jshintrc' -o -name '.prettierrc' -o -name '.prettierrc.*' \
  \) -type f -delete 2>/dev/null || true
  find "$1" -path '*/node_modules/*' -type d -name '.github' -prune -exec rm -rf {} + 2>/dev/null || true
}

prune_owner_files() { # root
  find "$1" -name '.env' -delete
  find "$1" -name '.env.local' -delete
  find "$1" -name '.env.*' ! -name '.env.example' -delete
  find "$1" -type d \( -name storage -o -name browser-profiles -o -name .git \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$1" -name '*.tsbuildinfo' -delete
}

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
PKG="$ROOT/pkg"

say "assembling ai17z ${VERSION} (${ARCH})"

install -d -m 0755 \
  "$PKG/DEBIAN" \
  "$PKG/usr/bin" \
  "$PKG/usr/lib/ai17z" \
  "$PKG/usr/share/applications" \
  "$PKG/usr/share/doc/ai17z" \
  "$PKG/usr/share/icons/hicolor/256x256/apps"

# ---------------------------------------------------------------------------
# The application
# ---------------------------------------------------------------------------
cp -a "$STAGE" "$PKG/usr/lib/ai17z/app"
prune_owner_files "$PKG/usr/lib/ai17z/app"
prune_dependency_cruft "$PKG/usr/lib/ai17z/app"

# Permissions the build host cannot be trusted for. One implementation, shared
# with the macOS build, because both had the same gap and only one of them had
# even the shebang half of the rule.
ai17z_fix_permissions "$PKG/usr/lib/ai17z/app"

# ---------------------------------------------------------------------------
# The private Node runtime
#
# Fetched from nodejs.org and checked against Node's own SHASUMS256.txt before
# a byte of it is unpacked. Nothing here trusts a Node that happens to be on
# PATH, and nothing installs one system-wide: an AI17Z update must not change
# what `node` means to anything else on the machine.
# ---------------------------------------------------------------------------
NODE_TAR="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"
say "fetching ${NODE_TAR}"
curl -fsSL --retry 3 -o "$ROOT/$NODE_TAR" "$NODE_URL"
curl -fsSL --retry 3 -o "$ROOT/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"

EXPECTED="$(grep " ${NODE_TAR}\$" "$ROOT/SHASUMS256.txt" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  echo "  nodejs.org publishes no checksum for ${NODE_TAR}" >&2
  exit 1
fi
ACTUAL="$(sha256sum "$ROOT/$NODE_TAR" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "  the Node runtime does not match its published SHA-256" >&2
  echo "    expected $EXPECTED" >&2
  echo "    got      $ACTUAL" >&2
  exit 1
fi
say "node runtime verified (${ACTUAL:0:12})"

install -d -m 0755 "$PKG/usr/lib/ai17z/runtime"
tar -xzf "$ROOT/$NODE_TAR" -C "$ROOT"
mv "$ROOT/node-${NODE_VERSION}-linux-${NODE_ARCH}" "$PKG/usr/lib/ai17z/runtime/node"
# npm and npx ship with Node and the installed copy runs npm scripts, so they
# stay. What goes is documentation nobody reads from a package directory.
rm -rf "$PKG/usr/lib/ai17z/runtime/node/share/doc" \
       "$PKG/usr/lib/ai17z/runtime/node/share/man" \
       "$PKG/usr/lib/ai17z/runtime/node/include"

# What upstream Node carries that Linux cannot use and AI17Z does not want.
#
# The `.ps1` and `.cmd` shims are for a platform this package by definition is
# not on. node-gyp brings Python helpers for compiling native addons, which an
# installed AI17Z never does -- it ships the addons already built. Corepack's
# yarn and pnpm shims are for package managers AI17Z does not use. Every one of
# them is dead weight, and lintian is right to object to all of it.
RUNTIME_NODE="$PKG/usr/lib/ai17z/runtime/node"
find "$RUNTIME_NODE" \( -name '*.ps1' -o -name '*.cmd' -o -name '*.bat' \) -delete
rm -rf "$RUNTIME_NODE/lib/node_modules/corepack" "$RUNTIME_NODE/bin/corepack" \
       "$RUNTIME_NODE/lib/node_modules/npm/node_modules/node-gyp"
find "$RUNTIME_NODE" \( -name '*.py' -o -name '*.pyc' \) -delete

# Three things lintian objects to that are upstream Node being upstream Node.
#
# The binary is deliberately **not** stripped: it is Node's own build, and its
# SHA-256 was checked against nodejs.org a few lines above. Stripping it would
# produce a binary that no longer matches the thing that was verified, trading a
# warning for the loss of the only proof anybody has about what this runtime is.
install -d -m 0755 "$PKG/usr/share/lintian/overrides"
cat > "$PKG/usr/share/lintian/overrides/ai17z" <<'OVERRIDES'
# AI17Z ships its own Node runtime, on purpose. An installation must not change
# behaviour because somebody installed, removed or switched a system Node, and
# most desktop Ubuntu users have none at all. Depending on `nodejs` would let
# apt decide which Node AI17Z runs, which is the thing being avoided.
ai17z: missing-dep-for-interpreter node (does not satisfy nodejs:any) [usr/lib/ai17z/runtime/node/*]
# The same reason, for the whole application tree: AI17Z's own supervisor script
# and the command line entry points several dependencies ship, all carrying a
# `#!/usr/bin/env node` line. Every one of them runs under AI17Z's own runtime,
# which is on PATH ahead of anything else for every process AI17Z starts.
# Declaring a dependency on the distribution's `nodejs` to satisfy a shebang
# would hand apt the decision this package exists to keep -- and most desktop
# Ubuntu machines have no system Node at all.
ai17z: missing-dep-for-interpreter node (does not satisfy nodejs:any) [usr/lib/ai17z/app/*]
# esbuild is written in Go and ships a statically linked binary. That is
# upstream's build, fetched by npm, and the alternative is not having esbuild --
# which means not having tsx, which means an installed copy that cannot run a
# single script.
ai17z: statically-linked-binary [usr/lib/ai17z/app/node_modules/esbuild/bin/esbuild]
ai17z: statically-linked-binary [usr/lib/ai17z/app/node_modules/@esbuild/*/bin/esbuild]
# A dependency's own test script, with its own shebang. Nothing here runs it,
# and editing a file inside node_modules to satisfy a linter would make the tree
# stop matching the lockfile that describes it.
ai17z: wrong-path-for-interpreter /usr/bin/bash != /bin/bash [usr/lib/ai17z/app/node_modules/*]
# Upstream Node's own binary, left exactly as downloaded. Stripping it, or
# rebuilding it as a position-independent executable, would produce something
# that no longer matches the checksum that proves what it is.
ai17z: unstripped-binary-or-object [usr/lib/ai17z/runtime/node/bin/node]
ai17z: hardening-no-pie [usr/lib/ai17z/runtime/node/bin/node]
# Node links zlib statically. That is upstream's build, not a choice made here.
ai17z: embedded-library
# One command, documented by `ai17z --help` and by the project's own docs. A
# generated man page repeating that would be a third place to keep in step.
ai17z: no-manual-page [usr/bin/ai17z]
OVERRIDES
chmod 0644 "$PKG/usr/share/lintian/overrides/ai17z"

# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------
install -m 0755 "$STAGE/packaging/ubuntu/ai17z" "$PKG/usr/bin/ai17z"
install -m 0644 "$STAGE/packaging/ubuntu/ai17z.desktop" "$PKG/usr/share/applications/ai17z.desktop"
if [ -f "$STAGE/packaging/windows/ai17z-256.png" ]; then
  install -m 0644 "$STAGE/packaging/windows/ai17z-256.png" \
    "$PKG/usr/share/icons/hicolor/256x256/apps/ai17z.png"
fi

# ---------------------------------------------------------------------------
# Documentation, copyright and changelog
#
# lintian requires all three, and a package without a machine-readable copyright
# is one a distribution will not look at twice.
# ---------------------------------------------------------------------------
install -m 0644 "$STAGE/LICENSE" "$PKG/usr/share/doc/ai17z/copyright"
{
  printf 'ai17z (%s) stable; urgency=medium\n\n' "$VERSION"
  printf '  * AI17Z %s. Release notes:\n' "$VERSION"
  printf '    https://github.com/ShiftAboveCtrl/ai17z/releases/tag/v%s\n\n' "$VERSION"
  printf ' -- AI17Z <ai17z@users.noreply.github.com>  %s\n' "$(date -R)"
} > "$ROOT/changelog"
# A version carrying a dash is a non-native package, and Debian wants the
# revision spelling of the changelog for one.
gzip -9n -c "$ROOT/changelog" > "$PKG/usr/share/doc/ai17z/changelog.Debian.gz"
chmod 0644 "$PKG/usr/share/doc/ai17z/changelog.Debian.gz"
install -m 0644 "$STAGE/README.md" "$PKG/usr/share/doc/ai17z/README.md"

# ---------------------------------------------------------------------------
# Control metadata
#
# Deliberately few Depends. Docker and Chrome are not declared: apt would then
# be entitled to pull, replace or remove them, and AI17Z does not own third
# party software it merely uses. The installer checks for them and says what is
# missing; that is a conversation, not a dependency edge.
# ---------------------------------------------------------------------------
INSTALLED_KB="$(du -sk "$PKG/usr" | awk '{print $1}')"
cat > "$PKG/DEBIAN/control" <<CONTROL
Package: ai17z
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: ${ARCH}
Maintainer: AI17Z <ai17z@users.noreply.github.com>
Installed-Size: ${INSTALLED_KB}
Depends: libc6, ca-certificates
Recommends: docker-ce | docker.io
Suggests: google-chrome-stable
Homepage: https://github.com/ShiftAboveCtrl/ai17z
Description: Local-first platform for running autonomous agents
 AI17Z runs autonomous agents on your own machine. An agent is an identity, a
 memory, a model, a policy, and a set of channels it can act on.
 .
 Everything stays local: your data, your credentials and your browser session
 live in your own home directory, and the database runs in a container on this
 machine. AI17Z talks only to the services you configure.
 .
 This package carries its own Node runtime, so no system Node is required or
 changed. Docker is needed for the database and is not installed by this
 package. Google Chrome is optional and enables browser-backed channels.
CONTROL

install -m 0755 "$STAGE/packaging/ubuntu/postinst" "$PKG/DEBIAN/postinst"
install -m 0755 "$STAGE/packaging/ubuntu/postrm" "$PKG/DEBIAN/postrm"

# Nothing under /usr is configuration, so there are no conffiles. An owner's
# configuration lives in their home and apt never touches it -- which is the
# property that makes an upgrade safe.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
# Root-owned, mode-correct, and reproducible enough that two builds of one
# commit agree. `--root-owner-group` is what stops the building user's uid
# leaking into somebody else's filesystem.
mkdir -p "$OUT"
DEB="$OUT/ai17z_${VERSION}_${ARCH}.deb"
# Checked before it is sealed. A file listing shows a binary present and
# correct, and only its mode says it cannot be run -- which is invisible until
# somebody's first start.
ai17z_assert_executables_runnable "$PKG/usr/lib/ai17z"

dpkg-deb --build --root-owner-group -Zxz "$PKG" "$DEB" >/dev/null
say "built $(basename "$DEB") ($(du -h "$DEB" | awk '{print $1}'))"
echo "AI17Z_DEB=$DEB"
