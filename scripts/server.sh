#!/usr/bin/env bash
# Quản lý server VFX Skill Cloud dev. Không dùng `pkill -f` (sẽ self-match và kill shell này).
#
# Two ways the server runs:
#   1. systemd USER unit `vfx-skill-cloud` (preferred; template: scripts/systemd/vfx-skill-cloud.service).
#      When the unit file is installed, start/stop/restart/status go through `systemctl --user`.
#   2. Hand-started (fallback): nohup'd, tracked by $PID_FILE. A server with NO pid file is still found
#      by its port (`ss -ltnp`); stop kills it ONLY if its cmdline is this project's server/src/index.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="/tmp/opencode/vfx.pid"
LOG_FILE="/tmp/opencode/vfx-server.log"
PORT="${VFX_PORT:-8787}"
UNIT="vfx-skill-cloud.service"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"

mkdir -p /tmp/opencode

unit_installed() {
  [[ -f "$UNIT_FILE" ]] && command -v systemctl >/dev/null 2>&1
}

unit_active() {
  unit_installed && systemctl --user is-active --quiet "$UNIT"
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

port_busy() {
  ss -ltn 2>/dev/null | grep -q ":$PORT "
}

# PID of whatever listens on $PORT, empty if none (ss -p needs the same user; our own process always qualifies).
listener_pid() {
  ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true
}

# True only for this project's dev server (never kill an unrelated process that holds the port).
is_our_server() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'server/src/index.ts'
}

kill_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

stop() {
  if unit_active; then
    systemctl --user stop "$UNIT"
    rm -f "$PID_FILE"
    echo "stopped systemd unit $UNIT"
    return
  fi
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill_pid "$pid"
    echo "stopped pid=$pid (pid file)"
  fi
  rm -f "$PID_FILE"
  local lp
  lp="$(listener_pid)"
  if [[ -n "$lp" ]]; then
    if is_our_server "$lp"; then
      kill_pid "$lp"
      echo "stopped pid=$lp (found by port $PORT, no pid file)"
    else
      echo "port $PORT is held by pid=$lp, which is not this project's server; not touching it" >&2
      exit 1
    fi
  fi
}

start() {
  if unit_installed; then
    if unit_active; then
      echo "already running (systemd $UNIT)"
    else
      systemctl --user start "$UNIT"
    fi
    sleep 4
    if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null; then
      echo "server không lên. journal:" >&2
      journalctl --user -u "$UNIT" -n 20 --no-pager >&2 || true
      exit 1
    fi
    echo "started systemd unit $UNIT  (journal: journalctl --user -u $UNIT -f)"
    return
  fi
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
    if unit_installed; then
      echo "systemd $UNIT: $(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
    fi
    if is_running; then echo "pid file: running pid=$(cat "$PID_FILE")"; else echo "pid file: none"; fi
    lp="$(listener_pid)"
    if [[ -n "$lp" ]]; then
      if is_our_server "$lp"; then echo "port $PORT: pid=$lp (this project's server)"; else echo "port $PORT: pid=$lp (NOT this project's server)"; fi
    else
      echo "port $PORT: no listener"
    fi
    curl -fsS "http://127.0.0.1:$PORT/healthz" && echo || true
    ;;
  *) echo "dùng: $0 {start|stop|restart|status}" >&2; exit 1 ;;
esac
