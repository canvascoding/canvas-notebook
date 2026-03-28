#!/bin/sh
# Start script for Canvas Notebook
# Starts Terminal Service, Next.js, and Automation Scheduler

set -eu

echo "[Startup] Canvas Notebook starting..."

# Generate terminal auth token if not exists
if [ -z "${CANVAS_TERMINAL_TOKEN:-}" ]; then
  export CANVAS_TERMINAL_TOKEN=$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | fold -w 64 | head -n 1)
  # POSIX-compatible substring extraction
  TOKEN_PREVIEW=$(echo "$CANVAS_TERMINAL_TOKEN" | cut -c1-8)
  echo "[Startup] Generated terminal auth token: ${TOKEN_PREVIEW}..."
fi

# Ensure socket directory exists and is writable
mkdir -p /tmp
chmod 777 /tmp 2>/dev/null || true

cd /app

SKILLS_BIN_DIR="${DATA:-/data}/skills/bin"
if [ ! -d "$SKILLS_BIN_DIR" ] || [ -z "$(find "$SKILLS_BIN_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "[Startup] Skills runtime bin missing or empty, preparing skills runtime..."
  node scripts/prepare-skills-runtime.js
fi
PATH="${SKILLS_BIN_DIR}:$PATH"
export PATH

NEXT_PID=""
SCHEDULER_PID=""

wait_for_next_health() {
  health_url="http://127.0.0.1:${PORT:-3000}/api/health"
  attempt=0
  max_attempts="${STARTUP_HEALTH_MAX_ATTEMPTS:-60}"

  echo "[Startup] Waiting for Next.js health endpoint at ${health_url}..."

  while [ "$attempt" -lt "$max_attempts" ]; do
    if [ -n "$NEXT_PID" ] && ! kill -0 "$NEXT_PID" 2>/dev/null; then
      echo "[Startup] ERROR: Next.js exited before becoming healthy"
      return 1
    fi

    if curl -fsS "$health_url" >/dev/null 2>&1; then
      echo "[Startup] Next.js health check passed."
      return 0
    fi

    attempt=$((attempt + 1))
    sleep 1
  done

  echo "[Startup] ERROR: Next.js did not become healthy within ${max_attempts}s"
  return 1
}

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
  if node scripts/bootstrap-admin.js; then
    echo "[Startup] Bootstrap-admin finished."
  else
    echo "[Startup] ERROR: bootstrap-admin failed."
    exit 1
  fi
elif [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] || [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  echo "[Startup] Skipping bootstrap-admin (requires both BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD)."
else
  echo "[Startup] Skipping bootstrap-admin (BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD not set)."
fi

# Function to cleanup background processes on exit
cleanup() {
  echo "[Shutdown] Stopping services..."
  if [ -n "${TERMINAL_PID:-}" ]; then
    kill "$TERMINAL_PID" 2>/dev/null || true
  fi
  if [ -n "${SCHEDULER_PID:-}" ]; then
    kill "$SCHEDULER_PID" 2>/dev/null || true
  fi
  if [ -n "${NEXT_PID:-}" ]; then
    kill "$NEXT_PID" 2>/dev/null || true
  fi
  wait || true
  echo "[Shutdown] Services stopped."
}
trap cleanup EXIT TERM INT

# Start Next.js first so the scheduler can wait on a real health signal.
echo "[Startup] Starting Next.js..."
./node_modules/.bin/next start &
NEXT_PID=$!

if ! wait_for_next_health; then
  exit 1
fi

echo "[Startup] Starting Automation Scheduler..."
node scripts/automation-scheduler.js &
SCHEDULER_PID=$!
echo "[Startup] Automation Scheduler started (PID: $SCHEDULER_PID)"

wait "$NEXT_PID"
