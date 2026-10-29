#!/usr/bin/env bash
#
# The release notes for one version, printed to stdout.
#
#   release-notes.sh <version> <SHA256SUMS.txt> [macos]
#
# Run from the checkout. The third argument says the release carries a macOS
# package; without it the notes say plainly that this one does not.
#
# The page is read by somebody who wants to install AI17Z, so it opens with one
# command per operating system and keeps everything else (what changed, which
# file is which, how to verify) below it, folded. A checked-in file beside the
# release explains what changed and wins over the generated commit list, which
# is kept underneath rather than thrown away.
set -euo pipefail

VERSION="${1:?a version}"
SUMS="${2:?the SHA256SUMS.txt of the release}"
MACOS="${3:-}"
PROJECT_URL="https://code.ai17z.io/AI17Z/ai17z"
RAW="$PROJECT_URL/raw/branch/main"
BLOB="$PROJECT_URL/src/branch/main"
TAG="${RELEASE_TAG:-}"
if [ -z "$TAG" ] && [ "${GITHUB_REF_TYPE:-}" = tag ]; then TAG="${GITHUB_REF_NAME:-}"; fi
NOTES="docs/release-notes/$VERSION.md"

echo "## Install"
echo
echo "Copy the command for your operating system and paste it into a terminal."
echo
echo "**Windows 10 and 11**: open Windows Terminal and paste:"
echo
echo '```powershell'
# The literal command, the same string as the README and install.ps1's own
# help: a difference between them is a command that works in one place and
# not another, and tests/unit/installCommand.test.ts holds the three.
echo 'irm https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/install.ps1 | iex'
echo '```'
echo
if [ -n "$MACOS" ]; then
  echo "**macOS 13 or newer** (Apple silicon and Intel): open Terminal and paste:"
  echo
  echo '```bash'
  echo "curl -fsSLO $RAW/install-ai17z-macos.sh && bash install-ai17z-macos.sh"
  echo '```'
  echo
fi
echo "**Ubuntu 22.04 or newer** (amd64 and arm64): open a terminal and paste:"
echo
echo '```bash'
echo "curl -fsSLO $RAW/install-ai17z-ubuntu.sh && bash install-ai17z-ubuntu.sh"
echo '```'
echo
echo "The installer checks your system, offers to install anything missing, then"
echo "installs AI17Z and starts it. Every download is checked against this"
echo "release's \`SHA256SUMS.txt\` before it is used. AI17Z needs Docker, and"
echo "Google Chrome for browser features. On Windows the installer also sets up"
echo "WSL 2 and **Node.js 22 or newer** through Microsoft's own tools, and opens"
echo "AI17Z when it is ready. No security setting is changed."
echo
echo "[Full installation guide]($BLOB/docs/INSTALL.md) &middot;"
echo "[What the installer does]($BLOB/docs/SETUP_AUDIT.md) &middot;"
echo "[Uninstalling]($BLOB/docs/WINDOWS_UNINSTALL.md)"
echo
if [ -z "$MACOS" ]; then
  echo "> **No macOS package in this release.** macOS packages are built on a Mac"
  echo "> registered with AI17Z Code as a release runner, and none was available for this"
  echo "> release. A Mac already running AI17Z keeps the version it has; Windows and"
  echo "> Ubuntu are unaffected."
  echo
fi
if [ -n "${ABSENT_PACKAGES:-}" ]; then
  echo "> **Not in this release:** \`${ABSENT_PACKAGES}\`. Those systems stay on, or"
  echo "> install, the newest release that has a package for them."
  echo
fi

echo "## What's new"
echo
if [ -f "$NOTES" ]; then
  cat "$NOTES"
  echo
  echo '---'
  echo
fi

if [ -n "$TAG" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  # `--match 'v[0-9]*'`, because releases are not the only tags. A
  # `rehearsal-v*` tag sits on the commit that was rehearsed, which is an
  # ancestor of the one being released, so the nearest tag would otherwise be
  # the rehearsal and the list would hold two commits. Only a release is a
  # previous release.
  PREV=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$TAG^" 2>/dev/null || true)
  if [ -n "$PREV" ]; then
    echo "<details><summary>What changed since $PREV, commit by commit</summary>"
    echo
    git log --no-merges --format='- %s' "$PREV..$TAG"
    echo
    echo "</details>"
    echo
  fi
fi

echo "<details><summary>Which file is which</summary>"
echo
echo "You do not need to download anything by hand: the commands above fetch what"
echo "they need. These are here for anybody who wants a specific file."
echo
echo "| File | What it is |"
echo "| --- | --- |"
echo "| \`AI17Z-Setup-$VERSION.exe\` | Classic Windows installer. Unsigned; the command above is the recommended route |"
echo "| \`install-ai17z-macos.sh\` | macOS installer script, the same file the macOS command runs |"
echo "| \`install-ai17z-ubuntu.sh\` | Ubuntu installer script, the same file the Ubuntu command runs |"
echo "| \`AI17Z-macos-arm64-$VERSION.tar.gz\`, \`AI17Z-macos-x64-$VERSION.tar.gz\` | macOS application, Apple silicon and Intel |"
echo "| \`ai17z_${VERSION}_amd64.deb\`, \`ai17z_${VERSION}_arm64.deb\` | Ubuntu packages |"
echo "| \`SHA256SUMS.txt\` | SHA-256 of every file |"
echo "| \`SHA256SUMS.txt.sigstore.json\` | Signature of \`SHA256SUMS.txt\`, verifiable against [\`.forgejo/cosign.pub\`]($BLOB/.forgejo/cosign.pub) |"
echo
echo "The files the Windows command fetches itself (\`install.ps1\`,"
echo "\`Install-AI17Z-$VERSION.ps1\`, \`AI17Z-App-$VERSION.zip\`,"
echo "\`AI17Z-Setup-Audit-$VERSION.json\`, \`release-manifest.json\`) and a signature"
echo "for every file are published on [AI17Z Code]($PROJECT_URL/releases/tag/v$VERSION)."
echo
echo "The macOS and arm64 Ubuntu packages are assembled on Linux and accepted only"
echo "when every native file in them is byte for byte one a machine of that platform"
echo "built and ran ([\`.forgejo/native-references.json\`]($BLOB/.forgejo/native-references.json))."
echo
echo "</details>"
echo
echo "<details><summary>Verify a download</summary>"
echo
echo '```bash'
echo "cosign verify-blob SHA256SUMS.txt --bundle SHA256SUMS.txt.sigstore.json --key cosign.pub"
echo "sha256sum --check --ignore-missing SHA256SUMS.txt"
echo '```'
echo
echo '```'
cat "$SUMS"
echo '```'
echo
echo "</details>"
echo
echo "> Install AI17Z only with the commands above or from this release page."
echo "> Nowhere else distributes it."
