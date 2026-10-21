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
#   AI17Z-macos-<arch>-<version>.tar.gz  macOS, Apple silicon and Intel
#   install-ai17z-{macos,ubuntu}.sh the readable installers, from this tag
#   release-manifest.json           what the release is, for updaters
#   AI17Z-Setup-Audit-<version>.json   what the setup program declares it may do
#   SHA256SUMS.txt                  hashes for every installable file above
#   <file>.sigstore.json            a Sigstore bundle for every file above
#
# **There is no signing lane, and no signed executable.** Code signing for
# open-source projects is granted on the strength of an existing user base, and
# AI17Z applied and was turned down for not having one yet. The Sigstore bundles
# are release provenance, not a platform signature: they answer "was this
# signed by AI17Z's release key", recorded in the public transparency log, not
# "has a vendor vouched for it", and the documentation says so in those words.
# See docs/WINDOWS_TRUST.md.
#
# Published to AI17Z Code, the project's own Forgejo, as a release whose files
# are attached to it. The release is created as a draft, which nobody without
# write access can see; every file is attached once; the list of attachments is
# checked against the list of files; and only then is the draft published. A
# release that already exists is refused rather than added to, because Forgejo
# accepts a second attachment with a name the release already has.
set -euo pipefail

DIST="$(cd "${1:?the directory the build artifacts are in}" && pwd)"
VERSION="${2:?the version, without the leading v}"
REHEARSAL="${3:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The checkout, which is where npx and the repository files are. Named once,
# because everything after the first `cd` below runs inside the release directory.
PROJECT_DIR="${GITHUB_WORKSPACE:-$(cd "$HERE/../.." && pwd)}"
TAG="v${VERSION}"
# Forgejo Actions sets the GITHUB_* names for compatibility; outside a runner
# these default to AI17Z Code itself.
SERVER="${GITHUB_SERVER_URL:-https://code.ai17z.io}"
PROJECT="${GITHUB_REPOSITORY:-AI17Z/ai17z}"
API="$SERVER/api/v1/repos/$PROJECT"
RUN="${GITHUB_RUN_NUMBER:+$SERVER/$PROJECT/actions/runs/$GITHUB_RUN_NUMBER}"
COMMIT="${GITHUB_SHA:-$(git rev-parse HEAD)}"
SIGNER_PUB="$PROJECT_DIR/.forgejo/cosign.pub"
# The one sentence a release without macOS carries, in its manifest and notes.
MACOS_NOT_BUILT="macOS packages are built on a Mac registered with AI17Z Code as a release runner, and none was available for this release, so it has none. A Mac already running AI17Z keeps the version it has."
# The sentence a release carries for a package the assembled job refused,
# because it needed a native file no machine of that processor has built and
# run. The installers and updaters on that machine take the newest release that
# has one.
ASSEMBLED_NOT_BUILT="This package needs a native file that no machine of its processor has built and tested yet, so it was not published for this release. Installations on that machine stay on, or install, the newest release that has one."

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
# What the assembled job refused, one <platform>:<arch> a line. It is a build
# record, not something to publish.
ABSENT=""
if [ -f absent-packages.txt ]; then
  ABSENT="$(grep -E '^(macos|ubuntu):(arm64|x64)$' absent-packages.txt | paste -sd, -)"
  rm -f absent-packages.txt
fi
absent_count=0; [ -n "$ABSENT" ] && absent_count="$(printf '%s' "$ABSENT" | tr ',' '\n' | wc -l | tr -d ' ')"

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
# One Windows zip, two Debian packages and two Mac packages, less any the
# assembled job refused and said so. A glob that matched nothing would
# otherwise be a loop that ran nothing and a step that passed.
expected=$((3 - absent_count)); [ -n "$HAVE_MACOS" ] && expected=$((5 - absent_count))
echo "scanned $scanned package(s)"
[ "$scanned" -eq "$expected" ] || { echo "expected $expected packages, scanned $scanned"; exit 1; }

say "the release manifest"
# Built here, from the directory the release is attached out of, so its hashes
# are the ones somebody will actually get. Every asset name in it comes from
# @xbam/shared, which is the only place one is composed. A release without macOS
# says so in its manifest, with the reason, rather than looking like a release
# that lost a package.
( cd "$PROJECT_DIR" && if [ -n "$HAVE_MACOS" ] && [ -n "$ABSENT" ]; then
    npx tsx tools/release-manifest.mts --dist "$DIST" --version "$VERSION" --commit "$COMMIT" ${RUN:+--run "$RUN"} \
      --absent "$ABSENT" --not-built "$ASSEMBLED_NOT_BUILT"
  elif [ -n "$HAVE_MACOS" ]; then
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
      "& ([scriptblock]::Create((irm \($project)/raw/branch/main/install.ps1))) -WhatIfOnly"
    ],
    documentation: "\($project)/src/branch/main/docs/SETUP_AUDIT.md"
  }' > "AI17Z-Setup-Audit-$VERSION.json"
# The declaration was an input, not an asset.
rm -f setup-declaration.json
cat "AI17Z-Setup-Audit-$VERSION.json"

say "sign what was built"
# Signed with AI17Z's release key, whose public half is .forgejo/cosign.pub in
# this repository, and every signature recorded in Sigstore's public
# transparency log: a bundle per file saying these exact bytes were signed by
# that key, and when. Verifiable by anybody with cosign and that public key, and
# never required to install AI17Z.
#
# Keyed, not keyless. Keyless signing binds a signature to a pipeline's own
# identity, which needs an identity provider the public Sigstore instance
# trusts; it trusts GitHub's and GitLab's and not a self-hosted Forgejo's. The
# key lives only in this repository's Actions secrets, which no workflow run
# from a fork is ever given.
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
[ -n "${COSIGN_PRIVATE_KEY:-}" ] && [ -n "${COSIGN_PASSWORD:-}" ] \
  || { echo "no release key: COSIGN_PRIVATE_KEY and COSIGN_PASSWORD are not set for this job"; exit 1; }
[ -f "$SIGNER_PUB" ] || { echo "no public key at $SIGNER_PUB"; exit 1; }
SUBJECTS=("${INSTALLABLE[@]}" release-manifest.json "AI17Z-Setup-Audit-$VERSION.json" SHA256SUMS.txt)
for subject in "${SUBJECTS[@]}"; do
  cosign sign-blob --yes --key env://COSIGN_PRIVATE_KEY --bundle "$subject.sigstore.json" "$subject" >/dev/null 2>&1 \
    || { echo "  could not sign $subject"; exit 1; }
  echo "  signed $subject"
done
for subject in "${SUBJECTS[@]}"; do
  cosign verify-blob "$subject" --bundle "$subject.sigstore.json" --key "$SIGNER_PUB" >/dev/null 2>&1 \
    || { echo "  $subject does not verify against $SIGNER_PUB"; exit 1; }
done
echo "  every signature verifies against .forgejo/cosign.pub and is in the transparency log"

say "release notes"
( cd "$PROJECT_DIR" && ABSENT_PACKAGES="$ABSENT" bash "$HERE/release-notes.sh" "$VERSION" "$DIST/SHA256SUMS.txt" "${HAVE_MACOS:+macos}" ) > release-notes.md
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

say "the release, as a draft"
# The tag must not already have a release. Forgejo would accept a second
# attachment with a name a release already carries, so "upload again" is how a
# release ends up offering two different files under one name. Never retag,
# never add to a published release: a new version is a new tag.
[ -n "${RELEASE_TOKEN:-}" ] || { echo "no RELEASE_TOKEN for this job"; exit 1; }
auth=(-H "Authorization: token $RELEASE_TOKEN")
existing="$(curl -sS -o /dev/null -w '%{http_code}' "${auth[@]}" "$API/releases/tags/$TAG")"
[ "$existing" = 404 ] || { echo "a release for $TAG already exists (HTTP $existing); refusing to add to it"; exit 1; }
NAME="${RELEASE_NAME:-AI17Z $VERSION}"
prerelease=false; case "$VERSION" in *-*) prerelease=true ;; esac
jq -n --arg tag "$TAG" --arg name "$NAME" --arg target "$COMMIT" --rawfile notes release-notes.md --argjson pre "$prerelease" \
  '{tag_name: $tag, target_commitish: $target, name: $name, body: $notes, draft: true, prerelease: $pre}' > release-request.json
curl -fsS --retry 3 "${auth[@]}" -H 'Content-Type: application/json' --data @release-request.json "$API/releases" > release-response.json
RELEASE_ID="$(jq -r '.id' release-response.json)"
[ "$RELEASE_ID" -gt 0 ] 2>/dev/null || { echo "the release was not created"; cat release-response.json; exit 1; }
echo "  draft release $RELEASE_ID for $TAG"

say "attach every file, once"
for name in "${ASSETS[@]}"; do
  curl -fsS --retry 3 "${auth[@]}" -F "attachment=@$name" "$API/releases/$RELEASE_ID/assets?name=$name" >/dev/null
  echo "  attached $name"
done

say "the attachments are exactly the files"
# Names and sizes, both ways. An extra file is as wrong as a missing one.
curl -fsS "${auth[@]}" "$API/releases/$RELEASE_ID" | jq -r '.assets[] | "\(.name)\t\(.size)"' | sort > attached.tsv
for name in "${ASSETS[@]}"; do printf '%s\t%s\n' "$name" "$(stat -c %s "$name")"; done | sort > expected.tsv
if ! diff expected.tsv attached.tsv; then
  echo "  the draft does not hold exactly the files built; it stays a draft and nothing is published"
  exit 1
fi
echo "  $(wc -l < attached.tsv) files, each once, each its built size"

say "publish"
curl -fsS --retry 3 "${auth[@]}" -X PATCH -H 'Content-Type: application/json' --data '{"draft": false}' \
  "$API/releases/$RELEASE_ID" | jq -r '"  released \(.name) at \(.html_url)"'
rm -f release-request.json release-response.json attached.tsv expected.tsv
