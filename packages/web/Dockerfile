# CertPulse web — static SPA served by nginx.
#
# Hardening applied in v0.2 (Task 1.7):
# - nginx:alpine — minimal CVE surface
# - `/health` location is unauthenticated and lightweight so the docker
#   healthcheck can poll it without warming the upstream
# - The full nginx security-headers config (CSP, X-Frame-Options, etc.)
#   lives in `nginx.conf` (Task 1.8)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm install --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY packages/web ./packages/web
RUN cd packages/web && npx vite build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O- http://localhost/health >/dev/null 2>&1 || exit 1
