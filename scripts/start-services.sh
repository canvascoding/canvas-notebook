#!/bin/sh
# Start script for Canvas Notebook
# Starts Terminal Service, Next.js, and Automation Scheduler

echo "[Startup] Canvas Notebook starting..."

# Generate terminal auth token if not exists
if [ -z "$CANVAS_TERMINAL_TOKEN" ]; then
  export CANVAS_TERMINAL_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 64 | head -n 1)
  # POSIX-compatible substring extraction
  TOKEN_PREVIEW=$(echo "$CANVAS_TERMINAL_TOKEN" | cut -c1-8)
  echo "[Startup] Generated terminal auth token: ${TOKEN_PREVIEW}..."
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

# Bootstrap admin user if env vars are set
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  echo "[Startup] Running bootstrap-admin..."
  if npx tsx scripts/bootstrap-admin.ts; then
    echo "[Startup] Bootstrap-admin finished."
  else
    echo "[Startup] WARNING: bootstrap-admin failed. Continuing startup."
  fi
fi

# Start automation scheduler in background
echo "[Startup] Starting Automation Scheduler..."
node scripts/automation-scheduler.js &
SCHEDULER_PID=$!
echo "[Startup] Automation Scheduler started (PID: $SCHEDULER_PID)"

# Function to cleanup background processes on exit
cleanup() {
  echo "[Shutdown] Stopping services..."
  kill $TERMINAL_PID 2>/dev/null
  kill $SCHEDULER_PID 2>/dev/null
  wait
  echo "[Shutdown] Services stopped."
}
trap cleanup EXIT TERM INT

# Start Next.js (this will block and is the main process)
echo "[Startup] Starting Next.js..."
exec ./node_modules/.bin/next start
