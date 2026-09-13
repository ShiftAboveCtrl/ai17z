#!/usr/bin/env bash
#
# What is actually inside a finished AI17Z package.
#
#   scan-artifact.sh <file.tar.gz|file.deb> <macos|ubuntu>
#
# Unpacks the real artifact -- the bytes that would be published -- and refuses
# it if anything of the builder's or of an owner's is in there.
#
# Scanning the staging directory is not this. A stage is what the packager was
# handed; a package is what it produced, after `npm ci` has run, after a
# postinstall has fetched a binary, and after every copy step that could have
# brought something along. The difference is the whole point: a deny-list is a
# promise to have thought of everything, and the thing nobody thinks of is the
# one that ships somebody's master key.
#
# Runs on macOS and Linux, so it uses only what both have: BSD and GNU `find`,
# `grep`, `tar`, `dpkg-deb` where present.
set -uo pipefail

ARTIFACT="${1:?an artifact to scan}"
KIND="${2:?macos or ubuntu}"

problems=0
bad() { printf '  REFUSED  %s\n' "$1"; problems=$((problems+1)); }
ok()  { printf '  ok       %s\n' "$1"; }

ROOM="$(mktemp -d)"
trap 'rm -rf "$ROOM"' EXIT

echo "### unpacking the real artifact"
case "$KIND" in
  macos)  tar -xzf "$ARTIFACT" -C "$ROOM" ;;
  ubuntu)
    if command -v dpkg-deb >/dev/null 2>&1; then
      dpkg-deb -x "$ARTIFACT" "$ROOM"
    else
      echo "  no dpkg-deb to unpack with" >&2; exit 1
    fi ;;
  *) echo "  unknown kind: $KIND" >&2; exit 1 ;;
esac
echo "  $(find "$ROOM" -type f | wc -l | tr -d ' ') files"

echo
echo "### files that must not exist"
# Named one by one. `.env.example` is deliberately kept: it is the template the
# first run builds from, its key line is empty, and leaving it out was an
# installed build's very first failure.
while IFS= read -r found; do
  bad "an owner's file is in the package: ${found#"$ROOM"}"
done < <(find "$ROOM" -name '.env' -o -name '.env.local' -o \( -name '.env.*' ! -name '.env.example' \))
[ "$(find "$ROOM" -name '.env' | wc -l | tr -d ' ')" = 0 ] && ok "no .env"

for unwanted in storage browser-profiles .git; do
  if find "$ROOM" -type d -name "$(basename "$unwanted")" | grep -q .; then
    # `storage` appears as a source directory name in the application, so only a
    # directory with content in it is a finding.
    hits="$(find "$ROOM" -type d -name "$(basename "$unwanted")" -exec sh -c 'find "$1" -type f | head -1' _ {} \; 2>/dev/null | grep -c . || true)"
    if [ "$hits" -gt 0 ]; then bad "a $unwanted directory with files in it"; else ok "no $unwanted with anything in it"; fi
  else
    ok "no $unwanted"
  fi
done

# Ours, not our dependencies'. `fastify` publishes an AGENTS.md and
# `thread-stream` publishes a `.claude/` directory; both are their maintainers'
# files, shipped to npm on purpose, and nothing about them is this owner's. A
# scanner that refuses a package over somebody else's README is one that gets
# switched off, and then it is not scanning for the thing it was written for.
for name in CLAUDE.md .cursorrules AGENTS.md .claude; do
  hits="$(find "$ROOM" -name "$name" -not -path '*/node_modules/*' 2>/dev/null | head -3)"
  if [ -n "$hits" ]; then
    bad "$name is in the package"
    printf '%s\n' "$hits" | sed "s#$ROOM#    #"
  else
    ok "no $name of ours"
  fi
done

for db in '*.sqlite' '*.sqlite3' '*.db' '*.pem' '*.key' '*.p12' 'id_rsa' '*.cookies'; do
  if find "$ROOM" -name "$db" | grep -q .; then
    bad "a $db file is in the package: $(find "$ROOM" -name "$db" | head -1 | sed "s#$ROOM##")"
  fi
done
ok "no databases, keys or cookie jars"

echo
echo "### text that must not appear"
# Only files that could carry one. Node's own tree is large and full of test
# fixtures with example paths in them, so the application is what is searched:
# it is the part this project produced.
SEARCH_ROOT="$ROOM"
for candidate in "$ROOM/AI17Z/app" "$ROOM/usr/lib/ai17z/app"; do
  [ -d "$candidate" ] && SEARCH_ROOT="$candidate"
done
echo "  searching ${SEARCH_ROOT#"$ROOM"}"

# A builder's home directory. The runner's own path is what would leak from a
# stray absolute path baked into a config or a source map.
#
# `tools/releaseCheck.ts` is excluded by name: it is the publication scanner, its
# whole content is the list of patterns that must not appear anywhere else, and
# a check that cannot tell a pattern from a leak would refuse every package
# forever. Excluded by name rather than by weakening the pattern, so nothing
# else gets the same pass.
#
# The build user's own home is worked out rather than named. A scanner that
# carries somebody's username has put that username in a published file, which
# is the thing it exists to prevent.
PATTERNS='/Users/runner /home/runner C:\\Users\\'
if [ -n "${HOME:-}" ] && [ "$HOME" != "/root" ] && [ "$HOME" != "/" ]; then
  PATTERNS="$PATTERNS $HOME"
fi
# shellcheck disable=SC2086
for pattern in $PATTERNS; do
  hits="$(grep -rIl --exclude-dir=node_modules --exclude=releaseCheck.ts -e "$pattern" "$SEARCH_ROOT" 2>/dev/null | head -5 || true)"
  if [ -n "$hits" ]; then
    bad "the builder's path appears: $pattern"
    printf '%s\n' "$hits" | sed "s#$ROOM#    #"
  else
    ok "no $pattern"
  fi
done

# Credential shapes. Long random strings are common in lockfiles and minified
# code, so this looks for the labelled forms rather than for entropy.
for pattern in 'sk-[A-Za-z0-9]\{20,\}' 'xoxb-[A-Za-z0-9-]\{20,\}' 'ghp_[A-Za-z0-9]\{30,\}' 'AKIA[0-9A-Z]\{16\}' '-----BEGIN [A-Z ]*PRIVATE KEY-----'; do
  hits="$(grep -rIl --exclude-dir=node_modules -e "$pattern" "$SEARCH_ROOT" 2>/dev/null | head -3 || true)"
  if [ -n "$hits" ]; then
    bad "something credential-shaped: $pattern"
    printf '%s\n' "$hits" | sed "s#$ROOM#    #"
  fi
done
ok "nothing credential-shaped in the application"

# A master key that is not the empty template line.
if [ -f "$SEARCH_ROOT/.env.example" ]; then
  if grep -qE '^[A-Z0-9_]*MASTER_KEY[ \t]*=[ \t]*[^ \t]' "$SEARCH_ROOT/.env.example"; then
    bad ".env.example carries a master key value"
  else
    ok ".env.example is a template with an empty key"
  fi
else
  bad ".env.example is missing, and the first run builds from it"
fi

echo
echo "### binaries that belong to another platform"
case "$KIND" in
  macos) APP="$ROOM/AI17Z/app"; foreign='linux|win32' ;;
  ubuntu) APP="$ROOM/usr/lib/ai17z/app"; foreign='darwin|win32' ;;
esac

# Ours. `playwright-core` ships Windows helper scripts on every platform and npm
# writes a `.ps1` shim beside every `.cmd` it creates; neither is this project
# putting a Windows file in a Unix package.
hits="$(find "$APP" \( -name '*.exe' -o -name '*.dll' -o -name '*.ps1' -o -name '*.cmd' \) -not -path '*/node_modules/*' 2>/dev/null | head -5)"
if [ -n "$hits" ]; then
  bad "Windows files of ours are in a $KIND package"
  printf '%s\n' "$hits" | sed "s#$ROOM#    #"
else
  ok "no Windows files of ours"
fi

# esbuild is a different matter, and this one is fatal.
#
# npm installs exactly one platform package out of an optional set, and which
# one depends on the machine that ran `npm ci`. A stage built on the wrong
# machine carries the wrong binary under the right name: the package installs,
# and then every `tsx` process an installed copy runs dies on a file that is not
# for this architecture. This is the check that makes "built on a runner that
# really is that platform" mean something.
present="$(find "$APP/node_modules/@esbuild" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sed "s#.*/##" | tr '\n' ' ')"
echo "  @esbuild holds: ${present:-nothing}"
if [ -z "$present" ]; then
  bad "the package has no esbuild platform binary at all"
elif printf '%s' "$present" | grep -qE "$foreign"; then
  bad "another platform's esbuild is in a $KIND package: $present"
else
  ok "only this platform's esbuild"
fi

echo
if [ "$problems" -gt 0 ]; then
  echo "  $problems problem(s). This package must not be published."
  exit 1
fi
echo "  nothing of anybody's in it."
