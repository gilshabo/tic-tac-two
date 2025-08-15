#!/usr/bin/env bash
# Start Redis, run both WS servers in the background (no popup windows),
# wait for ports, then open TWO Terminal windows for manual play (clients).
# macOS only for the window-opening part. For Linux/Windows, run clients manually.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ROOM="${1:-room42}"
PLAYER_A="${2:-Alice}"
PLAYER_B="${3:-Bob}"

LOG_DIR="$ROOT_DIR/logs"
PID_DIR="$ROOT_DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

echo "=== Tic-Tac-Two: start_all (room=$ROOM, A=$PLAYER_A, B=$PLAYER_B) ==="

kill_if_port() {
  local port="$1"
  local pid
  pid="$(lsof -ti :"$port" || true)"
  if [[ -n "$pid" ]]; then
    echo "🔪 Killing process on port $port (pid=$pid)"
    kill -9 $pid 2>/dev/null || true
  fi
}

wait_port() {
  local host="${1:-127.0.0.1}"
  local port="${2:?port}"
  local timeout="${3:-25}"
  local start
  start=$(date +%s)
  printf "⏳ Waiting for %s:%s " "$host" "$port"
  while true; do
    if nc -z "$host" "$port" 2>/dev/null; then
      echo "✅"
      return 0
    fi
    if (( $(date +%s) - start >= timeout )); then
      echo
      echo "❌ Timeout waiting for $host:$port"
      return 1
    fi
    printf "."
    sleep 0.25
  done
}

ensure_redis() {
  if docker ps --format '{{.Names}}' | grep -q '^ttt-redis$'; then
    echo "ℹ️ Redis already running."
  elif docker ps -a --format '{{.Names}}' | grep -q '^ttt-redis$'; then
    echo "ℹ️ Starting existing Redis container..."
    docker start ttt-redis >/dev/null
  else
    echo "🚀 Running Redis container..."
    docker run --name ttt-redis -p 6379:6379 -d redis:7-alpine >/dev/null
  fi
}

start_server_bg() {
  local port="$1"
  local log="$LOG_DIR/server-$port.log"
  local pidfile="$PID_DIR/server-$port.pid"
  echo "🚀 Starting server on :$port (background). Logs → $log"
  ( PORT="$port" node server/server.js ) >"$log" 2>&1 &
  echo $! > "$pidfile"
}

open_mac_window() {
  # $1 = command line
  /usr/bin/osascript <<OSA
tell application "Terminal"
  activate
  do script "$1"
end tell
OSA
}

# 1) Make sure Redis is up
ensure_redis

# 2) Kill anything on our ports (safe if nothing there)
kill_if_port 3001
kill_if_port 3002

# 3) Start both servers in the background (NO popup windows)
start_server_bg 3001
start_server_bg 3002

# 4) Wait for ports to be ready
wait_port 127.0.0.1 3001 25
wait_port 127.0.0.1 3002 25

echo "✅ Servers are up. Tail logs with:"
echo "   tail -f $LOG_DIR/server-3001.log"
echo "   tail -f $LOG_DIR/server-3002.log"

# 5) Open TWO Terminal windows for manual play (clients)
echo "🧑‍🤝‍🧑 Opening two client windows for manual play…"
open_mac_window "cd $ROOT_DIR; node client/client.js ws://127.0.0.1:3001 $ROOM $PLAYER_A"
open_mac_window "cd $ROOT_DIR; node client/client.js ws://127.0.0.1:3002 $ROOM $PLAYER_B"

echo
echo "🎮 Ready! Type your moves in the two new Terminal windows as: row col (e.g., '0 2')."
echo "🛑 To stop servers: pkill -f 'server/server.js'  (or kill PIDs from $PID_DIR)"