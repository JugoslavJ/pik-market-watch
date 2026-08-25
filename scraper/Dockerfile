# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Plain Node image: the scraper talks to olx.ba's public JSON endpoints with
# fetch() — no browser or OS-level dependencies required.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim

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


