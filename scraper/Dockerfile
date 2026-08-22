# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Slim alternative to the official Playwright image, which ships Chromium +
# Firefox + WebKit (≈ 3.3 GB total). We drive Chromium only.
#
# Version sync rule: the "playwright" version pinned in package.json picks the
# Chromium build installed below — npm ci installs exactly that CLI version,
# whose `install` command then fetches the matching browser.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

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

# Non-root; --create-home gives Chromium a writable HOME for crashpad/font caches.
RUN useradd --create-home --uid 10001 scraper \
 && mkdir -p /opt/ms-playwright \
 && chown scraper:scraper /opt/ms-playwright \
 && chown -R scraper:scraper /app
USER scraper

# Downloaded as `scraper`, so /opt/ms-playwright needs no ownership fix-up.
# Headless shell ONLY: it's the binary Playwright uses for headless:true launches
# (~400 MB smaller than the full Chromium build). Headed mode (HEADLESS=0) is
# therefore unavailable — it had no display server in the container anyway.
RUN npx playwright install chromium --only-shell

# App source LAST: editing src/ no longer busts the ~400 MB Chromium layer
# above, so CI/CD rebuilds on the server stay fast. --chown replaces the old
# post-COPY `chown -R /app` (the builder sets ownership without re-copying).
COPY --chown=scraper:scraper src ./src

CMD ["node", "src/index.js"]

