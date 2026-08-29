#!/usr/bin/env bash
set -euo pipefail

launcher_source="${BASH_SOURCE[0]}"
while [[ -L "$launcher_source" ]]; do
  launcher_dir="$(cd -P "$(dirname "$launcher_source")" && pwd)"
  launcher_source="$(readlink "$launcher_source")"
  [[ "$launcher_source" == /* ]] || launcher_source="$launcher_dir/$launcher_source"
done

launcher_dir="$(cd -P "$(dirname "$launcher_source")" && pwd)"
cli_root="$(cd "$launcher_dir/.." && pwd -P)"
current_file="$cli_root/state/current"
node_bin="$cli_root/runtime/bin/node"

[[ -f "$current_file" && ! -L "$current_file" ]] || {
  printf 'Canvas Notebook CLI activation state is missing or unsafe: %s\n' "$current_file" >&2
  exit 78
}

current_version="$(tr -d '\r\n' < "$current_file")"
[[ "$current_version" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$ ]] || {
  printf 'Canvas Notebook CLI activation version is invalid.\n' >&2
  exit 78
}

release_root="$cli_root/releases/$current_version"
main_js="$release_root/dist-cli/main.js"
[[ -d "$release_root" && ! -L "$release_root" && -f "$main_js" && ! -L "$main_js" ]] || {
  printf 'Canvas Notebook CLI release is missing or unsafe: %s\n' "$release_root" >&2
  exit 78
}
[[ -f "$node_bin" && ! -L "$node_bin" && -x "$node_bin" ]] || {
  printf 'Canvas Notebook CLI runtime is missing or unsafe: %s\n' "$node_bin" >&2
  exit 78
}

export CANVAS_CLI_ROOT="$release_root"
export CANVAS_CLI_LINUX_ROOT="$cli_root"
exec "$node_bin" "$main_js" "$@"
