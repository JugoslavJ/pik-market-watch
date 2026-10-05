# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Alpine Node image: the scraper talks to olx.ba's public JSON endpoints with
# fetch() — pure JS (pg ships no native addons), so musl costs nothing and
# trims ~100 MB vs bookworm-slim while sharing base layers with the
# PostgreSQL 18 images the stack already pulls.
# ─────────────────────────────────────────────────────────────────────────────
# Digest pin: reproducible builds regardless of registry tag drift (Dependabot
# bumps tag + digest together).
FROM node:26-alpine@sha256:dbaa92e5758cbbcf85d65d5403fdb530fe3442cbe8c6dbfb7ef23365450d5070

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so this layer caches; BuildKit cache mount speeds rebuilds.
COPY package.json package-lock.json ./
COPY collector/package.json ./collector/
COPY db/package.json ./db/
COPY config/package.json ./config/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# Non-root runtime user (busybox adduser — Alpine has no useradd).
RUN addgroup -S -g 10001 scraper && adduser -S -u 10001 -G scraper scraper \
 && chown -R scraper:scraper /app
USER scraper

# App source LAST so dependency layers stay cached across code edits.
COPY --chown=scraper:scraper collector/src ./collector/src
COPY --chown=scraper:scraper collector/scripts ./collector/scripts
COPY --chown=scraper:scraper db/src ./db/src
COPY --chown=scraper:scraper db/scripts/benchmark-ingestion.js ./db/scripts/
COPY --chown=scraper:scraper config/env.js ./config/

WORKDIR /app/collector

CMD ["node", "src/index.js"]

