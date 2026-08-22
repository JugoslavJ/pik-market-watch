# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Slim alternative to the official Playwright image, which ships Chromium +
# Firefox + WebKit (≈ 3.3 GB total). We drive Chromium only.
#
# Version sync rule: the "playwright" version pinned in package.json picks the
# Chromium build installed below — npm ci installs exactly that CLI version,
# whose `install` command then fetches the matching browser.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

WORKDIR /app

# Dependencies first so this layer caches; BuildKit cache mount speeds rebuilds.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && npm cache clean --force

# Chromium's OS libraries only (needs root). The browser binaries themselves are
# downloaded AFTER switching to the unprivileged user below — doing it here and
# chown-ing afterwards would copy every byte into an extra layer (+~900 MB).
RUN npx playwright install-deps chromium \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY src ./src

# Non-root; --create-home gives Chromium a writable HOME for crashpad/font caches.
RUN useradd --create-home --uid 10001 scraper \
 && mkdir -p /opt/ms-playwright \
 && chown scraper:scraper /opt/ms-playwright \
 && chown -R scraper:scraper /app
USER scraper

# Downloaded as `scraper`, so /opt/ms-playwright needs no ownership fix-up.
RUN npx playwright install chromium

CMD ["node", "src/index.js"]

