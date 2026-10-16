#!/usr/bin/env bash
#
# Assemble, sign and publish an AI17Z release from what the build jobs made.
#
#   publish-release.sh <dist> <version> [rehearsal]
#
# Run by the `publish` job, in a pipeline started by a `v*` tag (a release) or a
# `rehearsal-v*` tag (everything except the release). Every step a release takes
# is taken by a rehearsal too, signing included, and only the last two, the
# upload and the release itself, are skipped. A step exercised for the first
# time by the release it protects is the shape that has cost this project
# releases before.
#
# What a release is:
#
#   install.ps1                     the command on the README, published so it
#                                   can be pinned and compared
#   Install-AI17Z-<version>.ps1     the setup program: the whole installer, as a
#                                   script somebody can read
#   AI17Z-App-<version>.zip         the application it installs
#   AI17Z-Setup-<version>.exe       the older full installer, still published
#                                   because installations made with it update by
#                                   running a newer one
#   ai17z_<version>_<arch>.deb      Ubuntu, amd64 and arm64
#   AI17Z-macos-arm64-<version>.tar.gz   macOS, Apple silicon, when built
#   install-ai17z-{macos,ubuntu}.sh the readable installers, from this tag
#   release-manifest.json           what the release is, for updaters
#   AI17Z-Setup-Audit-<version>.json   what the setup program declares it may do
#   SHA256SUMS.txt                  hashes for every installable file above
#   <file>.sigstore.json            a Sigstore bundle for every file above
#
# **There is no signing lane, and no signed executable.** Code signing for
# open-source projects is granted on the strength of an existing user base, and
# AI17Z applied and was turned down for not having one yet. The Sigstore bundles
# are build provenance, not a platform signature: they answer "did this come out
# of this project's pipeline at this tag", not "has a vendor vouched for it",
# and the documentation says so in those words. See docs/WINDOWS_TRUST.md.
set -euo pipefail

DIST="$(cd "${1:?the directory the build artifacts are in}" && pwd)"
VERSION="${2:?the version, without the leading v}"
REHEARSAL="${3:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The checkout, which is where npx and the repository files are. Named once,
# because everything after the first `cd` below runs inside the release directory.
PROJECT_DIR="${CI_PROJECT_DIR:-$(cd "$HERE/../.." && pwd)}"
TAG="v${VERSION}"
SERVER="${CI_SERVER_URL:-https://gitlab.com}"
PROJECT="${CI_PROJECT_PATH:-shiftabovectrl/ai17z}"
API="${CI_API_V4_URL:-$SERVER/api/v4}/projects/${CI_PROJECT_ID:-${PROJECT//\//%2F}}"
RUN="${CI_PIPELINE_URL:-}"
COMMIT="${CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
# The one sentence a release without macOS carries, in its manifest and notes.
MACOS_NOT_BUILT="macOS packages are built on GitLab's hosted Macs, which this project's plan does not include; this release has none. A Mac already running AI17Z keeps the version it has."

say() { printf '\n==== %s ====\n' "$1"; }

say "the readable installers, from this tag"
# Repository files rather than build outputs, copied in before the checksums so
# they are covered like everything else. What a person downloads and reads is
# exactly what this tag holds.
cp "$PROJECT_DIR/install-ai17z-macos.sh" "$PROJECT_DIR/install-ai17z-ubuntu.sh" "$DIST/"
cd "$DIST"
# Flatten whatever came back, so the release has files rather than folders.
find . -mindepth 2 -type f -exec cp -n {} . \; 2>/dev/null || true
find . -mindepth 1 -type d -exec rm -rf {} + 2>/dev/null || true

HAVE_MACOS=""
compgen -G "AI17Z-macos-*.tar.gz" >/dev/null && HAVE_MACOS=1

say "checksums"
# Every installable file, not only the installer.
#
# This list is the whole trust chain: `install.ps1` checks the setup program
# against it before running a line of it, and the setup program checks the
# application package against it before extracting a byte. A SHA256SUMS.txt
# missing either name is a release that cannot be installed at all,
# deliberately, because neither script will accept a payload whose hash it
# cannot establish.
INSTALLABLE=(AI17Z-Setup-*.exe install.ps1 Install-AI17Z-*.ps1 AI17Z-App-*.zip
  install-ai17z-macos.sh install-ai17z-ubuntu.sh ai17z_*.deb)
[ -n "$HAVE_MACOS" ] && INSTALLABLE+=(AI17Z-macos-*.tar.gz)
sha256sum "${INSTALLABLE[@]}" | tee SHA256SUMS.txt

say "nothing of an owner's is in anything published"
# Over the bytes that are about to be attached, after an upload and a download,
# rather than only on each builder. The Windows package is scanned here and
# nowhere else, because that job runs on Windows where this script's tools are
# not all there. The release notes say every published package is unpacked and
# scanned, so it has to be true of every one.
scanned=0
for zip in AI17Z-App-*.zip; do bash "$HERE/scan-artifact.sh" "$zip" windows; scanned=$((scanned + 1)); done
for deb in ai17z_*.deb; do bash "$HERE/scan-artifact.sh" "$deb" ubuntu; scanned=$((scanned + 1)); done
if [ -n "$HAVE_MACOS" ]; then
  for tarball in AI17Z-macos-*.tar.gz; do bash "$HERE/scan-artifact.sh" "$tarball" macos; scanned=$((scanned + 1)); done
fi
# One Windows zip and two Debian packages, and a Mac when there is one. A glob
# that matched nothing would otherwise be a loop that ran nothing and a step
# that passed.
expected=3; [ -n "$HAVE_MACOS" ] && expected=4
echo "scanned $scanned package(s)"
[ "$scanned" -eq "$expected" ] || { echo "expected $expected packages, scanned $scanned"; exit 1; }

say "the release manifest"
# Built here, from the directory the release is attached out of, so its hashes
# are the ones somebody will actually get. Every asset name in it comes from
# @xbam/shared, which is the only place one is composed. A release without macOS
# says so in its manifest, with the reason, rather than looking like a release
# that lost a package.
( cd "$PROJECT_DIR" && if [ -n "$HAVE_MACOS" ]; then
    npx tsx tools/release-manifest.mts --dist "$DIST" --version "$VERSION" --commit "$COMMIT" ${RUN:+--run "$RUN"}
  else
    npx tsx tools/release-manifest.mts --dist "$DIST" --version "$VERSION" --commit "$COMMIT" ${RUN:+--run "$RUN"} \
      --expect windows,ubuntu --not-built "$MACOS_NOT_BUILT"
  fi )
cat release-manifest.json

say "the audit document for this release"
# What the setup program says it may do, plus what this particular release
# actually is: the tag, the commit, and the hash of every file published beside
# it. Built here so it hashes the files that are about to be published.
ARTIFACTS="$(sha256sum "${INSTALLABLE[@]}" \
  | jq -R -s 'split("\n") | map(select(length > 0) | split("  ") | {name: .[1], sha256: .[0]})')"
jq -n \
  --slurpfile declaration setup-declaration.json \
  --argjson artifacts "$ARTIFACTS" \
  --arg version "$VERSION" \
  --arg tag "$TAG" \
  --arg commit "$COMMIT" \
  --arg run "$RUN" \
  --arg project "$SERVER/$PROJECT" \
  --argjson signed false \
  '{
    schema: 1,
    release: {version: $version, tag: $tag, commit: $commit, builtBy: $run, signed: $signed},
    artifacts: $artifacts,
    setup: $declaration[0],
    verify: [
      "Get-FileHash $env:LOCALAPPDATA\\AI17Z-setup\\Setup-AI17Z.checked.ps1 -Algorithm SHA256",
      "Get-FileHash .\\Install-AI17Z-\($version).ps1 -Algorithm SHA256",
      "& ([scriptblock]::Create((irm \($project)/-/raw/main/install.ps1))) -WhatIfOnly"
    ],
    documentation: "\($project)/-/blob/main/docs/SETUP_AUDIT.md"
  }' > "AI17Z-Setup-Audit-$VERSION.json"
# The declaration was an input, not an asset.
rm -f setup-declaration.json
cat "AI17Z-Setup-Audit-$VERSION.json"

say "sign what was built"
# Sigstore keyless signing with this pipeline's own GitLab identity: a bundle
# per file saying these exact bytes came out of this project's pipeline, run
# from this tag. Verifiable by anybody with cosign against that identity, and
# never required to install AI17Z.
#
# It is **not** Apple notarization and **not** Debian archive signing, and the
# documentation says so in those words.
#
# Required. On GitHub the equivalent step once named paths belonging to a
# different job, failed, and `continue-on-error` rendered that green: Beta 1.0.0
# (16) shipped saying it carried build provenance while every asset answered
# 404. A release that cannot be signed is a release that does not get
# published. And not skipped on a rehearsal, because a signature is a statement
# about bytes this pipeline really built, as true of a rehearsal as a release.
[ -n "${SIGSTORE_ID_TOKEN:-}" ] || { echo "no SIGSTORE_ID_TOKEN: this job was not given an id_token"; exit 1; }
SUBJECTS=("${INSTALLABLE[@]}" release-manifest.json "AI17Z-Setup-Audit-$VERSION.json" SHA256SUMS.txt)
for subject in "${SUBJECTS[@]}"; do
  cosign sign-blob --yes --bundle "$subject.sigstore.json" "$subject" >/dev/null
  echo "  signed $subject"
done
IDENTITY="$SERVER/$PROJECT//.gitlab-ci.yml@refs/tags/${CI_COMMIT_TAG:-$TAG}"
for subject in "${SUBJECTS[@]}"; do
  cosign verify-blob "$subject" --bundle "$subject.sigstore.json" \
    --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$SERVER" >/dev/null 2>&1 \
    || { echo "  $subject does not verify against $IDENTITY"; exit 1; }
done
echo "  every signature verifies against $IDENTITY"

say "release notes"
( cd "$PROJECT_DIR" && bash "$HERE/release-notes.sh" "$VERSION" "$DIST/SHA256SUMS.txt" "${HAVE_MACOS:+macos}" ) > release-notes.md
cat release-notes.md

ASSETS=("${INSTALLABLE[@]}" release-manifest.json "AI17Z-Setup-Audit-$VERSION.json" SHA256SUMS.txt release-notes.md)
cp "$PROJECT_DIR/docs/RELEASE_VALIDATION_REPORT.md" RELEASE_VALIDATION_REPORT.md
ASSETS+=(RELEASE_VALIDATION_REPORT.md)
for subject in "${SUBJECTS[@]}"; do ASSETS+=("$subject.sigstore.json"); done

if [ -n "$REHEARSAL" ]; then
  # A rehearsal gets everything except the release. The finished directory is
  # kept as the job's artifacts, so what would have been published can be
  # downloaded and looked at. Nothing is uploaded and no release is created.
  {
    echo "Nothing was published. A release from this commit would have attached:"
    echo
    ls -1 -s --block-size=K "${ASSETS[@]}"
    echo
    echo "SHA256SUMS.txt:"
    cat SHA256SUMS.txt
    echo
    echo "release-manifest.json, in summary:"
    jq -r '
      "  version \(.version)  tag \(.tag)  schema \(.schemaVersion)",
      "  commit \(.commit)",
      (.platforms | to_entries[] |
        "  \(.key): supported=\(.value.supported) arch=\(.value.architectures | join(","))\(if .value.notBuilt then "  (\(.value.notBuilt))" else "" end)"),
      "  artifacts: \(.artifacts | length)"
    ' release-manifest.json
  } | bash "$HERE/say-out.sh" "Rehearsal of $VERSION"
  exit 0
fi

say "upload every file to the package registry"
# Generic packages, one per release, named ai17z at the version. The job token
# can write only to this project.
for name in "${ASSETS[@]}"; do
  curl -fsS --retry 3 -H "JOB-TOKEN: $CI_JOB_TOKEN" --upload-file "$name" \
    "$API/packages/generic/ai17z/$VERSION/$name" >/dev/null
  echo "  uploaded $name"
done

say "the release"
# Every file linked at its own name, so `/-/releases/<tag>/downloads/<name>` is
# the address of each, which is the address every installer composes. The full
# installer stays the only `.exe`, because installations from before AI17Z
# Setup existed picked the first one.
NAME="${RELEASE_NAME:-AI17Z $VERSION}"
LINKS="$(for name in "${ASSETS[@]}"; do
  case "$name" in
    *.sigstore.json|SHA256SUMS.txt|release-manifest.json|AI17Z-Setup-Audit-*|release-notes.md|RELEASE_VALIDATION_REPORT.md) type=other ;;
    *) type=package ;;
  esac
  jq -n --arg n "$name" --arg u "$API/packages/generic/ai17z/$VERSION/$name" --arg t "$type" \
    '{name: $n, url: $u, direct_asset_path: ("/" + $n), link_type: $t}'
done | jq -s .)"
jq -n --arg tag "$TAG" --arg name "$NAME" --rawfile notes release-notes.md --argjson links "$LINKS" \
  '{tag_name: $tag, name: $name, description: $notes, assets: {links: $links}}' > release-request.json
curl -fsS --retry 3 -H "JOB-TOKEN: $CI_JOB_TOKEN" -H 'Content-Type: application/json' \
  --data @release-request.json "$API/releases" > release-response.json
jq -r '"  released \(.name) at \(._links.self // .tag_name)"' release-response.json
rm -f release-request.json release-response.json
