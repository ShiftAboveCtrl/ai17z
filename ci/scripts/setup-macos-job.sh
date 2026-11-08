#!/usr/bin/env bash
#
# Make a macOS release job able to build and prove AI17Z.
#
#   source ci/scripts/setup-macos-job.sh
#
# Sourced, so PATH carries into the job's later lines. The Node every package
# carries, from nodejs.org, checked against its published SHASUMS256.txt before
# it is unpacked: the same rule as every other job and the packages themselves.
# Not -u: this is sourced, so its options become the job shell's, and later
# lines may read optional variables that are unset.
set -eo pipefail

_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\(v[0-9.]*\)".*/\1/p' packaging/node-runtime.json | head -1)"
[ -n "$_version" ] || { echo "packaging/node-runtime.json names no Node version"; return 1; }
case "$(uname -m)" in
  arm64) _arch=arm64 ;;
  x86_64) _arch=x64 ;;
  *) echo "no Node for a Mac that is $(uname -m)"; return 1 ;;
esac
_name="node-${_version}-darwin-${_arch}.tar.gz"
_work="$(mktemp -d)"
curl -fsSL --proto '=https' --tlsv1.2 -o "$_work/$_name" "https://nodejs.org/dist/${_version}/${_name}"
curl -fsSL --proto '=https' --tlsv1.2 -o "$_work/SHASUMS256.txt" "https://nodejs.org/dist/${_version}/SHASUMS256.txt"
_expected="$(grep -E "  ${_name}\$" "$_work/SHASUMS256.txt" | awk '{print $1}')"
_actual="$(shasum -a 256 "$_work/$_name" | awk '{print $1}')"
[ -n "$_expected" ] && [ "$_expected" = "$_actual" ] || { echo "Node $_name does not match nodejs.org's published hash"; return 1; }
mkdir -p "$HOME/ai17z-node"
tar -xzf "$_work/$_name" -C "$HOME/ai17z-node" --strip-components=1
export PATH="$HOME/ai17z-node/bin:$PATH"
rm -rf "$_work"
echo "node $(node -v), npm $(npm -v), checked against nodejs.org"
