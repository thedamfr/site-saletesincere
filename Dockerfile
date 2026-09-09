# ─── Stage build ───
FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ─── Stage runtime ───
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --chown=node:node --from=builder /app ./
RUN npm ci --omit=dev
USER node
EXPOSE 3000
CMD ["node", "server.js"]
