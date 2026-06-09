# CertPulse web — static SPA served by nginx.
#
# Hardening applied in v0.2:
# - Task 1.7: nginx:alpine — minimal CVE surface.
# - Task 1.8: nginx config adds CSP + security headers, /health is
#   unauthenticated and lightweight.
# - Task 2.6 (H-5/H-8/H-9): nginx base image pinned by digest, non-root
#   user, no mutable tags in production.
FROM node:22.13.1-bookworm-slim@sha256:83fdfa2a4de32d7f8d79829ea259bd6a4821f8b2d123204ac467fbe3966450fc AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY packages/web ./packages/web
RUN cd packages/web && npx vite build

# Runtime — nginx:alpine with the standard hardening pattern.
# The official image already has `user nginx;` in /etc/nginx/nginx.conf,
# which makes the master process run as root (required to bind port 80)
# and the WORKER processes run as the unprivileged "nginx" user (UID 101).
# The master never reads/writes request data — only the workers do.
FROM nginx:1.27.3-alpine@sha256:814a8e88df978ade80e584cc5b333144b9372a8e3c98872d07137dbf3b44d0e4 AS runtime

# Make the writable paths (cache, logs, html) owned by the nginx user so
# workers can write to them; the config is owned by root so it can't be
# mutated by the worker process.
RUN chown -R nginx:nginx /var/cache/nginx /var/log/nginx /usr/share/nginx/html
COPY --from=build --chown=nginx:nginx /app/packages/web/dist /usr/share/nginx/html
COPY --chown=root:root packages/web/nginx.conf /etc/nginx/conf.d/default.conf

# Install the hardened entrypoint. The stock nginx image has no
# entrypoint of its own — without this, `docker-entrypoint.sh` would
# never run in production and the docker-image-level hardening would
# not be applied. (Copilot review: packages/web/Dockerfile:38.)
COPY --chown=root:root --chmod=0755 packages/web/docker-entrypoint.sh /docker-entrypoint.sh

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -q -O- http://localhost/health >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
