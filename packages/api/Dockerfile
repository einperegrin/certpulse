# CertPulse API — multi-stage build, non-root runtime.
#
# Hardening applied in v0.2 (Task 1.7):
# - Multi-stage build keeps the runtime image lean (no tsc, no devDeps)
# - Runs as a dedicated unprivileged user (UID 10001), not root
# - Uses `node:22-bookworm-slim` — minimal CVE surface, glibc-based
#   (so better-sqlite3 prebuilt binary just works)
# - `ca-certificates` is the only apt package installed; cached clean.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm install --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY packages/api ./packages/api
RUN cd packages/api && npx tsc -p tsconfig.json

# Runtime image — non-root user, read-only root FS friendly.
# The compose file mounts a writable volume at /app/data for the SQLite
# file; everything else can be read-only. Healthcheck hits /health.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dedicated unprivileged user. UID 10001 sits well clear of the host
# user space (Debian allocates UIDs starting at 1000, Linux kernel
# default for new users is 1000+).
RUN groupadd --system --gid 10001 certpulse \
    && useradd  --system --uid 10001 --gid certpulse --no-create-home --shell /usr/sbin/nologin certpulse

COPY --from=build /app/packages/api/dist          ./dist
COPY --from=build /app/packages/api/package.json  ./package.json
COPY --from=build /app/packages/api/src/db/migrations ./dist/db/migrations
RUN npm install --omit=dev --no-audit --no-fund

# /app/dist and /app/node_modules are owned by root, read-only at runtime.
# /app/data is the only writable path (mounted as a volume in compose).
RUN mkdir -p /app/data && chown -R certpulse:certpulse /app/data

USER certpulse
EXPOSE 3000
CMD ["node", "dist/index.js"]
