#!/bin/sh
# Start script for Canvas Notebook
# Starts both Terminal Service and Next.js

# Generate terminal auth token if not exists
if [ -z "$CANVAS_TERMINAL_TOKEN" ]; then
  export CANVAS_TERMINAL_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 64 | head -n 1)
  echo "[Startup] Generated terminal auth token: ${CANVAS_TERMINAL_TOKEN:0:8}..."
fi

# Ensure socket directory exists and is writable
mkdir -p /tmp
chmod 777 /tmp

cd /app

# Start terminal service in background
echo "[Startup] Starting Terminal Service..."
node server/terminal-service.js &
TERMINAL_PID=$!

# Wait for terminal service to be ready
sleep 2

# Check if terminal service is running
if ! kill -0 $TERMINAL_PID 2>/dev/null; then
  echo "[Startup] ERROR: Terminal Service failed to start"
  exit 1
fi

echo "[Startup] Terminal Service started (PID: $TERMINAL_PID)"

# Start Next.js
echo "[Startup] Starting Next.js..."
exec node server.js
