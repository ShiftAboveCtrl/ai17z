#!/usr/bin/env bash
#
# The release contract, over packages that were really built.
#
#   package-contract.sh <out> <version>
#
# What a release would publish for the platforms this pipeline built: the
# readable installers, the checksums over the real files, the manifest from the
# one place an asset name is composed, every package that manifest names
# present, and every architecture what its name claims. Windows is built only
# for a release, so it is left out here and the manifest says so.
set -euo pipefail

OUT="$(cd "${1:?the directory the packages are in}" && pwd)"
VERSION="${2:?a version}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

echo "--- what was built"
ls -l "$OUT"

echo "--- the readable installers, as the release publishes them"
cp "$ROOT/install-ai17z-macos.sh" "$ROOT/install-ai17z-ubuntu.sh" "$OUT/"

HAVE_MACOS=""
compgen -G "$OUT/AI17Z-macos-*.tar.gz" >/dev/null && HAVE_MACOS=1

echo "--- the checksums, over the real files"
( cd "$OUT"
  if [ -n "$HAVE_MACOS" ]; then
    sha256sum AI17Z-macos-*.tar.gz ai17z_*.deb install-ai17z-macos.sh install-ai17z-ubuntu.sh
  else
    sha256sum ai17z_*.deb install-ai17z-macos.sh install-ai17z-ubuntu.sh
  fi ) | tee "$OUT/SHA256SUMS.txt"

echo "--- the release manifest, from the one place a name is composed"
if [ -n "$HAVE_MACOS" ]; then
  EXPECT=macos,ubuntu
  REASON="Windows is built only for a release, and is proved before one by verify:install."
else
  EXPECT=ubuntu
  REASON="Not built in this validation run: Windows only for a release, and macOS only on GitLab's hosted Macs."
fi
( cd "$ROOT" && npx tsx tools/release-manifest.mts --dist "$OUT" --version "$VERSION" \
    --commit "${CI_COMMIT_SHA:-$(git rev-parse HEAD)}" ${CI_PIPELINE_URL:+--run "$CI_PIPELINE_URL"} \
    --expect "$EXPECT" --not-built "$REASON" )
cat "$OUT/release-manifest.json"

echo "--- every package the manifest names was built"
( cd "$ROOT" && OUT="$OUT" node -e '
  const fs = require("node:fs");
  const out = process.env.OUT;
  const manifest = JSON.parse(fs.readFileSync(`${out}/release-manifest.json`, "utf8"));
  let missing = 0;
  for (const artifact of manifest.artifacts) {
    if (artifact.platform !== "macos" && artifact.platform !== "ubuntu") continue;
    if (artifact.kind !== "app-package") continue;
    if (!fs.existsSync(`${out}/${artifact.name}`)) { console.error(`  missing: ${artifact.name}`); missing++; }
    else console.log(`  present: ${artifact.name}  ${artifact.sha256.slice(0, 16)}...`);
  }
  if (missing) { console.error(`${missing} artifact(s) named and not built`); process.exit(1); }
' )

echo "--- the architectures are what the names claim"
bash "$HERE/prove-architectures.sh" "$OUT"
