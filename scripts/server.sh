#!/usr/bin/env bash
# Quản lý server VFX Skill Cloud dev. Không dùng `pkill -f` (sẽ self-match và kill shell này).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="/tmp/opencode/vfx.pid"
LOG_FILE="/tmp/opencode/vfx-server.log"
PORT="${VFX_PORT:-8787}"

mkdir -p /tmp/opencode

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

port_busy() {
  ss -ltn 2>/dev/null | grep -q ":$PORT "
}

stop() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped pid=$pid"
  fi
  rm -f "$PID_FILE"
}

start() {
  if port_busy; then
    echo "port $PORT đang có người giữ — stop trước" >&2
    exit 1
  fi
  cd "$ROOT"
  AUTH_DISABLED=1 nohup node server/src/index.ts >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 4
  if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null; then
    echo "server không lên. log:" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  echo "started pid=$(cat "$PID_FILE")  log=$LOG_FILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status)
    if is_running; then echo "running pid=$(cat "$PID_FILE")"; else echo "not running"; fi
    curl -fsS "http://127.0.0.1:$PORT/healthz" && echo || true
    ;;
  *) echo "dùng: $0 {start|stop|restart|status}" >&2; exit 1 ;;
esac
