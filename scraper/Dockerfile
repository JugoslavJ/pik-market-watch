# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Alpine Node image: the scraper talks to olx.ba's public JSON endpoints with
# fetch() — pure JS (pg ships no native addons), so musl costs nothing and
# trims ~100 MB vs bookworm-slim while sharing base layers with the
# postgres:16-alpine images the stack already pulls.
# ─────────────────────────────────────────────────────────────────────────────
# Digest pin: reproducible builds regardless of registry tag drift (Dependabot
# bumps tag + digest together).
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so this layer caches; BuildKit cache mount speeds rebuilds.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && npm cache clean --force

# Non-root runtime user (busybox adduser — Alpine has no useradd).
RUN addgroup -S -g 10001 scraper && adduser -S -u 10001 -G scraper scraper \
 && chown -R scraper:scraper /app
USER scraper

# App source LAST so dependency layers stay cached across code edits.
COPY --chown=scraper:scraper src ./src
COPY --chown=scraper:scraper scripts ./scripts

CMD ["node", "src/index.js"]


