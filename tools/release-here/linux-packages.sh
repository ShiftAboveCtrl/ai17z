#!/bin/bash
# The release's package-ubuntu (amd64) and package-assembled jobs, step for step,
# from a clean clone of the public tag. Writes into /out.
set -euo pipefail
TAG="${1:?tag}"; VERSION="${TAG#v}"
apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates nodejs >/dev/null
git clone -q https://code.ai17z.io/AI17Z/ai17z.git /src && cd /src && git checkout -q "$TAG"
echo "building $TAG at $(git rev-parse HEAD)"
bash .forgejo/scripts/setup-ubuntu-job.sh
apt-get install -y -qq --no-install-recommends lintian file >/dev/null
npm ci --no-audit --no-fund
echo "::package-ubuntu amd64"
bash .forgejo/scripts/package-ubuntu.sh "$VERSION" amd64 /out
echo "::package-assembled"
: > /out/absent-packages.txt
for target in "macos arm64" "macos x64" "ubuntu arm64"; do
  set -- $target
  if bash .forgejo/scripts/package-assembled.sh "$1" "$2" "$VERSION" /out; then :; else
    code=$?; [ "$code" -eq 3 ] || { echo "the $1 $2 package failed to build ($code)"; exit "$code"; }
    echo "$1 $2 needs a native build; left out"
    rm -f "/out/AI17Z-macos-$2-$VERSION.tar.gz" "/out/ai17z_${VERSION}_$2.deb"; echo "$1:$2" >> /out/absent-packages.txt
  fi
done
if grep -q '^macos:' /out/absent-packages.txt; then
  rm -f /out/AI17Z-macos-*.tar.gz
  grep -q '^macos:arm64$' /out/absent-packages.txt || echo 'macos:arm64' >> /out/absent-packages.txt
  grep -q '^macos:x64$' /out/absent-packages.txt || echo 'macos:x64' >> /out/absent-packages.txt
fi
[ -s /out/absent-packages.txt ] || rm -f /out/absent-packages.txt
ls -l /out
