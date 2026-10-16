#!/usr/bin/env bash
#
# The release notes for one version, printed to stdout.
#
#   release-notes.sh <version> <SHA256SUMS.txt> [macos]
#
# Run from the checkout. The third argument says the release carries a macOS
# package; without it the notes say plainly that this one does not.
#
# A release worth explaining gets explained. A generated list of commit
# subjects answers "what moved" and never "should I take this": Beta 1.0.0
# shipped an interface that could not be opened at all, and its notes said
# `- web: a hook below an early return`, true and no use to anybody deciding
# whether to download it. So a file checked in beside the release wins, and the
# generated list is appended under it rather than thrown away.
set -euo pipefail

VERSION="${1:?a version}"
SUMS="${2:?the SHA256SUMS.txt of the release}"
MACOS="${3:-}"
PROJECT_URL="${CI_PROJECT_URL:-https://gitlab.com/shiftabovectrl/ai17z}"
RAW="$PROJECT_URL/-/raw/main"
BLOB="$PROJECT_URL/-/blob/main"
TAG="${CI_COMMIT_TAG:-}"

NOTES="docs/release-notes/$VERSION.md"
if [ -f "$NOTES" ]; then
  cat "$NOTES"
  echo
  echo '---'
  echo
fi

if [ -z "$MACOS" ]; then
  echo "> **No macOS package in this release.** macOS packages are built on GitLab's"
  echo "> hosted Macs, which this project's plan does not include. A Mac already running"
  echo "> AI17Z keeps the version it has; Windows and Ubuntu are unaffected."
  echo
fi

# Headed as Windows, because that is what it is about. The checked-in notes for
# a release go above this and cover every platform, and a section that opens
# "Open Windows Terminal" under a heading that says only the version reads like
# it applies to all of them.
echo "## Windows, in detail"
echo
echo "**Open Windows Terminal and paste this:**"
echo
echo '```powershell'
# The literal command, the same string as the README and install.ps1's own
# help: a difference between them is a command that works in one place and
# not another, and tests/unit/installCommand.test.ts holds the three.
echo 'irm https://gitlab.com/shiftabovectrl/ai17z/-/raw/main/install.ps1 | iex'
echo '```'
echo
echo "That is the whole installation. It checks this PC, installs anything"
echo "missing through Microsoft's own package manager, installs AI17Z, starts it,"
echo "and checks it works before it says so."
echo
echo "> **Install AI17Z only with the command published in this repository.**"
echo "> Nowhere else distributes it."
echo
if [ -n "$TAG" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  # `--match 'v[0-9]*'`, because releases are not the only tags. A
  # `rehearsal-v*` tag sits on the commit that was rehearsed, which is an
  # ancestor of the one being released, so the nearest tag to this one's parent
  # is the rehearsal, and the changelog would have read "what changed since
  # rehearsal-v1.0.0-beta.17" and listed two commits. Only a release is a
  # previous release.
  PREV=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$TAG^" 2>/dev/null || true)
  if [ -n "$PREV" ]; then
    echo "### What changed since $PREV"
    echo
    git log --no-merges --format='- %s' "$PREV..$TAG"
    echo
  fi
fi
echo "### Why a command and not a download"
echo
echo "AI17Z is not a signed application. Code signing for open-source projects is"
echo "granted on the strength of an existing user base, and AI17Z does not have one"
echo "yet, so an AI17Z .exe would be an unsigned executable Windows has never seen,"
echo "and Windows would say so, loudly, and be right to."
echo
echo "The answer is not to talk anybody past that warning. It is to not ask for it:"
echo "nothing in the command above is an executable, nothing is double-clicked, and"
echo "**no Windows security setting is touched, turned off, or argued with**: not"
echo "SmartScreen, not Defender, not your execution policy."
echo
echo "See [Windows trust and SmartScreen]($BLOB/docs/WINDOWS_TRUST.md)."
echo
echo "### What AI17Z is"
echo
echo "A local-first platform for running autonomous agents on X. An agent is an"
echo "identity, a memory, a model, a policy, and the channels it may act on. Everything"
echo "runs on your machine: your data, your credentials, your browser session."
echo
echo "### What it needs, on Windows"
echo
echo "**WSL 2**, **Docker Desktop**, **Node.js 22 or newer** and **Google Chrome**."
echo
echo "(The macOS and Ubuntu packages carry their own Node and need none installed.)"
echo
echo "AI17Z Setup checks for all four and installs the ones that are missing:"
echo "WSL through Microsoft's own wsl --install, and the rest through winget,"
echo "Microsoft's package manager. **It never downloads an executable from a URL"
echo "of its own.** Anything already present and new enough is left alone."
echo
echo "It waits for Docker's *engine* to answer rather than finishing the moment"
echo "Docker is installed, which is the \"restart your PC and run the installer"
echo "again\" step it exists to remove."
echo
echo "### What actually runs"
echo
echo "install.ps1 is short, public, and the file at the URL you just pasted. All it"
echo "does is resolve this release, download the setup program below, **check its"
echo "SHA-256 against the hash published here**, write it somewhere you can read it,"
echo "and run the bytes it checked. A mismatch stops everything."
echo
echo "The setup program itself is"
echo "[packaging/windows/Setup-AI17Z.ps1]($BLOB/packaging/windows/Setup-AI17Z.ps1),"
echo "the whole installer, as a script, published here as Install-AI17Z-$VERSION.ps1."
echo
echo "**[How to audit it]($BLOB/docs/SETUP_AUDIT.md)**: every privileged action,"
echo "every download, everything it writes."
echo
echo "### Installing"
echo
echo "Per-user. No administrator rights for AI17Z itself; one Windows prompt for"
echo "WSL 2 and Docker Desktop, explained on screen before it appears."
echo
echo "    program    %LOCALAPPDATA%\\Programs\\AI17Z"
echo "    your data  %LOCALAPPDATA%\\AI17Z"
echo
echo "Your data is kept apart from the program on purpose: updating replaces the"
echo "program and never touches your data."
echo
echo "### More than one AI17Z"
echo
echo "A machine can hold several independent installations (different agents,"
echo "different databases, different signed-in accounts) and they share nothing."
echo "Updating one leaves the others exactly as they are."
echo
echo '```powershell'
echo "\$s = irm $RAW/install.ps1"
echo "& ([scriptblock]::Create(\$s)) -List                 # what is installed"
echo "& ([scriptblock]::Create(\$s)) -NewInstance          # install another"
echo "& ([scriptblock]::Create(\$s)) -Instance AI17Z-test  # update that one"
echo '```'
echo
echo "### Updates"
echo
echo "AI17Z checks GitLab for new versions and shows the release notes on the"
echo "Version panel in Settings, which names the installation it belongs to. **It"
echo "never updates itself.** You can skip a version, ignore it, or turn the check"
echo "off, in which case no request is made at all."
echo
echo "### The files here"
echo
echo "| | |"
echo "| --- | --- |"
echo "| install.ps1 | the command above, as a file, if you would rather pin or read it |"
echo "| Install-AI17Z-$VERSION.ps1 | the setup program: the whole installer, as a script |"
echo "| AI17Z-App-$VERSION.zip | the application, which the setup program hash-checks |"
echo "| AI17Z-Setup-$VERSION.exe | **the older full installer.** Unsigned, and not the recommended route: it is what installations made before this one update with |"
echo "| AI17Z-Setup-Audit-$VERSION.json | what the setup program declares it may do |"
echo "| SHA256SUMS.txt | hashes for all of the above |"
echo "| *.sigstore.json | build provenance for each file: which pipeline, at which tag, made it |"
echo
echo "- [Installing on Windows]($BLOB/docs/WINDOWS_INSTALL.md)"
echo "- [Auditing AI17Z Setup]($BLOB/docs/SETUP_AUDIT.md)"
echo "- [Uninstalling]($BLOB/docs/WINDOWS_UNINSTALL.md)"
echo "- [Privacy]($BLOB/docs/PRIVACY.md)"
echo
echo "### Verify what you ran"
echo
echo "The checked setup program is written into %LOCALAPPDATA%\\AI17Z-setup before"
echo "it runs. It is kept there whenever anything goes wrong, and removed after a"
echo "clean run because it is a copy of a file published here. Pass -KeepDownload"
echo "to keep it either way, and hash it against the line for"
echo "Install-AI17Z-$VERSION.ps1 below:"
echo
echo '```powershell'
echo "& ([scriptblock]::Create((irm $RAW/install.ps1))) -KeepDownload"
echo "Get-FileHash \$env:LOCALAPPDATA\\AI17Z-setup\\Setup-AI17Z.checked.ps1 -Algorithm SHA256"
echo '```'
echo
echo '```'
cat "$SUMS"
echo '```'
