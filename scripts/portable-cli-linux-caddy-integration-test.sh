#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist-cli/main.js"

[[ "$(uname -s)" == "Linux" ]] || {
  printf 'portable-cli-linux-caddy-integration-test requires Linux\n' >&2
  exit 2
}
[[ -f "$CLI" ]] || {
  printf 'Build the portable CLI first with npm run cli:build\n' >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq is required for the Linux Caddy integration test\n' >&2
  exit 2
}

TEST_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

REAL_CADDY="$(command -v caddy || true)"
if [[ -z "$REAL_CADDY" ]]; then
  command -v apt-get >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1 || {
    printf 'Caddy is not installed and apt/dpkg extraction is unavailable\n' >&2
    exit 2
  }
  mkdir -p "$TEST_ROOT/caddy-package"
  (
    cd "$TEST_ROOT/caddy-package"
    apt-get download caddy >/dev/null
  )
  CADDY_PACKAGE="$(find "$TEST_ROOT/caddy-package" -maxdepth 1 -name 'caddy_*.deb' -print -quit)"
  [[ -n "$CADDY_PACKAGE" ]] || {
    printf 'Unable to download a temporary Caddy package\n' >&2
    exit 2
  }
  dpkg-deb -x "$CADDY_PACKAGE" "$TEST_ROOT/caddy-package/extracted"
  REAL_CADDY="$TEST_ROOT/caddy-package/extracted/usr/bin/caddy"
fi
[[ -x "$REAL_CADDY" ]] || {
  printf 'A runnable Caddy binary is required\n' >&2
  exit 2
}

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/caddy" "$TEST_ROOT/install" "$TEST_ROOT/data" "$TEST_ROOT/home"
export CANVAS_TEST_REAL_CADDY="$REAL_CADDY"
export CANVAS_TEST_SYSTEMCTL_LOG="$TEST_ROOT/systemctl.log"
export CANVAS_INSTALL_DIR="$TEST_ROOT/install"
export CANVAS_DATA_DIR="$TEST_ROOT/data"
export CANVAS_CONFIG_JSON="$TEST_ROOT/install/canvas-notebook-config.json"
export CANVAS_COMPOSE_FILE="$TEST_ROOT/install/canvas-notebook-compose.yaml"
export CANVAS_CONFIG_ENV="$TEST_ROOT/install/canvas-notebook.env"
export CANVAS_COMPOSE_ENV="$TEST_ROOT/install/.env"
export CANVAS_MANAGER_LOG_FILE="$TEST_ROOT/manager.log"
export CANVAS_OPERATION_LOCK_PATH="$TEST_ROOT/operation.lock"
export CANVAS_CADDY_TEST_ROOT="$TEST_ROOT/caddy"
export HOME="$TEST_ROOT/home"
export PATH="$TEST_ROOT/bin:$PATH"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'exec "$CANVAS_TEST_REAL_CADDY" "$@"' \
  > "$TEST_ROOT/bin/caddy"
chmod 755 "$TEST_ROOT/bin/caddy"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\\n" "$*" >> "$CANVAS_TEST_SYSTEMCTL_LOG"' \
  'if [[ "${1:-}" == "is-active" ]]; then printf "active\\n"; exit 0; fi' \
  'if [[ "${CANVAS_TEST_SYSTEMCTL_FAIL:-false}" == "true" ]]; then exit 1; fi' \
  'exit 0' \
  > "$TEST_ROOT/bin/systemctl"
chmod 755 "$TEST_ROOT/bin/systemctl"

node "$CLI" config-set domain notebook.example.com --no-banner >/dev/null

initial_json="$(node "$CLI" caddy --json --no-banner)"
jq -e '
  .domain == "notebook.example.com" and
  .publicDomain == true and
  .installed == true and
  .caddyfileExists == false and
  (.issues | index("caddyfile_missing") != null)
' <<<"$initial_json" >/dev/null

reload_json="$(node "$CLI" caddy-reload --json --no-banner)"
jq -e '
  .success == true and
  .changed == true and
  .reloaded == true and
  .restarted == false and
  .inSync == true and
  .error == null
' <<<"$reload_json" >/dev/null
grep -q '^# Managed by Canvas Notebook$' "$TEST_ROOT/caddy/Caddyfile"
grep -q 'reverse_proxy localhost:3456' "$TEST_ROOT/caddy/Caddyfile"
grep -q 'header_up X-Forwarded-Port 443' "$TEST_ROOT/caddy/Caddyfile"
"$REAL_CADDY" validate --config "$TEST_ROOT/caddy/Caddyfile" >/dev/null 2>&1

printf '%s\n' \
  'notebook.example.com {' \
  '    reverse_proxy localhost:3456' \
  '}' \
  > "$TEST_ROOT/caddy/Caddyfile"
drift_json="$(node "$CLI" caddy --json --no-banner)"
jq -e '.inSync == false and (.issues | index("missing_forwarded_port") != null)' <<<"$drift_json" >/dev/null
node "$CLI" caddy-reload --json --no-banner | jq -e '.success == true and .inSync == true' >/dev/null

printf '%s\n' \
  ':80 {' \
  '    root * /usr/share/caddy' \
  '    file_server' \
  '}' \
  > "$TEST_ROOT/caddy/Caddyfile"
mkdir -p "$TEST_ROOT/caddy/conf.d"
printf 'legacy canvas config\n' > "$TEST_ROOT/caddy/conf.d/canvas-notebook.caddy"
if node "$CLI" caddy-reload --json --no-banner > "$TEST_ROOT/reload-refusal.json"; then
  printf 'caddy-reload unexpectedly overwrote the known default site\n' >&2
  exit 1
fi
jq -e '.error | contains("Refusing to overwrite unmanaged Caddyfile")' "$TEST_ROOT/reload-refusal.json" >/dev/null
fix_json="$(node "$CLI" caddy-fix --json --no-banner)"
jq -e '.success == true and .changed == true and .legacyConfigExists == false and .inSync == true' <<<"$fix_json" >/dev/null
[[ ! -e "$TEST_ROOT/caddy/conf.d/canvas-notebook.caddy" ]]

printf '%s\n' \
  'notebook.example.com {' \
  '    reverse_proxy localhost:3456' \
  '}' \
  > "$TEST_ROOT/caddy/Caddyfile"
cp "$TEST_ROOT/caddy/Caddyfile" "$TEST_ROOT/Caddyfile.before-failure"
if CANVAS_TEST_SYSTEMCTL_FAIL=true node "$CLI" caddy-fix --json --no-banner > "$TEST_ROOT/reload-failure.json"; then
  printf 'caddy-fix unexpectedly succeeded during injected service failure\n' >&2
  exit 1
fi
cmp -s "$TEST_ROOT/Caddyfile.before-failure" "$TEST_ROOT/caddy/Caddyfile"
jq -e '.error != null and .inSync == false' "$TEST_ROOT/reload-failure.json" >/dev/null

grep -q '^reload caddy$' "$TEST_ROOT/systemctl.log"
printf 'portable-cli-linux-caddy-integration-test: ok (%s)\n' "$("$REAL_CADDY" version)"
