#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" || ! -d /run/systemd/system ]] || ! command -v systemctl >/dev/null 2>&1; then exit 0; fi
[[ "$(id -u)" == 0 ]] || { printf 'Management API service installation requires root.\n' >&2; exit 1; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="${CANVAS_MANAGEMENT_API_TEMPLATE:-${script_dir}/templates/canvas-notebook-management.service}"
cli_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"
install_dir="${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}"
config_path="${CANVAS_CONFIG_JSON:-${install_dir}/canvas-notebook-config.json}"
[[ -f "$template" && ! -L "$template" && -f "$config_path" ]] || { printf 'Management API template or config is unavailable.\n' >&2; exit 1; }

escape() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
for value in "$cli_path" "$install_dir" "$config_path"; do
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *'"'* && "$value" != *'%'* && "$value" != *'\'* ]] || { printf 'Management API service paths are invalid.\n' >&2; exit 1; }
done

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
unit="canvas-notebook-management.service"
sed -e "s|__CLI_PATH__|$(escape "$cli_path")|g" \
    -e "s|__INSTALL_DIR__|$(escape "$install_dir")|g" \
    -e "s|__CONFIG_JSON__|$(escape "$config_path")|g" \
    "$template" > "${temporary_dir}/${unit}"
systemd-analyze verify "${temporary_dir}/${unit}"
install -m 644 "${temporary_dir}/${unit}" "/etc/systemd/system/${unit}"
systemctl daemon-reload
systemctl enable "$unit" >/dev/null
systemctl restart "$unit"
