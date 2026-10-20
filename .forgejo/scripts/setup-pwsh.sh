#!/usr/bin/env bash
#
# Put a known PowerShell on PATH, for the tests that run the shipped Windows
# setup script's decisions on Linux.
#
#   setup-pwsh.sh
#
# The Linux image the suite runs in has no PowerShell, and without one those
# tests skip, loudly, and prove nothing about the installer. GitHub's runners
# happened to carry one, so the gap appeared only when CI moved. Pinned by
# version and by the SHA-256 PowerShell's own release publishes for it, because
# a tool fetched unchecked is the one link nobody looks at.
set -euo pipefail

VERSION=7.6.7
case "$(uname -m)" in
  x86_64) ARCH=x64; SHA=6896f9e3a6b0a354bf470835a96da76d2f801cd50dcf047ad7c4563bf93bf431 ;;
  aarch64|arm64) ARCH=arm64; SHA=ba465efdfb0984c1c5dc5ed9eb0b79a7e91a1b52c45f99377058c0659b84d3f1 ;;
  *) echo "no PowerShell pinned for $(uname -m)"; exit 1 ;;
esac
NAME="powershell-${VERSION}-linux-${ARCH}.tar.gz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/$NAME" \
  "https://github.com/PowerShell/PowerShell/releases/download/v${VERSION}/${NAME}"
[ "$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)" = "$SHA" ] || { echo "$NAME does not match its pinned hash"; exit 1; }
mkdir -p /opt/pwsh
tar -xzf "$WORK/$NAME" -C /opt/pwsh
chmod 0755 /opt/pwsh/pwsh
ln -sf /opt/pwsh/pwsh /usr/local/bin/pwsh
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
