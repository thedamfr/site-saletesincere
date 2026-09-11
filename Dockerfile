# ─── Stage build ───
FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY server.js style.css postcss.config.js ./
COPY server ./server
COPY public ./public
COPY sql ./sql
COPY scripts/migrate.js ./scripts/migrate.js
COPY scripts/delivery/readiness.mjs ./scripts/delivery/readiness.mjs
RUN npm run build

# ─── Stage runtime ───
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --chown=node:node --from=builder /app ./
RUN npm ci --omit=dev
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
USER node
EXPOSE 3000
CMD ["node", "server.js"]
