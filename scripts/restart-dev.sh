#!/bin/bash
# Safely restart the local dev API server.
# Kills whatever is on port 3001, waits for it to actually die, then starts fresh.
set -e

echo "Stopping API on port 3001..."
PID=$(powershell -Command "(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).OwningProcess" 2>/dev/null | tr -d '\r')

if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  powershell -Command "Stop-Process -Id $PID -Force" 2>/dev/null || true
  # Wait until the port is actually free
  for i in $(seq 1 10); do
    CHECK=$(powershell -Command "(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).OwningProcess" 2>/dev/null | tr -d '\r')
    if [ -z "$CHECK" ] || [ "$CHECK" = "0" ]; then
      break
    fi
    echo "  Waiting for port 3001 to free up... ($i)"
    sleep 1
  done
fi

echo "Starting API server..."
cd "$(dirname "$0")/.."
node dist/index.js
