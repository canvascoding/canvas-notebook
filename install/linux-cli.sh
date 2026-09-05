#!/usr/bin/env bash
# Install or roll back the self-contained Canvas Notebook Linux CLI.
#
# Install the latest release:
#   curl -fsSL https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/linux-cli.sh | sudo bash
#
# Explicitly roll back to the previous TypeScript release (or the preserved
# legacy Bash CLI after the first migration):
#   sudo /opt/canvas/cli/install/linux-cli.sh rollback

set -euo pipefail

REPO="${CANVAS_REPO:-canvascoding/canvas-notebook}"
VERSION="${CANVAS_VERSION:-${CANVAS_CLI_VERSION:-latest}}"
CLI_ROOT="${CANVAS_LINUX_CLI_ROOT:-/opt/canvas/cli}"
BIN_PATH="${CANVAS_LINUX_CLI_BIN_PATH:-/usr/local/bin/canvas-notebook}"
ALLOW_FILE_URL="${CANVAS_LINUX_CLI_ALLOW_FILE_URL:-false}"
INSTALL_TMP_ROOT=""

cleanup() {
  [[ -z "$INSTALL_TMP_ROOT" ]] || rm -rf -- "$INSTALL_TMP_ROOT"
}

trap cleanup EXIT

say() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

linux_arch() {
  case "$(uname -m)" in
    x86_64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) fail "Unsupported Linux architecture: $(uname -m)" ;;
  esac
}

is_release_version() {
  [[ "$1" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$ ]]
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    fail "sha256sum, shasum, or openssl is required"
  fi
}

copy_source() {
  local source="$1" output="$2"
  case "$source" in
    file://*)
      [[ "$ALLOW_FILE_URL" == "true" ]] || fail "file:// assets require CANVAS_LINUX_CLI_ALLOW_FILE_URL=true"
      cp -- "${source#file://}" "$output"
      ;;
    http://*|https://*)
      require_command curl
      curl -fsSL --retry 3 --connect-timeout 20 -o "$output" "$source"
      ;;
    *)
      [[ -f "$source" ]] || fail "Asset does not exist: $source"
      cp -- "$source" "$output"
      ;;
  esac
}

asset_url() {
  local asset="$1" archive_name="$2" checksum_name="$3"
  if [[ -n "${CANVAS_LINUX_CLI_BASE_URL:-}" ]]; then
    printf '%s/%s' "${CANVAS_LINUX_CLI_BASE_URL%/}" "$asset"
  elif [[ "$asset" == "$archive_name" && -n "${CANVAS_LINUX_CLI_URL:-}" ]]; then
    printf '%s' "$CANVAS_LINUX_CLI_URL"
  elif [[ "$asset" == "$checksum_name" && -n "${CANVAS_LINUX_CLI_SHA256_URL:-}" ]]; then
    printf '%s' "$CANVAS_LINUX_CLI_SHA256_URL"
  elif [[ -z "$VERSION" || "$VERSION" == "latest" ]]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$asset"
  else
    printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "${VERSION#refs/tags/}" "$asset"
  fi
}

validate_archive() {
  local archive="$1" package_name="$2" list_file="$3" entry type
  tar -tzf "$archive" > "$list_file" || return 1
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
    [[ "$entry" == "$package_name" || "$entry" == "$package_name/"* ]] || return 1
    [[ "$entry" != /* && "$entry" != *"/../"* && "$entry" != ../* && "$entry" != *"/.." ]] || return 1
  done < "$list_file"
  while IFS= read -r type; do
    [[ "$type" == "-" || "$type" == "d" ]] || return 1
  done < <(LC_ALL=C tar -tvzf "$archive" | awk '{print substr($1, 1, 1)}')
  grep -Fxq "${package_name}/VERSION" "$list_file" || return 1
  grep -Fxq "${package_name}/manifest.json" "$list_file" || return 1
  grep -Fxq "${package_name}/bin/canvas-notebook" "$list_file" || return 1
  grep -Fxq "${package_name}/runtime/bin/node" "$list_file" || return 1
  grep -Fxq "${package_name}/state/current" "$list_file" || return 1
}

validate_package() {
  local package_root="$1" architecture="$2" version runtime launcher version_json
  version="$(tr -d '\r\n' < "${package_root}/VERSION")"
  is_release_version "$version" || fail "Package VERSION is invalid"
  runtime="${package_root}/runtime/bin/node"
  launcher="${package_root}/bin/canvas-notebook"
  [[ -x "$runtime" && ! -L "$runtime" ]] || fail "Package runtime is missing or unsafe"
  [[ -x "$launcher" && ! -L "$launcher" ]] || fail "Package launcher is missing or unsafe"
  [[ -f "${package_root}/releases/${version}/dist-cli/main.js" ]] || fail "Package release is incomplete"
  "$runtime" -e '
    const fs = require("node:fs");
    const [file, arch, version] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.platform !== "linux" ||
        manifest.architecture !== arch || manifest.cliVersion !== version ||
        manifest.runtimeValidated !== true) process.exit(1);
  ' "${package_root}/manifest.json" "$architecture" "$version" || fail "Package manifest validation failed"
  version_json="$(
    CANVAS_CLI_SELF_UPDATE=false \
    CANVAS_INSTALL_DIR="${package_root}/.smoke-manager" \
    CANVAS_DATA_DIR="${package_root}/.smoke-data" \
    "$launcher" version --json
  )" || fail "Packaged CLI smoke test failed"
  "$runtime" -e '
    const [raw, expected] = process.argv.slice(1);
    const value = JSON.parse(raw);
    if (value.cliGeneration !== "typescript" || value.cliVersion !== expected) process.exit(1);
  ' "$version_json" "$version" || fail "Packaged CLI version validation failed"
  printf '%s' "$version"
}

atomic_install_file() {
  local source="$1" target="$2" mode="$3" tmp
  mkdir -p "$(dirname "$target")"
  tmp="${target}.new.$$"
  rm -f -- "$tmp"
  install -m "$mode" "$source" "$tmp"
  mv -f -- "$tmp" "$target"
}

write_state() {
  local name="$1" value="$2" target tmp
  target="${CLI_ROOT}/state/${name}"
  mkdir -p "${CLI_ROOT}/state"
  [[ ! -L "$target" ]] || fail "Unsafe activation state: $target"
  tmp="${target}.new.$$"
  printf '%s\n' "$value" > "$tmp"
  chmod 644 "$tmp"
  mv -f -- "$tmp" "$target"
}

read_state() {
  local name="$1" target="${CLI_ROOT}/state/${1}"
  [[ ! -L "$target" ]] || fail "Unsafe activation state: $target"
  [[ -f "$target" ]] || return 0
  tr -d '\r\n' < "$target"
}

capture_legacy_cli() {
  local managed_launcher="${CLI_ROOT}/bin/canvas-notebook" resolved="" legacy="${CLI_ROOT}/legacy/canvas-notebook"
  if [[ -L "$BIN_PATH" ]]; then
    resolved="$(readlink -f -- "$BIN_PATH" 2>/dev/null || true)"
    [[ "$resolved" != "$managed_launcher" && "$resolved" != "$legacy" ]] || return 0
  elif [[ ! -e "$BIN_PATH" ]]; then
    return 0
  fi
  [[ ! -d "$BIN_PATH" && -f "$BIN_PATH" && -x "$BIN_PATH" ]] || fail "Existing CLI entrypoint is not a regular executable: $BIN_PATH"
  if [[ ! -e "$legacy" ]]; then
    mkdir -p "${CLI_ROOT}/legacy"
    install -m 755 "$(readlink -f -- "$BIN_PATH" 2>/dev/null || printf '%s' "$BIN_PATH")" "$legacy"
    say "Preserved existing CLI at $legacy"
  fi
}

retire_legacy_cli() {
  local previous="$1" legacy_dir="${CLI_ROOT}/legacy" legacy="${CLI_ROOT}/legacy/canvas-notebook"
  [[ -n "$previous" ]] || return 0
  [[ -f "${CLI_ROOT}/releases/${previous}/dist-cli/main.js" ]] || fail "Previous TypeScript CLI release is missing"
  rm -f -- "$legacy" "${CLI_ROOT}/state/legacy-active"
  rmdir -- "$legacy_dir" 2>/dev/null || true
  say "Retired the preserved legacy CLI; rollback remains available through TypeScript CLI ${previous}"
}

activate_entrypoint() {
  local target="$1" tmp="${BIN_PATH}.new.$$"
  # A service with ProtectSystem=full can update releases under /opt, but
  # cannot rewrite /usr/local/bin. Its existing managed entrypoint is stable.
  if [[ -L "$BIN_PATH" && "$(readlink "$BIN_PATH")" == "$target" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$BIN_PATH")"
  rm -f -- "$tmp"
  ln -s "$target" "$tmp"
  mv -f -- "$tmp" "$BIN_PATH"
}

install_release() {
  local architecture package_name archive_name checksum_name tmp_root archive checksum expected checksum_asset actual
  local package_root version release_source release_target release_stage current
  [[ "$(uname -s)" == "Linux" ]] || fail "The Linux CLI installer only runs on Linux"
  architecture="$(linux_arch)"
  package_name="canvas-notebook-linux-cli-${architecture}"
  archive_name="${package_name}.tar.gz"
  checksum_name="${package_name}.sha256"
  require_command tar
  require_command install
  tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/canvas-linux-cli.XXXXXX")"
  INSTALL_TMP_ROOT="$tmp_root"
  archive="${tmp_root}/${archive_name}"
  checksum="${tmp_root}/${checksum_name}"
  copy_source "${CANVAS_LINUX_CLI_ARCHIVE:-$(asset_url "$archive_name" "$archive_name" "$checksum_name")}" "$archive"
  copy_source "${CANVAS_LINUX_CLI_CHECKSUM:-$(asset_url "$checksum_name" "$archive_name" "$checksum_name")}" "$checksum"
  read -r expected checksum_asset < "$checksum" || true
  checksum_asset="${checksum_asset#\*}"
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ && "$checksum_asset" == "$archive_name" ]] || fail "Checksum file is invalid"
  actual="$(sha256_file "$archive")"
  [[ "${actual,,}" == "${expected,,}" ]] || fail "Linux CLI checksum verification failed"
  validate_archive "$archive" "$package_name" "${tmp_root}/entries.txt" || fail "Linux CLI archive validation failed"
  mkdir "${tmp_root}/extract"
  tar --no-same-owner --no-same-permissions -xzf "$archive" -C "${tmp_root}/extract"
  package_root="${tmp_root}/extract/${package_name}"
  version="$(validate_package "$package_root" "$architecture")"

  mkdir -p "${CLI_ROOT}/releases" "${CLI_ROOT}/runtime/bin" "${CLI_ROOT}/bin" "${CLI_ROOT}/install" "${CLI_ROOT}/state"
  capture_legacy_cli
  release_source="${package_root}/releases/${version}"
  release_target="${CLI_ROOT}/releases/${version}"
  if [[ ! -d "$release_target" ]]; then
    release_stage="$(mktemp -d "${CLI_ROOT}/releases/.${version}.staging.XXXXXX")"
    cp -a "${release_source}/." "$release_stage/"
    [[ -f "${release_stage}/dist-cli/main.js" && ! -L "${release_stage}/dist-cli/main.js" ]] || fail "Staged CLI release is incomplete"
    mv -- "$release_stage" "$release_target"
  fi
  [[ -f "${release_target}/dist-cli/main.js" && ! -L "$release_target" ]] || fail "Installed CLI release is unsafe"

  atomic_install_file "${package_root}/runtime/bin/node" "${CLI_ROOT}/runtime/bin/node" 755
  atomic_install_file "${package_root}/bin/canvas-notebook" "${CLI_ROOT}/bin/canvas-notebook" 755
  if [[ -f "${package_root}/install/linux-cli.sh" ]]; then
    atomic_install_file "${package_root}/install/linux-cli.sh" "${CLI_ROOT}/install/linux-cli.sh" 755
  fi
  atomic_install_file "${package_root}/manifest.json" "${CLI_ROOT}/manifest.json" 644
  atomic_install_file "${package_root}/VERSION" "${CLI_ROOT}/VERSION" 644

  current="$(read_state current)"
  if [[ -n "$current" ]]; then
    is_release_version "$current" || fail "Existing current activation state is invalid"
    [[ -f "${CLI_ROOT}/releases/${current}/dist-cli/main.js" ]] || fail "Existing current release is missing"
  fi
  if [[ "$current" != "$version" ]]; then
    write_state previous "$current"
    write_state current "$version"
  elif [[ ! -f "${CLI_ROOT}/state/previous" ]]; then
    write_state previous ""
  fi
  activate_entrypoint "${CLI_ROOT}/bin/canvas-notebook"
  rm -f -- "${CLI_ROOT}/state/legacy-active"
  retire_legacy_cli "$(read_state previous)"
  say "Canvas Notebook Linux CLI ${version} is active at ${BIN_PATH}"
}

rollback_release() {
  local current previous legacy="${CLI_ROOT}/legacy/canvas-notebook"
  current="$(read_state current)"
  previous="$(read_state previous)"
  is_release_version "$current" || fail "Current CLI activation state is invalid"
  [[ -f "${CLI_ROOT}/releases/${current}/dist-cli/main.js" ]] || fail "Current CLI release is missing"
  if [[ -n "$previous" ]]; then
    is_release_version "$previous" || fail "Previous CLI activation state is invalid"
    [[ -f "${CLI_ROOT}/releases/${previous}/dist-cli/main.js" ]] || fail "Previous CLI release is missing"
    write_state previous "$current"
    write_state current "$previous"
    activate_entrypoint "${CLI_ROOT}/bin/canvas-notebook"
    rm -f -- "${CLI_ROOT}/state/legacy-active"
    say "Rolled back Canvas Notebook Linux CLI ${current} -> ${previous}"
    return 0
  fi
  [[ -x "$legacy" && ! -L "$legacy" ]] || fail "No previous CLI release or preserved legacy CLI is available"
  activate_entrypoint "$legacy"
  write_state legacy-active "legacy"
  say "Rolled back to the explicitly preserved legacy CLI"
}

case "${1:-install}" in
  install) install_release ;;
  rollback) rollback_release ;;
  *) fail "Usage: linux-cli.sh [install|rollback]" ;;
esac
