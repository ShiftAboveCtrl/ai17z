#!/bin/bash
# The release's publish job in rehearsal mode: hashes, manifest, audit, cosign
# signatures verified against .forgejo/cosign.pub, notes. Uploads nothing.
set -euo pipefail
TAG="${1:?tag}"; VERSION="${TAG#v}"
apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates nodejs >/dev/null
git clone -q https://code.ai17z.io/AI17Z/ai17z.git /src && cd /src && git checkout -q "$TAG"
bash .forgejo/scripts/setup-ubuntu-job.sh
bash .forgejo/scripts/setup-cosign.sh
npm ci --no-audit --no-fund
rm -rf dist && cp -r /in dist
[ -f dist/release.env ] && . dist/release.env && export RELEASE_NAME && rm -f dist/release.env
export COSIGN_PRIVATE_KEY="$(cat /keys/key)" COSIGN_PASSWORD="$(cat /keys/password)"
bash .forgejo/scripts/publish-release.sh dist "$VERSION" rehearsal
rm -rf /dist-out/* && cp -r dist/. /dist-out/
