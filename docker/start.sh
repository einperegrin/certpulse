#!/bin/sh
# docker/start.sh — PID-1 entrypoint for the combined release image
# (ghcr.io/einperegrin/sslert).
#
# This script is what `tini -- /usr/local/bin/start.sh` execs after
# tini takes over as PID 1. Its job is to get TWO long-lived processes
# running inside the same container:
#
#   1. The Hono API on 127.0.0.1:3000, running as UID 10001.
#   2. nginx on 0.0.0.0:80, with master as root (to bind :80) and
#      workers as www-data.
#
# The api is started in the background; nginx is the foreground process
# (PID 1's direct child) — that way `docker stop` (which sends SIGTERM
# to PID 1) propagates through tini → start.sh → nginx master, which
# gracefully shuts down its workers. Meanwhile, the api's PID is
# captured and killed explicitly on script exit so the container stops
# cleanly without leaving a zombie.
#
# Hardening notes (carried over from the api/web compose services):
# - The api process is exec'd under `setpriv --reuid=10001 --regid=10001`.
#   The node process itself never runs as root. Only the chown below
#   and the setpriv call need any capabilities (CAP_CHOWN, CAP_SETUID,
#   CAP_SETGID), and those are one-shot tools used by the api's
#   entrypoint — see /usr/local/bin/api-entrypoint.sh.
# - `read_only: true` at run time is recommended but not required for
#   the smoke test; the api's only mutating action is sqlite writes
#   inside /app/data, which the entrypoint chowns to UID 10001.

set -eu

DATA_DIR="/app/data"
API_PORT="${PORT:-3000}"
API_LOG="${API_LOG:-/tmp/api.log}"
API_READY_TIMEOUT="${API_READY_TIMEOUT:-30}"  # seconds

# ---------------------------------------------------------------------------
# 1. Repair /app/data ownership.
#    Idempotent: no-op on a correctly-provisioned volume, one-time repair
#    on a volume inherited from an older deployment (or on first boot).
# ---------------------------------------------------------------------------
mkdir -p "${DATA_DIR}"
chown -R 10001:10001 "${DATA_DIR}"

# ---------------------------------------------------------------------------
# 2. Start the api in the background.
#    We use the api's own entrypoint (which does the chown + setpriv
#    dance) — keeping that logic in one place means a bug fix in the
#    compose deployment's entrypoint automatically lands here.
# ---------------------------------------------------------------------------
echo "[start.sh] starting api on 127.0.0.1:${API_PORT} (logs: ${API_LOG})" >&2
PORT="${API_PORT}" /usr/local/bin/api-entrypoint.sh >"${API_LOG}" 2>&1 &
API_PID=$!
echo "[start.sh] api pid=${API_PID}" >&2

# ---------------------------------------------------------------------------
# 3. Wait for the api to be ready.
#    The api's /health endpoint is unauthenticated and lightweight; we
#    poll it up to ${API_READY_TIMEOUT} seconds. If it doesn't come up
#    in time, surface the api's log and exit non-zero so the container
#    restart policy kicks in.
# ---------------------------------------------------------------------------
i=0
while [ "${i}" -lt "${API_READY_TIMEOUT}" ]; do
    if wget -q -O- "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
        echo "[start.sh] api ready after ${i}s" >&2
        break
    fi
    # If the api process died, fail fast with its log.
    if ! kill -0 "${API_PID}" 2>/dev/null; then
        echo "[start.sh] api process exited before becoming ready; log tail:" >&2
        tail -n 50 "${API_LOG}" >&2 || true
        exit 1
    fi
    i=$((i + 1))
    sleep 1
done

if [ "${i}" -ge "${API_READY_TIMEOUT}" ]; then
    echo "[start.sh] api did not become ready within ${API_READY_TIMEOUT}s; log tail:" >&2
    tail -n 50 "${API_LOG}" >&2 || true
    kill "${API_PID}" 2>/dev/null || true
    exit 1
fi

# ---------------------------------------------------------------------------
# 4. Trap SIGTERM/SIGINT so the api gets a clean shutdown when nginx
#    exits or the container is stopped.
# ---------------------------------------------------------------------------
shutdown_api() {
    echo "[start.sh] stopping api (pid=${API_PID})" >&2
    kill -TERM "${API_PID}" 2>/dev/null || true
    # Give it up to 10s to exit cleanly; then SIGKILL.
    i=0
    while [ "${i}" -lt 10 ] && kill -0 "${API_PID}" 2>/dev/null; do
        i=$((i + 1))
        sleep 1
    done
    if kill -0 "${API_PID}" 2>/dev/null; then
        kill -KILL "${API_PID}" 2>/dev/null || true
    fi
    # Stop the watcher if it's still running so it doesn't race with
    # nginx's shutdown and report a spurious "api exited unexpectedly".
    if [ -n "${WATCHER_PID:-}" ] && kill -0 "${WATCHER_PID}" 2>/dev/null; then
        kill "${WATCHER_PID}" 2>/dev/null || true
    fi
}
trap shutdown_api TERM INT

# ---------------------------------------------------------------------------
# 4b. Watch the api process while nginx runs.
#     If the api dies unexpectedly (uncaught exception, OOM, etc.), the
#     container should NOT keep serving requests that will always 502.
#     When the api is dead, log the failure and exit non-zero — compose's
#     `restart: unless-stopped` (and `docker run --restart=on-failure`)
#     then bring the whole stack back up. (v0.5 / Bug 1 — the api was
#     observed stuck in "Exited (0)" while the web kept returning 502.)
# ---------------------------------------------------------------------------
watch_api() {
    while kill -0 "${API_PID}" 2>/dev/null; do
        sleep 2
    done
    echo "[start.sh] api process ${API_PID} exited unexpectedly; log tail:" >&2
    tail -n 50 "${API_LOG}" >&2 || true
    # Trigger the same shutdown path so the api is fully cleaned up and
    # then propagate the failure to the container orchestrator.
    shutdown_api || true
    exit 1
}
watch_api &
WATCHER_PID=$!

# ---------------------------------------------------------------------------
# 5. Start nginx in the foreground.
#    nginx -g 'daemon off;' is the canonical way to run nginx as PID 1
#    (or, here, as the child of PID 1 that tini supervises). It
#    blocks until the master exits, which is exactly what we want —
#    the container's lifetime matches the lifetime of the nginx process.
# ---------------------------------------------------------------------------
echo "[start.sh] starting nginx in foreground" >&2
exec nginx -g 'daemon off;'
