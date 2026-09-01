#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
machine="${CANVAS_ORBSTACK_TEST_MACHINE:-canvas-managed-e2e}"
vm_source_root="/mnt/mac${repo_root}"
dependency_root="/var/tmp/canvas-notebook-e2e-deps-$(id -un)"

if ! command -v orb >/dev/null 2>&1; then
  echo "OrbStack CLI is required for this local PostgreSQL integration test." >&2
  exit 1
fi

orb -m "$machine" bash -s -- "$vm_source_root" "$dependency_root" <<'VM_SCRIPT'
set -euo pipefail

source_root="$1"
dependency_root="$2"

if [ ! -d "$source_root" ]; then
  echo "The Canvas Notebook repository is not mounted in the OrbStack VM." >&2
  exit 1
fi
if ! sudo -n -u postgres true 2>/dev/null; then
  echo "Passwordless local sudo access to the PostgreSQL system user is required." >&2
  exit 1
fi

refresh_dependencies=false
if [ ! -d "$dependency_root/node_modules" ]; then
  refresh_dependencies=true
elif ! cmp -s "$source_root/package-lock.json" "$dependency_root/package-lock.json"; then
  refresh_dependencies=true
fi

if [ "$refresh_dependencies" = true ]; then
  mkdir -p "$dependency_root"
  tar -C "$source_root" \
    --exclude=.git \
    --exclude=node_modules \
    --exclude=.next \
    --exclude=data \
    --exclude='.env' \
    --exclude='.env.*' \
    -cf - . | tar -C "$dependency_root" -xf -
  chmod 755 "$dependency_root"
  (
    cd "$dependency_root"
    npm ci
  )
fi

test_root="$(mktemp -d /var/tmp/canvas-workspace-api.XXXXXX)"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

tar -C "$source_root" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=data \
  --exclude='.env' \
  --exclude='.env.*' \
  -cf - . | tar -C "$test_root" -xf -
ln -s "$dependency_root/node_modules" "$test_root/node_modules"
chmod 755 "$test_root"

cd "$test_root"
sudo -n -u postgres env \
  DATABASE_URL='postgresql:///postgres?host=/var/run/postgresql' \
  node --conditions=react-server --import=tsx scripts/workspace-api-routes-postgres-runner.ts
VM_SCRIPT
