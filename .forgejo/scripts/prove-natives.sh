#!/usr/bin/env bash
#
# Every native file in a package is one a real machine of its platform built
# and ran.
#
#   prove-natives.sh <candidate> <reference>
#
# Both are the same kind of package: two macOS tarballs, or two .deb files.
# The reference is a package that was built natively and tested on its own
# platform, pinned by hash in .forgejo/native-references.json.
#
# Why this is enough to ship a package assembled somewhere else. AI17Z compiles
# nothing: its native files are Node, from nodejs.org, and prebuilt packages
# from the npm registry (esbuild, @napi-rs/canvas, fsevents). A package for a
# Mac assembled on Linux with `npm ci --os=darwin --cpu=arm64` receives the
# same files a Mac would have received. Whether it did is not argued, it is
# compared: the set of native files must be the same, path for path, and each
# must hash the same as the reference's. A file the reference does not have,
# or one that differs, means this release needs a new native binary, and that
# is the one case that needs a machine of that platform. The refusal says so.
#
# Executable code is recognised by its first bytes (Mach-O, universal Mach-O,
# ELF, PE), never by its name, because a native module can be called anything.
set -uo pipefail

CANDIDATE="${1:?the package to prove}"
REFERENCE="${2:?the natively built package to prove it against}"

ROOM="$(mktemp -d)"
trap 'rm -rf "$ROOM"' EXIT

# Unpack a package and print the directory its installed tree starts at.
unpack() { # package into
  local package="$1" into="$2"
  mkdir -p "$into"
  case "$package" in
    *.tar.gz)
      tar -xzf "$package" -C "$into" || return 1
      printf '%s\n' "$into/AI17Z" ;;
    *.deb)
      dpkg-deb -x "$package" "$into" || return 1
      printf '%s\n' "$into/usr/lib/ai17z" ;;
    *) echo "not a package this knows: $package" >&2; return 1 ;;
  esac
}

# "<path> <sha256>" for every file whose first bytes say it is native code.
natives() { # root
  local root="$1"
  (cd "$root" && find . -type f -print0 | sort -z | while IFS= read -r -d '' f; do
    magic="$(od -An -tx1 -N4 "$f" 2>/dev/null | tr -d ' \n')"
    case "$magic" in
      cffaedfe|cefaedfe|cafebabe|bebafeca|7f454c46|4d5a*)
        printf '%s %s\n' "${f#./}" "$(sha256sum "$f" | cut -d' ' -f1)" ;;
    esac
  done)
}

[ -f "$CANDIDATE" ] || { echo "no package at $CANDIDATE"; exit 1; }
[ -f "$REFERENCE" ] || { echo "no reference package at $REFERENCE"; exit 1; }

cand_root="$(unpack "$CANDIDATE" "$ROOM/candidate")" || { echo "could not unpack $CANDIDATE"; exit 1; }
ref_root="$(unpack "$REFERENCE" "$ROOM/reference")" || { echo "could not unpack $REFERENCE"; exit 1; }

natives "$cand_root" > "$ROOM/candidate.list"
natives "$ref_root" > "$ROOM/reference.list"

count="$(wc -l < "$ROOM/candidate.list" | tr -d ' ')"
[ "$count" -gt 0 ] || { echo "FAIL  $(basename "$CANDIDATE") has no native files at all, which no AI17Z package can run without"; exit 1; }

echo "### native files in $(basename "$CANDIDATE"), against $(basename "$REFERENCE")"
fail=0
while read -r path hash; do
  want="$(awk -v p="$path" '$1 == p {print $2}' "$ROOM/reference.list")"
  if [ -z "$want" ]; then
    printf '  FAIL  %s is new: the reference has no such file\n' "$path"; fail=$((fail+1))
  elif [ "$want" != "$hash" ]; then
    printf '  FAIL  %s differs from the reference (%s, reference %s)\n' "$path" "${hash:0:12}" "${want:0:12}"; fail=$((fail+1))
  else
    printf '  ok    %s  %s\n' "${hash:0:12}" "$path"
  fi
done < "$ROOM/candidate.list"
while read -r path _; do
  grep -q "^$(printf '%s' "$path" | sed 's/[][\.*^$/]/\\&/g') " "$ROOM/candidate.list" \
    || { printf '  FAIL  %s is in the reference and missing here\n' "$path"; fail=$((fail+1)); }
done < "$ROOM/reference.list"

if [ "$fail" -gt 0 ]; then
  cat <<EOF

$fail native file(s) are not the ones the reference was built and tested with.
This release needs a native binary the reference does not prove: build it on a
machine of that platform (a Mac registered as ai17z-release-macos-arm64 and
vars.AI17Z_MACOS set to 1, or an arm64 Linux runner), and make that package the
new reference once it has been tested there. Nothing was published.
EOF
  # Its own code, so the job can tell "this needs a native build" from a
  # package that failed to build at all.
  exit 3
fi
echo "  all $count native files are byte for byte the reference's"
