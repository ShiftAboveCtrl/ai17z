#!/usr/bin/env bash
#
# The maintainer's private identifiers, over everything a release publishes.
#
#   PRIVATE_IDENTIFIERS=<list> private-identifiers.sh <dist>
#
# Runs in the publish step, after every package is built and before anything is
# attached to a release on either host: the full history (history-scan.py, which
# reads $PRIVATE_IDENTIFIERS itself) and every finished artifact in <dist>,
# unpacked (tools/private-identifiers-scan.mts). The list is the repository
# secret PRIVATE_IDENTIFIERS, the same format as the maintainer's local one
# (tools/privateIdentifiers.ts). It is never printed, and neither is a match:
# only the class and where.
#
# Only the publish step may name it. A workflow a pull request can start names
# no secret, because a pull request is somebody else's code and could print it,
# and a printed list of somebody's identifiers is the leak itself.
#
# No secret is not a failure, because a fork or a fresh mirror has none, but it
# is said loudly enough that nobody mistakes it for a pass.
set -uo pipefail

DIST="${1:?the directory of finished release files}"

if [ -z "${PRIVATE_IDENTIFIERS:-}" ]; then
  echo "################################################################"
  echo "# PRIVATE IDENTIFIER SCAN SKIPPED"
  echo "# The PRIVATE_IDENTIFIERS secret is not set on this repository,"
  echo "# so nothing here checked this release for the maintainer's"
  echo "# usernames, hostnames or addresses. Set it to turn this on."
  echo "################################################################"
  exit 0
fi

problems=0

echo "### private identifiers in the history"
python3 .forgejo/scripts/history-scan.py . || problems=$((problems + 1))

echo
echo "### private identifiers in the finished files"
ROOM="$(mktemp -d)"
trap 'rm -rf "$ROOM"' EXIT
n=0
for file in "$DIST"/*; do
  [ -f "$file" ] || continue
  n=$((n + 1))
  into="$ROOM/$n"
  mkdir -p "$into"
  case "$file" in
    *.zip) unzip -q "$file" -d "$into" ;;
    *.deb) dpkg-deb -x "$file" "$into" ;;
    *.tar.gz|*.tgz) tar -xzf "$file" -C "$into" ;;
    *) cp "$file" "$into/" ;;
  esac || { echo "  could not unpack $(basename "$file")"; problems=$((problems + 1)); continue; }
  echo "  $(basename "$file")"
  npx --no-install tsx tools/private-identifiers-scan.mts "$into" | sed 's/^/  /'
  [ "${PIPESTATUS[0]}" -eq 0 ] || problems=$((problems + 1))
done
[ "$n" -gt 0 ] || { echo "  no files in $DIST"; problems=$((problems + 1)); }

if [ "$problems" -gt 0 ]; then
  echo
  echo "REFUSED: a private identifier would be published, or the scan could not run."
  exit 1
fi
echo
echo "no private identifiers in the history or in $n files"
