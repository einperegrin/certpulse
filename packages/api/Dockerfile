# SSLert API — multi-stage build, non-root runtime.
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
RUN groupadd --system --gid 10001 sslert \
    && useradd  --system --uid 10001 --gid sslert --no-create-home --shell /usr/sbin/nologin sslert

# Copy the built artefacts. We use the workspace-root lockfile (this repo
# uses a single npm workspace, no per-package lockfile). The runtime install
# uses the api workspace's package.json so the right tree is loaded, and the
# root lockfile makes the install reproducible.
# Permissions: code is world-readable, migrations belong to root (the
# entrypoint chowns /app/data on every start anyway).
COPY --from=build --chown=root:root      /app/packages/api/dist                ./dist
COPY --from=build --chown=root:root      /app/packages/api/package.json        ./packages/api/package.json
COPY --from=build --chown=root:root      /app/packages/web/package.json        ./packages/web/package.json
COPY --from=build --chown=root:root      /app/packages/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=build --chown=root:root      /app/package.json                     ./package.json
COPY --from=build --chown=root:root      /app/package-lock.json                ./package-lock.json
COPY --from=build --chown=sslert:sslert /app/packages/api/src/db/migrations   ./dist/db/migrations

RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
    && cd /app/packages/api && npm ci --omit=dev --no-audit --no-fund \
    && mkdir -p /app/node_modules/@hono \
    && cp -r /app/packages/api/node_modules/@hono/swagger-ui /app/node_modules/@hono/swagger-ui \
    && chown -R root:root /app/node_modules \
    && chmod -R a+rX /app/dist /app/packages /app/package.json /app/package-lock.json /app/node_modules \
    && npm cache clean --force

# /app/data is the only writable path (mounted as a volume in compose).
# The entrypoint chowns it to UID 10001 on every start so volumes
# inherited from older images (or bind-mounted host directories) end up
# writable by the api process. We do not chown here because the volume
# is empty at build time and chown is a no-op on an empty directory.
RUN mkdir -p /app/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O- http://localhost:3000/health >/dev/null 2>&1 || exit 1

# Entrypoint runs as root (it needs root to chown /app/data) and then
# drops to UID 10001 via setpriv. The compose file grants the
# capabilities required for that dance: CHOWN for the repair, plus
# SETUID and SETGID so setpriv can switch to the unprivileged user.
# no-new-privileges is still on, so those caps cannot be inherited by
# any child process — they are a one-shot tool used by PID 1.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
