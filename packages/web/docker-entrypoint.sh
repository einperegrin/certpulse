#!/bin/sh
# docker-entrypoint.sh — start nginx.
#
# Hardening approach (H-5): we DO NOT drop the master process to a
# non-root user. The master process needs to bind port 80, which requires
# root (or CAP_NET_BIND_SERVICE). Instead, we configure nginx to drop
# privileges for the WORKER processes via the `user nginx;` directive
# (see nginx.conf). The master stays root (required to bind 80) but
# serves no request data — the workers (running as UID 101 "nginx") do.
# This is the standard nginx Docker-hardening pattern: root master,
# unprivileged workers, and master never reads/writes request data.
set -e
exec "$@"
