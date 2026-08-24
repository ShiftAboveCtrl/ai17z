# XBAM web image: a static bundle behind nginx, which also proxies /api.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ARG VITE_XBAM_API_URL=""
ENV VITE_XBAM_API_URL=$VITE_XBAM_API_URL

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
# esbuild resolves its platform binary through optional deps, but let scripts run
# so a build failure here surfaces at image build time rather than at runtime.
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npm --workspace @xbam/web run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
