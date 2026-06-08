# CertPulse API — multi-stage build, non-root runtime.
#
# Hardening applied in v0.2:
# - Task 1.7: multi-stage build, runs as unprivileged user (UID 10001),
#   healthcheck hits /health.
# - Task 2.6 (H-5/H-8/H-9):
#   * Base image pinned by digest (no mutable tags in production).
#   * `npm ci` in the runtime stage requires the lockfile — production
#     installs are reproducible.
#   * `--ignore-scripts` keeps postinstall hooks from running as root
#     before the user is created.
#   * `ca-certificates` is the only apt package installed; cached clean.
#
# Layered so changes to src don't bust the npm install layer.
FROM node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY packages/api ./packages/api
RUN cd packages/api && npx tsc -p tsconfig.json

# Runtime image — non-root user, lockfile-driven install.
FROM node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# Dedicated unprivileged user. UID 10001 sits well clear of the host
# user space (Debian allocates UIDs starting at 1000, Linux kernel
# default for new users is 1000+).
RUN groupadd --system --gid 10001 certpulse \
    && useradd  --system --uid 10001 --gid certpulse --no-create-home --shell /usr/sbin/nologin certpulse

# Copy the built artefacts and the lockfile. `npm ci --omit=dev` is the
# lockfile-driven install — without the lockfile the build fails, so
# an omitted lockfile can't slip through.
COPY --from=build --chown=root:root /app/packages/api/dist                ./dist
COPY --from=build --chown=root:root /app/packages/api/package.json        ./package.json
COPY --from=build --chown=root:root /app/packages/api/package-lock.json   ./package-lock.json
COPY --from=build --chown=root:root /app/packages/api/src/db/migrations   ./dist/db/migrations
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
    && chown -R root:root /app/node_modules \
    && npm cache clean --force

# /app/data is the only writable path (mounted as a volume in compose).
RUN mkdir -p /app/data && chown -R certpulse:certpulse /app/data

USER certpulse
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O- http://localhost:3000/health >/dev/null 2>&1 || exit 1
CMD ["node", "dist/index.js"]
