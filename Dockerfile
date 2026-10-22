# ─── Stage build ───
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY server.js style.css postcss.config.js ./
COPY content ./content
COPY scripts/build-author.mjs ./scripts/build-author.mjs
COPY scripts/lib ./scripts/lib
COPY server ./server
COPY public ./public
COPY sql ./sql
COPY scripts/migrate.js ./scripts/migrate.js
COPY scripts/delivery/readiness.mjs ./scripts/delivery/readiness.mjs
RUN npm run build

# ─── Stage runtime ───
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --chown=node:node --from=builder /app ./
RUN npm ci --omit=dev
ARG SOURCE_COMMIT
ENV RELEASE_COMMIT=$SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
USER node
EXPOSE 3000
CMD ["node", "server.js"]
