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

# Runtime — nginx as a non-root user. We use the alpine image and run
# nginx in the foreground via a custom entrypoint that drops privs.
FROM nginx:1.27.3-alpine@sha256:814a8e88df978ade80e584cc5b333144b9372a8e3c98872d07137dbf3b44d0e4 AS runtime

# nginx:alpine ships with a built-in "nginx" user (UID 101); we just
# ensure the writable paths are owned by it.
RUN chown -R nginx:nginx /var/cache/nginx /var/log/nginx /usr/share/nginx/html
COPY --from=build --chown=nginx:nginx /app/packages/web/dist /usr/share/nginx/html
COPY --chown=root:root packages/web/nginx.conf /etc/nginx/conf.d/default.conf
# Custom entrypoint that execs nginx as the unprivileged "nginx" user.
COPY --chown=root:root packages/web/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -q -O- http://localhost/ >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
