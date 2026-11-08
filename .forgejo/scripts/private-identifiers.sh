#!/usr/bin/env bash
#
# The maintainer's private identifiers, over everything a release publishes.
#
#   PRIVATE_IDENTIFIERS=<list> private-identifiers.sh <dist>
#
# Runs in the publish step, after every package is built and before anything is
# attached to a release on either host: the full history (history-scan.py) and
# every finished file in <dist> (privacy_scan.py, the same scanner as the
# maintainer's pre-push gate). The list is the repository secret
# PRIVATE_IDENTIFIERS, in the format tools/privateIdentifiers.ts describes. It
# is never printed, and neither is a match: only the class and where.
#
# The files are read as they are published. Archives are opened by the scanner
# itself, nested ones too, with their metadata (tar owner names, pax headers,
# zip comments, the control files of a .deb). Dependencies are scanned: a build
# writes its own paths into node_modules as readily as anywhere else. Only the
# generic home-path rule is relaxed there, because third-party packages ship
# other people's example paths; every specific rule still applies. The Windows
# installer is unpacked with innoextract, and a release whose installer cannot
# be unpacked is refused rather than waved through.
#
# Only the publish step may name the secret. A workflow a pull request can
# start names no secret, because a pull request is somebody else's code and
# could print it, and a printed list of somebody's identifiers is the leak.
#
# No secret is a refusal. This runs only on release runners, only from a tag,
# so a missing secret there is a misconfiguration, and a release that went out
# unchecked is exactly the failure this exists to stop. A fork or a mirror that
# genuinely has no list says so in its own history, by committing the file
# .forgejo/private-identifiers-optional. A file and not a variable, because
# Forgejo merges organisation and user variables into a repository's, so a
# variable can be set from outside the repository it switches off.
set -uo pipefail

DIST="${1:?the directory of finished release files}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [ -z "${PRIVATE_IDENTIFIERS:-}" ]; then
  if [ -f "$ROOT/.forgejo/private-identifiers-optional" ]; then
    echo "################################################################"
    echo "# PRIVATE IDENTIFIER SCAN SKIPPED, BY CHOICE"
    echo "# .forgejo/private-identifiers-optional says this repository has"
    echo "# no private identifier list, so nothing here checked this release"
    echo "# for a maintainer's usernames, hostnames or addresses."
    echo "################################################################"
    exit 0
  fi
  echo "REFUSED: the PRIVATE_IDENTIFIERS secret is not set, so this release"
  echo "cannot be checked for the maintainer's private identifiers. Set the"
  echo "secret, or commit .forgejo/private-identifiers-optional if this"
  echo "repository has no list."
  exit 1
fi

problems=0

echo "### private identifiers in the history"
python3 "$HERE/history-scan.py" "$ROOT" || problems=$((problems + 1))

echo
echo "### private identifiers in the finished files"
files=()
for file in "$DIST"/*; do
  [ -f "$file" ] && files+=("$file")
done
if [ "${#files[@]}" -eq 0 ]; then
  echo "  no files in $DIST"
  problems=$((problems + 1))
else
  python3 "$HERE/privacy_scan.py" --checks identifiers --lenient node_modules=home-path path "${files[@]}" \
    | sed 's/^/  /'
  [ "${PIPESTATUS[0]}" -eq 0 ] || problems=$((problems + 1))
fi

# The installer's payload is compressed in Inno Setup's own format, which only
# innoextract reads. Its raw bytes were scanned above; its contents are here.
ROOM="$(mktemp -d)"
trap 'rm -rf "$ROOM"' EXIT
n=0
for exe in "$DIST"/*.exe; do
  [ -f "$exe" ] || continue
  n=$((n + 1))
  echo
  echo "### inside installer #$n"
  if ! command -v innoextract >/dev/null 2>&1; then
    echo "  REFUSED: innoextract is not installed, so the installer's contents cannot be read"
    problems=$((problems + 1))
    continue
  fi
  if ! innoextract --silent --output-dir "$ROOM/$n" "$exe" >/dev/null 2>&1; then
    echo "  REFUSED: innoextract could not unpack the installer, so its contents were not read"
    problems=$((problems + 1))
    continue
  fi
  python3 "$HERE/privacy_scan.py" --checks identifiers --lenient node_modules=home-path path "$ROOM/$n" \
    | sed 's/^/  /'
  [ "${PIPESTATUS[0]}" -eq 0 ] || problems=$((problems + 1))
done

if [ "$problems" -gt 0 ]; then
  echo
  echo "REFUSED: a private identifier would be published, or the scan could not run."
  exit 1
fi
echo
echo "no private identifiers in the history or in ${#files[@]} files"
