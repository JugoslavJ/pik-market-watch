# syntax=docker/dockerfile:1
# Dependencies use no native addons, so Alpine is sufficient.
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a

ENV NODE_ENV=production

WORKDIR /app

# Copy dependency manifests first to cache installation across source edits.
COPY package.json package-lock.json ./
COPY collector/package.json ./collector/
COPY db/package.json ./db/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

RUN addgroup -S -g 10001 scraper && adduser -S -u 10001 -G scraper scraper \
 && chown -R scraper:scraper /app
USER scraper

COPY --chown=scraper:scraper collector/src ./collector/src
COPY --chown=scraper:scraper collector/scripts ./collector/scripts
COPY --chown=scraper:scraper db/src ./db/src

WORKDIR /app/collector

CMD ["node", "src/index.js"]

