#!/usr/bin/env bash
#
# The one innoextract that reads AI17Z's Windows installer.
#
#   sudo bash ci/scripts/setup-innoextract.sh
#
# The installer is built with Inno Setup 6.7. Every released innoextract (1.9,
# the one Ubuntu ships) stops at 6.0.5 and refuses it with a loader checksum
# error, and upstream's master stops at 6.4. Support for 6.5 through 7.0.2 is
# the change proposed upstream as dscharrer/innoextract pull request 210, so
# this builds exactly that commit, from a source archive whose SHA-256 is
# pinned here. A different archive is a refusal, never a build.
#
# Pinning the extractor rather than an older Inno Setup: an installer compiler
# held back four years to suit a reader is the wrong way round, and the reader
# is checked anyway. private-identifiers.sh requires every file of the
# application zip to come out of the installer byte for byte, because this
# build warns rather than fails when it cannot read back some of its own output
# checksums.
set -euo pipefail

COMMIT=376a13e7c41cc5528b6088d0dd16ec1b323a8d37
SOURCE_SHA256=d780adf8d9111b61100adbe7f136f2eb94af889e3add0123a51560134516588d
URL="https://github.com/dscho/innoextract/archive/$COMMIT.tar.gz"
# What the build must say it reads, so a quietly different binary is caught.
READS="to 7.0.2"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl cmake make g++ \
  libboost-iostreams-dev libboost-filesystem-dev libboost-date-time-dev \
  libboost-system-dev libboost-program-options-dev liblzma-dev zlib1g-dev libbz2-dev >/dev/null

curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/source.tar.gz" "$URL"
echo "$SOURCE_SHA256  $WORK/source.tar.gz" | sha256sum -c - >/dev/null \
  || { echo "REFUSED: the innoextract source archive does not have the pinned SHA-256"; exit 1; }
tar -xzf "$WORK/source.tar.gz" -C "$WORK"
cmake -S "$WORK/innoextract-$COMMIT" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$WORK/build" -j "$(nproc)" >/dev/null
install -m 0755 "$WORK/build/innoextract" /usr/local/bin/innoextract

said="$(/usr/local/bin/innoextract --version)"
case "$said" in
  *"$READS"*) ;;
  *) echo "REFUSED: the built innoextract does not say it reads Inno Setup $READS"; exit 1 ;;
esac
echo "innoextract $COMMIT, source sha256 checked: $(printf '%s\n' "$said" | sed -n 2p)"
