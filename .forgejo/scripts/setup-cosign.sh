#!/usr/bin/env bash
#
# Put a known cosign on PATH, for signing and verifying release provenance.
#
#   setup-cosign.sh
#
# Pinned by version and by the SHA-256 that sigstore publishes for it, in
# .forgejo/cosign.json. A signing tool fetched unchecked is a hole in exactly the
# place the signature is meant to close.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINS="$HERE/../cosign.json"
VERSION="$(jq -r '.version' "$PINS")"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "no cosign pinned for $(uname -m)"; exit 1 ;;
esac
EXPECTED="$(jq -r --arg a "linux-$ARCH" '.sha256[$a] // empty' "$PINS")"
[ -n "$EXPECTED" ] || { echo "no hash pinned for cosign linux-$ARCH"; exit 1; }

curl -fsSL --proto '=https' --tlsv1.2 -o /usr/local/bin/cosign \
  "https://github.com/sigstore/cosign/releases/download/${VERSION}/cosign-linux-${ARCH}"
ACTUAL="$(sha256sum /usr/local/bin/cosign | awk '{print $1}')"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  rm -f /usr/local/bin/cosign
  echo "cosign ${VERSION} hashes ${ACTUAL}, and ${EXPECTED} is pinned"
  exit 1
fi
chmod 0755 /usr/local/bin/cosign
cosign version | grep -i gitversion
