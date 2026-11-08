#!/usr/bin/env bash
# Recover every asset of an emergency AI17Z Code release to GitHub.
set -euo pipefail
TAG="${1:?a release tag}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || exit 2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "https://code.ai17z.io/api/v1/repos/AI17Z/ai17z/releases/tags/$TAG" > "$WORK/release.json"
mapfile -t NAMES < <(jq -er '.assets[].name' "$WORK/release.json")
[ "${#NAMES[@]}" -gt 0 ] || exit 1
rm "$WORK/release.json"
for name in "${NAMES[@]}"; do
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || exit 2
  curl -fsSL --proto '=https' --proto-redir '=https' -o "$WORK/$name" "https://code.ai17z.io/AI17Z/ai17z/releases/download/$TAG/$name"
done
if [ -z "${GITHUB_MIRROR_TOKEN:-}" ]; then
  read -r GITHUB_MIRROR_TOKEN < <(gh auth token)
  export GITHUB_MIRROR_TOKEN
fi
bash "$HERE/../../ci/scripts/mirror-github.sh" "$TAG" "$WORK"
