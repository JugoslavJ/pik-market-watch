# Playwright base image ships Chromium + all required OS libraries.
# IMPORTANT: this tag must exactly match the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
ENV NODE_ENV=production

# Install runtime deps first so Docker can cache this layer
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

CMD ["node", "src/index.js"]
