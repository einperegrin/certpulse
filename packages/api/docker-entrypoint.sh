#!/bin/sh
# SSLert api entrypoint.
#
# The api image runs as a dedicated unprivileged user (UID/GID 10001),
# but /app/data is a named volume that may be owned by root — either
# because the volume was provisioned for the first time, or because it
# was created by an older image (pre-v0.3) that ran as root. Either case
# makes SQLite return SQLITE_READONLY_DIRECTORY on the first PRAGMA and
# the api restarts indefinitely.
#
# Fix the ownership here, before exec-ing the node process. The chown is
# idempotent: a no-op on a correctly-provisioned volume, and a one-time
# repair on a volume inherited from a previous release. We then drop to
# the unprivileged user with setpriv (a util-linux builtin) so the node
# process can never write outside /app/data.
set -eu

DATA_DIR="/app/data"

# Make sure the directory exists. The Dockerfile already creates it,
# but operators who bind-mount a host directory into /app/data may land
# here with nothing in place.
mkdir -p "${DATA_DIR}"

# Repair ownership on every startup. On an empty volume this touches
# one inode; on a populated one it is a single chown. We do NOT chmod:
# chmod on a file we do not own requires CAP_FOWNER, which we do not
# grant. chown only needs CAP_CHOWN, whitelisted in docker-compose.yml.
# chown is a no-op when the file is already owned by UID 10001.
chown -R 10001:10001 "${DATA_DIR}"

# Drop to the unprivileged user. setpriv is in util-linux, shipped by
# default in the node bookworm-slim base image, and unlike gosu/su-exec
# it does not need a separate package install. --init-groups pulls any
# supplementary groups for UID 10001 (sslert has only the primary
# group, so this is just defensive). The compose file grants
# CAP_SETUID + CAP_SETGID for this single setresuid() call; with
# no-new-privileges:true those caps are not inherited by any child.
exec setpriv --reuid=10001 --regid=10001 --init-groups -- node dist/index.js
