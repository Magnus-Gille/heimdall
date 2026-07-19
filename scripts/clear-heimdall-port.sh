#!/usr/bin/env bash
# clear-heimdall-port.sh — free the Heimdall server port before (re)start.
#
# Used as ExecStartPre in systemd/heimdall.service to kill a stale Heimdall
# server that survived a restart and is still holding the port (issue #8).
#
# Deliberately narrow and race-free, unlike a bare `pkill -f`:
#   * Only kills a process that is BOTH listening on $PORT AND verified to be
#     THIS repo's `node src/server.js` (cwd + cmdline check via /proc) — it will
#     never touch unrelated node processes or tooling.
#   * After SIGTERM it WAITS for the port to actually free (closing the TOCTOU
#     window a bare pkill leaves open, which otherwise races ExecStart into
#     EADDRINUSE and, with Restart=always, a restart loop).
#   * Escalates to SIGKILL only as a last resort, and only on the verified PID.
#
# Always exits 0: a failure here must not block startup — ExecStart will surface
# a genuine EADDRINUSE itself if the port is somehow still held.

set -u

PORT="${PORT:-3033}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERM_WAIT=10   # seconds to wait for graceful shutdown before SIGKILL

log() { echo "clear-heimdall-port: $*" >&2; }

# PIDs listening on $PORT (TCP). `ss` is always present on the Pi; `-p` shows
# the owning process (visible because this runs as the same user that owns it).
listening_pids() {
  ss -H -ltnp "sport = :${PORT}" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

# True only if $1 is THIS repo's `node src/server.js` process.
is_heimdall_server() {
  local pid="$1" cwd cmdline
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline")"   # cmdline is NUL-separated
  case "$cmdline" in
    *node*src/server.js*) ;;
    *) return 1 ;;
  esac
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" || return 1
  [ "$cwd" = "$REPO_DIR" ]
}

targets=""
for pid in $(listening_pids); do
  if is_heimdall_server "$pid"; then
    targets="$targets $pid"
  else
    log "PID $pid holds :$PORT but is not this Heimdall server (cwd/cmdline mismatch) — leaving it alone"
  fi
done

# Nothing to do (the common case: port already free).
[ -z "${targets// /}" ] && exit 0

log "stale Heimdall server(s) on :$PORT —$targets; sending SIGTERM"
# shellcheck disable=SC2086  # word-splitting the PID list is intentional
kill -TERM $targets 2>/dev/null

# Wait for the port to actually free before letting ExecStart bind it.
for ((i = 0; i < TERM_WAIT; i++)); do
  [ -z "$(listening_pids)" ] && { log "port :$PORT freed"; exit 0; }
  sleep 1
done

# Still held after the grace period — SIGKILL only the verified, still-alive PIDs.
for pid in $targets; do
  if kill -0 "$pid" 2>/dev/null && is_heimdall_server "$pid"; then
    log "PID $pid did not exit in ${TERM_WAIT}s — SIGKILL"
    kill -KILL "$pid" 2>/dev/null
  fi
done

exit 0
