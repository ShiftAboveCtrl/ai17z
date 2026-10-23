#!/bin/bash
# The release's check job, step for step, from a clean clone of the public tag.
set -euo pipefail
TAG="${1:?tag}"
git clone -q https://code.ai17z.io/AI17Z/ai17z.git /src && cd /src && git checkout -q "$TAG"
echo "checking $TAG at $(git rev-parse HEAD)"
export AI17Z_MASTER_KEY=dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMhISE= PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm ci --no-audit --no-fund
npm run typecheck
npm run lint
npm run release:check
bash .forgejo/scripts/secret-scan.sh
python3 .forgejo/scripts/history-scan.py .
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx playwright install --with-deps chromium
bash .forgejo/scripts/setup-pwsh.sh
npm run migrate
npx vitest run --reporter=default
npm run build:web
echo "CHECK PASSED $TAG $(git rev-parse HEAD)"
