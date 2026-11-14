# syntax=docker/dockerfile:1.7
# FileGrid PPC backend (NestJS). Build context: backend/
# One Node process per container; scale with replicas.

FROM node:26-slim AS build
WORKDIR /app
ENV npm_config_audit=false npm_config_fund=false
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Migrations first (Kysely holds a Postgres advisory lock, so replicas take turns), then the API.
CMD ["sh", "-c", "node dist/database/migrate.js && exec node dist/main.js"]
