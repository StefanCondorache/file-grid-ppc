# FileGrid PPC meter simulator. Build context: simulator/
# Zero runtime dependencies: Node 26 runs the TypeScript sources directly (type stripping).
FROM node:26-alpine
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=96
WORKDIR /app
COPY package.json ./
COPY src ./src
# uid/gid 10001: the pod's securityContext (deploy/k8s/app/simulator/deployment.yaml).
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]
