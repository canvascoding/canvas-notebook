#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "agent-bash-landlock-integration-test: skipped (Linux required)"
  exit 0
fi

launcher="${CANVAS_AGENT_LANDLOCK_PATH:-/usr/local/libexec/canvas-agent-landlock}"
if [[ ! -x "$launcher" ]]; then
  if [[ "${CANVAS_RUNTIME_ENV:-}" == "docker" ]]; then
    echo "Landlock launcher is missing in the managed runtime: $launcher" >&2
    exit 1
  fi
  echo "agent-bash-landlock-integration-test: skipped (launcher not installed)"
  exit 0
fi

test_root="$(mktemp -d /tmp/canvas-agent-landlock-test.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

workspace="$test_root/workspace"
scratch="$test_root/scratch"
sibling="$test_root/sibling"
secrets="$test_root/secrets"
mkdir -p "$workspace" "$scratch" "$sibling" "$secrets"
printf 'workspace-readable\n' > "$workspace/input.txt"
printf 'secret-sentinel\n' > "$secrets/secret.txt"
printf 'sibling-sentinel\n' > "$sibling/private.txt"
ln -s "$workspace" "$scratch/workspace-link"

canonical() {
  realpath "$1"
}

common_args=(--cwd "$(canonical "$scratch")")
declare -A seen_ro=()
for candidate in /usr /bin /lib /lib64 /etc; do
  if [[ -e "$candidate" ]]; then
    resolved="$(canonical "$candidate")"
    if [[ -z "${seen_ro[$resolved]:-}" ]]; then
      common_args+=(--ro "$resolved")
      seen_ro[$resolved]=1
    fi
  fi
done
common_args+=(--ro "$(canonical "$workspace")" --rw "$(canonical "$scratch")")
for device in /dev/null /dev/zero /dev/random /dev/urandom; do
  common_args+=(--rw-file "$(canonical "$device")")
done

run_sandboxed() {
  "$launcher" "${common_args[@]}" -- /bin/bash -lc "$1"
}

CANVAS_WORKSPACE_DIR="$workspace" \
  run_sandboxed 'test "$(cat "$CANVAS_WORKSPACE_DIR/input.txt")" = workspace-readable'
CANVAS_WORKSPACE_DIR="$workspace" CANVAS_AGENT_TEMP_DIR="$scratch" \
  run_sandboxed 'mkdir -p shell && printf shell > shell/output.txt && rm shell/output.txt'
CANVAS_WORKSPACE_DIR="$workspace" CANVAS_AGENT_TEMP_DIR="$scratch" \
  run_sandboxed 'node -e "require(\"fs\").writeFileSync(process.env.CANVAS_AGENT_TEMP_DIR+\"/node.txt\",\"node\")"'
CANVAS_WORKSPACE_DIR="$workspace" CANVAS_AGENT_TEMP_DIR="$scratch" \
  run_sandboxed 'python3 -c "import os, pathlib; pathlib.Path(os.environ[\"CANVAS_AGENT_TEMP_DIR\"], \"python.txt\").write_text(\"python\")"'

if CANVAS_WORKSPACE_DIR="$workspace" run_sandboxed 'node -e "require(\"fs\").writeFileSync(process.env.CANVAS_WORKSPACE_DIR+\"/blocked.txt\",\"blocked\")"'; then
  echo 'Node unexpectedly wrote to the workspace' >&2
  exit 1
fi
test ! -e "$workspace/blocked.txt"

if SIBLING="$sibling" run_sandboxed 'python3 -c "import os, pathlib; pathlib.Path(os.environ[\"SIBLING\"], \"blocked.txt\").write_text(\"blocked\")"'; then
  echo 'Python unexpectedly wrote to a sibling session directory' >&2
  exit 1
fi
test ! -e "$sibling/blocked.txt"

if SECRET_FILE="$secrets/secret.txt" run_sandboxed 'node -e "require(\"fs\").readFileSync(process.env.SECRET_FILE)"'; then
  echo 'Node unexpectedly read a restricted secret' >&2
  exit 1
fi

if run_sandboxed 'printf blocked > workspace-link/blocked.txt'; then
  echo 'A scratch symlink unexpectedly escaped into the workspace' >&2
  exit 1
fi
test ! -e "$workspace/blocked.txt"

echo 'agent-bash-landlock-integration-test: ok'
