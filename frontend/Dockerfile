# FileGrid frontend: standalone Next.js server (ADR-0020). Build off-VPS; `next build` needs > 1 GB RAM.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_MOCKS=0
ARG NEXT_PUBLIC_API_MOCK_GROUPS=
ARG NEXT_PUBLIC_API_BASE=/api/v1
ARG NEXT_PUBLIC_APP_VERSION=dev
ARG NEXT_PUBLIC_GRAFANA_URL=
ARG FILEGRID_ALLOW_MOCKS=0
ENV NEXT_PUBLIC_API_MOCKS=$NEXT_PUBLIC_API_MOCKS NEXT_PUBLIC_API_MOCK_GROUPS=$NEXT_PUBLIC_API_MOCK_GROUPS \
    NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION \
    NEXT_PUBLIC_GRAFANA_URL=$NEXT_PUBLIC_GRAFANA_URL FILEGRID_ALLOW_MOCKS=$FILEGRID_ALLOW_MOCKS
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=160
# P1's manifest runs the frontend as uid/gid 101.
RUN addgroup -S -g 101 app && adduser -S -u 101 -G app app
COPY --from=build --chown=101:101 /app/.next/standalone ./
COPY --from=build --chown=101:101 /app/.next/static ./.next/static
COPY --from=build --chown=101:101 /app/public ./public
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
