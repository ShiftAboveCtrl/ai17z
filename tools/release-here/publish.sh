#!/bin/bash
# The release's publish job in rehearsal mode: hashes, manifest, audit, cosign
# signatures verified against ci/cosign.pub, notes. Uploads nothing.
set -euo pipefail
TAG="${1:?tag}"; VERSION="${TAG#v}"
apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates nodejs >/dev/null
git clone -q https://code.ai17z.io/AI17Z/ai17z.git /src && cd /src && git checkout -q "$TAG"
bash ci/scripts/setup-ubuntu-job.sh
bash ci/scripts/setup-cosign.sh
npm ci --no-audit --no-fund
rm -rf dist && cp -r /in dist
# Read as text, never sourced, exactly as the release workflow does.
if [ -f dist/release.env ]; then RELEASE_NAME="$(bash ci/scripts/read-release-name.sh dist/release.env)"; export RELEASE_NAME; fi
# Read from files mounted for this run only; never written into the image.
key_text="$(cat /keys/key)"; key_pass="$(cat /keys/password)"
export COSIGN_PRIVATE_KEY="${key_text}" COSIGN_PASSWORD="${key_pass}"
bash ci/scripts/publish-release.sh dist "$VERSION" rehearsal
rm -rf /dist-out/* && cp -r dist/. /dist-out/
