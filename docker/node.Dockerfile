# XBAM API image.
#
# Internal packages are TypeScript source executed by tsx, so there is no build
# step to keep in sync: what runs in the container is the file you edited.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Every workspace manifest, so `npm ci` sees the whole graph before sources land.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY packages/jobs/package.json ./packages/jobs/
COPY packages/models/package.json ./packages/models/
COPY packages/memory/package.json ./packages/memory/
COPY packages/persona/package.json ./packages/persona/
COPY packages/prompts/package.json ./packages/prompts/
COPY packages/channels/package.json ./packages/channels/
COPY packages/browser/package.json ./packages/browser/
COPY packages/tools/package.json ./packages/tools/
COPY packages/runtime/package.json ./packages/runtime/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY tools/import-ai4cz/package.json ./tools/import-ai4cz/
RUN npm ci --omit=dev --ignore-scripts --workspace @xbam/api --include-workspace-root

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY migrations ./migrations
COPY packages ./packages
COPY apps/api ./apps/api
COPY tools ./tools

RUN mkdir -p /data/storage && chown -R node:node /data /app
USER node
EXPOSE 8787
CMD ["npm", "run", "start:api"]
