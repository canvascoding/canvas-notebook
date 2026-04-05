#!/bin/sh
# Start script for Canvas Notebook
# Starts Terminal Service, Next.js, and Automation Scheduler

set -eu

# ─── Progress display helpers ──────────────────────────────────────────────
STARTUP_LOG="/data/logs/startup.log"
_step_num=0
_step_total=0
_step_label=""

_progress_bar() {
  if [ "$_step_total" -le 0 ]; then return; fi
  _pct=$(( _step_num * 100 / _step_total ))
  _filled=$(( _step_num * 20 / _step_total ))
  _bar="" _i=0
  while [ $_i -lt $_filled ]; do _bar="${_bar}█"; _i=$((_i+1)); done
  while [ $_i -lt 20 ];        do _bar="${_bar}░"; _i=$((_i+1)); done
  printf '  [%s] %3d%%' "$_bar" "$_pct"
}

step() {
  _step_num=$((_step_num + 1))
  _step_label="$1"
  printf '\r\033[K  \342\206\222 [%d/%d] %s' "$_step_num" "$_step_total" "$_step_label"
}

step_ok() {
  printf '\r\033[K  \342\234\223 [%d/%d] %s\n' "$_step_num" "$_step_total" "$_step_label"
  _progress_bar
}

step_fail() {
  printf '\r\033[K  \342\234\227 [%d/%d] %s \342\200\224 FAILED\n' "$_step_num" "$_step_total" "$_step_label"
  printf '\n  Full log: %s\n\n' "$STARTUP_LOG"
  tail -n 30 "$STARTUP_LOG" >&2
}
# ───────────────────────────────────────────────────────────────────────────

# ─── Dynamic step count ───────────────────────────────────────────────────
_step_total=3
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  _step_total=$((_step_total+1))
fi

# ─── Init log ─────────────────────────────────────────────────────────────
mkdir -p /data/logs
printf 'Canvas Notebook starting...\n\n'

# Generate terminal auth token if not exists
if [ -z "${CANVAS_TERMINAL_TOKEN:-}" ]; then
  export CANVAS_TERMINAL_TOKEN=$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | fold -w 64 | head -n 1)
fi

# Ensure socket directory exists and is writable
mkdir -p /tmp
chmod 777 /tmp 2>/dev/null || true

cd /app
export CANVAS_APP_ROOT="${CANVAS_APP_ROOT:-/app}"

SKILLS_BIN_DIR="${DATA:-/data}/skills/bin"
if [ ! -d "$SKILLS_BIN_DIR" ] || [ -z "$(find "$SKILLS_BIN_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  node scripts/prepare-skills-runtime.js >> "$STARTUP_LOG" 2>&1
fi
PATH="${SKILLS_BIN_DIR}:$PATH"
export PATH

NEXT_PID=""
SCHEDULER_PID=""

# ─── Step 1: Terminal Service ─────────────────────────────────────────────
step "Terminal Service"
node server/terminal-service.js >> "$STARTUP_LOG" 2>&1 &
TERMINAL_PID=$!
sleep 2
if ! kill -0 $TERMINAL_PID 2>/dev/null; then
  step_fail
  printf '\n  ERROR: Terminal Service failed to start\n' >&2
  exit 1
fi
step_ok

# ─── Step 2: Bootstrap admin ─────────────────────────────────────────────
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  step "Bootstrap admin"
  if node scripts/bootstrap-admin.js >> "$STARTUP_LOG" 2>&1; then
    step_ok
  else
    step_fail
    printf '\n  ERROR: bootstrap-admin failed\n' >&2
    exit 1
  fi
fi

# ─── Cleanup handler ─────────────────────────────────────────────────────
cleanup() {
  printf '\n\n  Stopping services...\n'
  if [ -n "${TERMINAL_PID:-}" ]; then kill "$TERMINAL_PID" 2>/dev/null || true; fi
  if [ -n "${SCHEDULER_PID:-}" ]; then kill "$SCHEDULER_PID" 2>/dev/null || true; fi
  if [ -n "${NEXT_PID:-}" ]; then kill "$NEXT_PID" 2>/dev/null || true; fi
  wait || true
}
trap cleanup EXIT TERM INT

# ─── Step 3: Next.js ─────────────────────────────────────────────────────
step "Next.js startup"
./node_modules/.bin/next start >> "$STARTUP_LOG" 2>&1 &
NEXT_PID=$!

health_url="http://127.0.0.1:${PORT:-3000}/api/health"
attempt=0
max_attempts="${STARTUP_HEALTH_MAX_ATTEMPTS:-60}"

while [ "$attempt" -lt "$max_attempts" ]; do
  if [ -n "$NEXT_PID" ] && ! kill -0 "$NEXT_PID" 2>/dev/null; then
    step_fail
    printf '\n  ERROR: Next.js exited before becoming healthy\n' >&2
    exit 1
  fi
  if curl -fsS "$health_url" >/dev/null 2>&1; then
    step_ok
    break
  fi
  attempt=$((attempt + 1))
  printf '\r\033[K  \342\206\222 [%d/%d] Next.js startup (%ds)...' "$_step_num" "$_step_total" "$attempt"
  sleep 1
done

if [ "$attempt" -ge "$max_attempts" ]; then
  step_fail
  printf '\n  ERROR: Next.js did not become healthy within %ds\n' "$max_attempts" >&2
  exit 1
fi

# ─── Step 4: Automation Scheduler ────────────────────────────────────────
step "Automation Scheduler"
node scripts/automation-scheduler.js >> "$STARTUP_LOG" 2>&1 &
SCHEDULER_PID=$!
step_ok

printf '\n\n  Canvas Notebook ready.\n\n'

wait "$NEXT_PID"
