#!/usr/bin/env bash
#
# The maintainer's private identifiers, over everything a release publishes.
#
#   PRIVATE_IDENTIFIERS=<list> private-identifiers.sh history
#   PRIVATE_IDENTIFIERS=<list> private-identifiers.sh files <file>...
#
# `history` runs in the publish step before anything else: the whole history,
# through history-scan.py. `files` runs inside publish-release.sh on exactly the
# list it is about to attach (ASSETS), after the release directory has been
# flattened and every generated file written, so what is scanned is what is
# uploaded, byte for byte, and not a directory that later changes. Both use
# privacy_scan.py, the same scanner as the maintainer's pre-push gate.
#
# The list is the repository secret PRIVATE_IDENTIFIERS, in the format
# tools/privateIdentifiers.ts describes, and NOTHING else is read: the scanner
# runs with --ci, and every other variable that could replace, widen or excuse
# the list (PRIVATE_IDENTIFIERS_FILE, PRIVATE_IDENTIFIERS_ALLOW_FILE, a smaller
# or larger unpack budget, a home directory with a list in it) is cleared
# first. It is never printed, and neither is a match: only the class and where.
#
# Archives are opened by the scanner itself, nested ones too, with their
# metadata. Dependencies are scanned; only the generic home-path rule is relaxed
# under node_modules, because third-party packages ship other people's example
# paths. The Windows installer is unpacked with innoextract, and a release whose
# installer cannot be unpacked is refused rather than waved through.
#
# A hit in third-party bytes is excused by proof and nothing else: a file under
# node_modules identical to the same path in the registry tarball whose sha512
# this tag's package-lock.json records, or a file under runtime/node identical
# to the official tarball for the version packaging/node-runtime.json pins,
# checked against nodejs.org's SHASUMS256.txt. The tarballs are downloaded here,
# fresh, on every run. Every exemption is printed with the package, version and
# proof; a file one byte different, or anywhere else, refuses exactly as before.
#
# Only the publish step may name the secret. A workflow a pull request can
# start names no secret, because a pull request is somebody else's code and
# could print it, and a printed list of somebody's identifiers is the leak.
#
# No secret is a refusal. This runs only on release runners, only from a tag,
# so a missing secret there is a misconfiguration. A fork or a mirror that has
# no list says so by committing ci/private-identifiers-optional, and it
# counts only when the tag being released carries it: a file left in the
# working directory, or added by a later step, does not. Never a variable,
# because Forgejo merges organisation and user variables into a repository's.
set -uo pipefail

MODE="${1:?history or files}"
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [ -z "${PRIVATE_IDENTIFIERS:-}" ]; then
  TAG="${GITHUB_REF_NAME:-}"
  # From inside the checkout, with MSYS_NO_PATHCONV: Git Bash would otherwise
  # rewrite "<ref>:<path>" as a Windows path and the check would never find the
  # file, on a maintainer's machine only. It changes nothing on Linux.
  if [ -n "$TAG" ] && ( cd "$ROOT" && MSYS_NO_PATHCONV=1 \
       git cat-file -e "refs/tags/$TAG:ci/private-identifiers-optional" 2>/dev/null ); then
    echo "################################################################"
    echo "# PRIVATE IDENTIFIER SCAN SKIPPED, BY CHOICE"
    echo "# The tag being released carries ci/private-identifiers-optional,"
    echo "# so nothing here checked this release for a maintainer's usernames,"
    echo "# hostnames or addresses."
    echo "################################################################"
    exit 0
  fi
  echo "REFUSED: the PRIVATE_IDENTIFIERS secret is not set, so this release"
  echo "cannot be checked for the maintainer's private identifiers. Set the"
  echo "secret, or commit ci/private-identifiers-optional to the tag if"
  echo "this repository has no list."
  exit 1
fi

# Nothing but the secret reaches the scanner: no override variable, no home
# directory that might hold a list or an allow file.
EMPTY_HOME="$(mktemp -d)"
trap 'rm -rf "$EMPTY_HOME"' EXIT
scan() {
  env -u PRIVATE_IDENTIFIERS_FILE -u PRIVATE_IDENTIFIERS_ALLOW_FILE -u PRIVACY_SCAN_MAX_UNPACKED \
    -u GIT_REPLACE_REF_BASE -u GIT_GRAFT_FILE GIT_NO_REPLACE_OBJECTS=1 \
    HOME="$EMPTY_HOME" USERPROFILE="$EMPTY_HOME" "$@"
}

case "$MODE" in
  history)
    echo "### private identifiers in the history"
    scan python3 "$HERE/history-scan.py" --ci "$ROOT"
    exit $?
    ;;
  files)
    ;;
  *)
    echo "unknown mode: history or files"; exit 2 ;;
esac

[ "$#" -gt 0 ] || { echo "REFUSED: no files to scan, so nothing was proved clean"; exit 1; }
for f in "$@"; do
  [ -e "$f" ] || { echo "REFUSED: a file to be published is missing, so the set scanned is not the set uploaded"; exit 1; }
done

ROOM="$(mktemp -d)"
trap 'rm -rf "$EMPTY_HOME" "$ROOM"' EXIT

# The trust roots of a proof come from this checkout, which is the tag being
# released and whose history was scanned first. Without them nothing is
# exempted and every hit refuses, which is the safe way to be missing.
PROVE=(--proof-cache "$ROOM/proofs")
[ -f "$ROOT/package-lock.json" ] && PROVE+=(--prove-npm "$ROOT/package-lock.json")
[ -f "$ROOT/packaging/node-runtime.json" ] && PROVE+=(--prove-node "$ROOT/packaging/node-runtime.json")

problems=0
echo "### private identifiers in the ${#} files to be published"
# Directories, if any, are walked: every file, recursively.
scan python3 "$HERE/privacy_scan.py" --ci --checks identifiers --lenient node_modules=home-path "${PROVE[@]}" path "$@" | sed 's/^/  /'
[ "${PIPESTATUS[0]}" -eq 0 ] || problems=$((problems + 1))

# The application zip a given installer carries, by version, if it is in the set.
app_zip_for() {
  local base version f
  base="$(basename "$1")"
  case "$base" in AI17Z-Setup-*.exe) ;; *) return 0 ;; esac
  version="${base#AI17Z-Setup-}"; version="${version%.exe}"
  for f in "${@:2}"; do
    [ "$(basename "$f")" = "AI17Z-App-$version.zip" ] && { printf '%s' "$f"; return 0; }
  done
}

# The installer's payload is compressed in Inno Setup's own format, which only
# innoextract reads. Its raw bytes were scanned above; its contents are here.
#
# A failed extraction refuses, and so does one that is not shown to be whole.
# The innoextract that reads Inno Setup 6.7 (ci/scripts/setup-innoextract.sh)
# cannot check some of its own output checksums and warns instead, so an exit
# status is not enough: every file of the application zip released beside the
# installer must come out of it byte for byte.
n=0
for exe in "$@"; do
  case "$exe" in *.exe) ;; *) continue ;; esac
  n=$((n + 1))
  echo
  echo "### inside installer #$n"
  if ! command -v innoextract >/dev/null 2>&1; then
    echo "  REFUSED: innoextract is not installed, so the installer's contents cannot be read"
    problems=$((problems + 1))
    continue
  fi
  # The log is kept, never printed: innoextract names files, and a file's name
  # is exactly what the scan exists to withhold.
  if ! innoextract --output-dir "$ROOM/$n" "$exe" >"$ROOM/innoextract-$n.log" 2>&1; then
    echo "  REFUSED: innoextract could not unpack the installer, so its contents were not read"
    problems=$((problems + 1))
    continue
  fi
  files="$(find "$ROOM/$n" -type f | wc -l | tr -d ' ')"
  warned="$(grep -c '^Warning' "$ROOM/innoextract-$n.log" || true)"
  echo "  unpacked $files files; innoextract warned $warned times"
  if [ "$files" -eq 0 ]; then
    echo "  REFUSED: innoextract unpacked nothing, so the installer's contents were not read"
    problems=$((problems + 1))
    continue
  fi
  zip="$(app_zip_for "$exe" "$@")"
  if [ -n "$zip" ]; then
    python3 "$HERE/installer_matches_zip.py" "$zip" "$ROOM/$n/app" >"$ROOM/matches-$n.txt" 2>&1
    matched=$?
    sed 's/^/  /' "$ROOM/matches-$n.txt"
    if [ "$matched" -ne 0 ]; then
      echo "  REFUSED: the unpacked installer is not the application zip released with it, so its contents were not read whole"
      problems=$((problems + 1))
      continue
    fi
  else
    echo "  no application zip for this installer in the set, so it was not cross-checked"
  fi
  scan python3 "$HERE/privacy_scan.py" --ci --checks identifiers --lenient node_modules=home-path "${PROVE[@]}" path "$ROOM/$n" | sed 's/^/  /'
  [ "${PIPESTATUS[0]}" -eq 0 ] || problems=$((problems + 1))
done

if [ "$problems" -gt 0 ]; then
  echo
  echo "REFUSED: a private identifier would be published, or the scan could not run."
  exit 1
fi
echo
echo "no private identifiers in the ${#} files to be published"
