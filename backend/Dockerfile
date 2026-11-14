# syntax=docker/dockerfile:1.7
# FileGrid PPC backend (NestJS). Build context: backend/
# One Node process per container; scale with replicas.

FROM node:26-slim AS build
WORKDIR /app
ENV npm_config_audit=false npm_config_fund=false
COPY package.json package-lock.json ./
# No install scripts and no optional packages: the image needs neither (they are the embedded test
# Postgres and native file watchers of the test tools), and a slim image has no compiler for them.
RUN npm ci --ignore-scripts --omit=optional
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# uid/gid 10001: the pod's securityContext (deploy/k8s/app/backend/deployment.yaml) runs as 10001.
RUN groupadd --gid 10001 filegrid && useradd --uid 10001 --gid 10001 --no-create-home filegrid
USER 10001:10001
# The pod limit is 384Mi: keep the V8 heap well below it (streams keep memory flat anyway).
ENV NODE_OPTIONS=--max-old-space-size=192
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Migrations first (Kysely holds a Postgres advisory lock, so replicas take turns), then the API.
CMD ["sh", "-c", "node dist/database/migrate.js && exec node dist/main.js"]
