# syntax=docker/dockerfile:1

# Guardian Integration Gateway: production image.
# Secrets never enter the image: AUDIT_ENCRYPTION_KEY and AUDIT_USER_REF_KEY are injected at runtime
# (docker-compose.yml reads them from the environment or a local .env used only for interpolation).

# ---- build: full dependency tree, TypeScript compile ----
FROM node:24.19-alpine AS build
WORKDIR /app

# Dependencies first so source edits do not invalidate the npm ci layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies and compiled output only ----
FROM node:24.19-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# Application files stay root-owned, so the runtime user cannot modify the code it runs.
COPY --from=build /app/dist ./dist

# The only writable path: the audit store directory, private to the runtime user (mount a volume here).
RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 0700 /app/data

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM

# Alpine ships no curl: probe with Node's built-in fetch. Exits 0 only on a 2xx from /health.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --start-interval=2s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`, { signal: AbortSignal.timeout(2500) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form: node receives SIGTERM directly and drains in-flight audit writes before exiting.
CMD ["node", "dist/main.js"]
