#!/usr/bin/env bash
set -euo pipefail

state_dir="${CANVAS_LOCAL_TEAM_SEAT_STATE_DIR:-$HOME/.local/state/canvas-local-team-seat}"
postgres_env="$state_dir/postgres.env"
[[ -f "$postgres_env" ]] || {
  printf 'The managed local PostgreSQL state is not prepared.\n' >&2
  exit 2
}
export PGPASSWORD="$(awk -F= '$1=="POSTGRES_PASSWORD" {print substr($0,index($0,"=")+1)}' "$postgres_env")"
[[ -n "$PGPASSWORD" ]] || exit 2

test_db="team_sync_offline_http_$(date +%s)_$(openssl rand -hex 4)"
db_created=0
cleanup() {
  if [[ "$db_created" == 1 ]]; then
    dropdb --if-exists --host 127.0.0.1 --port 55433 --username canvas "$test_db"
  fi
}
trap cleanup EXIT

createdb --host 127.0.0.1 --port 55433 --username canvas "$test_db"
db_created=1
export DATABASE_URL="postgresql://canvas:${PGPASSWORD}@127.0.0.1:55433/${test_db}"
export CANVAS_DATABASE_PROVIDER=postgres
export CANVAS_POSTGRES_VECTOR_ENABLED=false
export BETTER_AUTH_BASE_URL=http://127.0.0.1:3101
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
cd "$(dirname "$0")/.."
./node_modules/.bin/tsx --conditions react-server scripts/managed-team-offline-http-test.ts
