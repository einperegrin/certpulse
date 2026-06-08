#!/bin/sh
# docker-entrypoint.sh — drop to the unprivileged "nginx" user before
# starting nginx so the web container does not run as root.
#
# Alpine's nginx package ships a "nginx" user (UID 101). The official
# image runs as root, which conflicts with our hardening goal.
set -e
if [ "$(id -u)" = "0" ]; then
  exec su-exec nginx "$@"
fi
exec "$@"
