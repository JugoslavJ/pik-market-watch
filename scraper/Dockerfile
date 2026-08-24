# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Plain Node image. Since the API cutover the scraper talks to olx.ba's public
# JSON endpoints with fetch() — no Chromium, no Playwright, no OS browser deps
# (that stack was ~1 GB of image and most of the build time).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so this layer caches; BuildKit cache mount speeds rebuilds.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && npm cache clean --force

# Non-root runtime user.
RUN useradd --create-home --uid 10001 scraper && chown -R scraper:scraper /app
USER scraper

# App source LAST so dependency layers stay cached across code edits.
COPY --chown=scraper:scraper src ./src
COPY --chown=scraper:scraper scripts ./scripts

CMD ["node", "src/index.js"]


