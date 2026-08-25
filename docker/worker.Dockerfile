# XBAM worker image.
#
# The tag below MUST match the exact `playwright` version in
# packages/browser/package.json. The image ships the browser binaries for that
# release and nothing else, so a mismatch fails at launch, not at build.
# tests/unit/playwrightVersion.test.ts enforces it.
#
# Built on the Playwright base image because the worker is the only process that
# drives a browser. It is a large image; if you never use a browser channel, set
# XBAM_BROWSER_ENABLED=0 and the worker will refuse browser work cleanly instead
# of failing halfway through a job.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/jobs/package.json ./packages/jobs/
COPY packages/models/package.json ./packages/models/
COPY packages/memory/package.json ./packages/memory/
COPY packages/prompts/package.json ./packages/prompts/
COPY packages/channels/package.json ./packages/channels/
COPY packages/browser/package.json ./packages/browser/
COPY packages/tools/package.json ./packages/tools/
COPY packages/runtime/package.json ./packages/runtime/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY tools/import-ai4cz/package.json ./tools/import-ai4cz/
RUN npm ci --omit=dev --ignore-scripts --workspace @xbam/worker --include-workspace-root

COPY tsconfig.json tsconfig.base.json ./
COPY migrations ./migrations
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY tools ./tools

RUN mkdir -p /data/storage /data/browser-profiles && chown -R pwuser:pwuser /data /app
USER pwuser
CMD ["npm", "run", "start:worker"]
