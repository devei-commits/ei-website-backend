# Production API image: deps baked in (no `npm install` on every `compose up`).
FROM node:20-bookworm-slim AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:20-bookworm-slim AS runner
WORKDIR /usr/src/app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p logs && chown -R node:node /usr/src/app/logs
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=5 \
  CMD curl -sf http://127.0.0.1:3001/api/v1/health || exit 1
# `docker compose` overrides CMD (seed + pm2-runtime).
CMD ["node", "app.js"]
