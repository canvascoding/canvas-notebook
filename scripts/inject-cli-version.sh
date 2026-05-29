#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"

update_cli_version_line() {
  local file="$1"
  local line="$2"
  local anchor="$3"
  local escaped tmp

  escaped="$(printf '%s' "$line" | sed -e 's/[\/&]/\\&/g')"
  if grep -Eq '^CANVAS_CLI_VERSION=' "$file"; then
    sed -i.bak -E "s/^CANVAS_CLI_VERSION=.*/${escaped}/" "$file"
    rm -f "${file}.bak"
    return
  fi

  tmp="$(mktemp)"
  awk -v anchor="$anchor" -v line="$line" '
    { print }
    $0 == anchor { print line }
  ' "$file" > "$tmp"
  if ! cmp -s "$file" "$tmp"; then
    cat "$tmp" > "$file"
  else
    printf '\n%s\n' "$line" >> "$file"
  fi
  rm -f "$tmp"
}

update_cli_version_line \
  "$ROOT/install/bin/canvas-notebook" \
  "CANVAS_CLI_VERSION=\"${VERSION}\"" \
  "set -euo pipefail"

update_cli_version_line \
  "$ROOT/install/lib/shared/output.sh" \
  "CANVAS_CLI_VERSION=\"\${CANVAS_CLI_VERSION:-${VERSION}}\"" \
  '[[ -n "${_SHARED_OUTPUT_LOADED:-}" ]] && return 0'

printf 'Injected CLI version: %s\n' "$VERSION"
