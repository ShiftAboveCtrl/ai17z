#!/usr/bin/env bash
#
# Gets AI17Z onto this machine and running, in one command.
#
# Clones the repository (or downloads and extracts it, if git is not installed),
# then hands over to install-ai17z.sh and start-ai17z.sh.
#
# Meant to be run this way:
#
#   curl -fsSL https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/bootstrap.sh | bash
#
# That pattern -- fetch a script and run it -- asks you to trust whatever the
# server sends. If you would rather look first, and you should:
#
#   curl -fsSL https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/bootstrap.sh -o bootstrap.sh
#   less bootstrap.sh
#   bash bootstrap.sh
#
# It installs nothing on your system. It clones into a folder and runs the
# scripts already in the repository, which check for Docker, Node and Chrome and
# say where to get whatever is missing.
#
# Options:
#   --dir <path>   where to put it (default ./ai17z)
#   --ref <name>   branch or tag to check out
#   --no-start     set up but do not start

set -euo pipefail

# GitHub first, then AI17Z Code, AI17Z's own server, which has the same
# history: the order every installer uses, so GitHub being down is never the
# end of an install.
REPO_URLS=("https://github.com/ShiftAboveCtrl/ai17z.git" "https://code.ai17z.io/AI17Z/ai17z.git")
ZIP_URLS=("https://github.com/ShiftAboveCtrl/ai17z/archive/refs/heads/main.zip" "https://code.ai17z.io/AI17Z/ai17z/archive/main.zip")

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
step() { echo "  ${CYAN}$1${OFF}"; }
done_() { echo "  ${GREEN}$1${OFF}"; }
stop_with_reason() {
  echo
  echo "  ${RED}$1${OFF}"
  [ -n "${2:-}" ] && echo "  ${YELLOW}$2${OFF}"
  echo
  exit 1
}

dir="ai17z"; ref=""; start=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift 2 ;;
    --ref) ref="$2"; shift 2 ;;
    --no-start) start=0; shift ;;
    *) stop_with_reason "Unknown option: $1" "Options: --dir <path>, --ref <name>, --no-start" ;;
  esac
done

echo
echo "AI17Z"
echo

if [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
  stop_with_reason "$dir already exists and is not empty." "Move it, delete it, or pass --dir somewhere else."
fi

# git if it is here, a zip if it is not. Nothing in AI17Z needs git afterwards,
# so somebody without it is not a second-class installation -- they just cannot
# pull updates with one command later.
if command -v git >/dev/null 2>&1; then
  step "Cloning into $dir..."
  cloned=0
  for url in "${REPO_URLS[@]}"; do
    if [ -n "$ref" ]; then set -- --branch "$ref"; else set --; fi
    if git clone --quiet "$@" "$url" "$dir"; then cloned=1; break; fi
    # A half-made clone would make the next attempt refuse the directory.
    rm -rf "$dir"
    echo "  ${YELLOW}Could not clone from ${url}; trying the next copy.${OFF}"
  done
  [ "$cloned" = 1 ] || stop_with_reason "The clone failed from GitHub and from AI17Z Code." "Check your connection and run this again."
else
  step "Git is not installed, downloading a zip instead..."
  command -v curl >/dev/null 2>&1 || stop_with_reason "Neither git nor curl is installed." "Install either one, then run this again."
  command -v unzip >/dev/null 2>&1 || stop_with_reason "unzip is not installed." "Install git or unzip, then run this again."
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fetched=0
  for url in "${ZIP_URLS[@]}"; do
    if curl -fsSL --proto '=https' "$url" -o "$tmp/ai17z.zip"; then fetched=1; break; fi
    echo "  ${YELLOW}Could not download ${url}; trying the next copy.${OFF}"
  done
  [ "$fetched" = 1 ] || stop_with_reason "The download failed from GitHub and from AI17Z Code." "Check your connection and run this again."
  unzip -q "$tmp/ai17z.zip" -d "$tmp/unpacked"
  # The archive wraps the tree in one folder named after the project.
  inner="$(find "$tmp/unpacked" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -n "$inner" ] || stop_with_reason "The download did not contain what was expected." "Try the git route, or clone by hand."
  mv "$inner" "$dir"
fi
done_ "Downloaded to $(cd "$dir" && pwd)"

cd "$dir"
chmod +x ./install-ai17z.sh ./start-ai17z.sh ./stop-ai17z.sh ./doctor-ai17z.sh 2>/dev/null || true
if [ "$start" = "1" ]; then
  exec ./install-ai17z.sh --start
else
  exec ./install-ai17z.sh
fi
