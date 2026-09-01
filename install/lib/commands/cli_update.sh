#!/usr/bin/env bash

cli_update_target_bin() {
  if [[ -n "${CANVAS_CLI_PATH:-}" ]]; then
    printf '%s\n' "$CANVAS_CLI_PATH"
    return 0
  fi
  if command -v canvas-notebook >/dev/null 2>&1; then
    command -v canvas-notebook
    return 0
  fi
  printf '%s\n' "/usr/local/bin/canvas-notebook"
}

cli_update_file_fingerprint() {
  local bin_path="$1" file
  {
    for file in \
      "$bin_path" \
      "${INSTALL_DIR}/lib/commands/update.sh" \
      "${INSTALL_DIR}/lib/commands/cli_update.sh" \
      "${INSTALL_DIR}/lib/shared/postgres.sh"; do
      [[ -f "$file" ]] && cksum "$file"
    done
  } | cksum | awk '{print $1 ":" $2}'
}

cli_update_version_from_file() {
  local bin_path="$1"
  [[ -f "$bin_path" ]] || return 0
  sed -n -E 's/^CANVAS_CLI_VERSION="([^"]*)".*/\1/p' "$bin_path" | head -1
}

cli_update_release_version() {
  local version="${CANVAS_HOST_CLI_VERSION:-${CANVAS_VERSION:-v${CANVAS_CLI_VERSION:-}}}"
  version="${version#refs/tags/}"
  [[ "$version" != "latest" && "$version" != "main" ]] || return 1
  [[ "$version" =~ ^v?[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$ ]] || return 1
  [[ "$version" == v* ]] || version="v${version}"
  printf '%s\n' "$version"
}

cli_update_sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    return 1
  fi
}

cli_update_validate_archive() {
  local archive="$1" list_file="$2" entry type
  tar -tzf "$archive" > "$list_file" || return 1
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" == canvas-notebook-host-cli || "$entry" == canvas-notebook-host-cli/* ]] || return 1
    [[ "$entry" != /* && "$entry" != *"/../"* && "$entry" != ../* && "$entry" != *"/.." ]] || return 1
  done < "$list_file"
  while IFS= read -r type; do
    [[ "$type" == "-" || "$type" == "d" ]] || return 1
  done < <(tar -tvzf "$archive" | awk '{print substr($1, 1, 1)}')
  grep -Fxq 'canvas-notebook-host-cli/VERSION' "$list_file" || return 1
  grep -Fxq 'canvas-notebook-host-cli/install.sh' "$list_file" || return 1
  grep -Fxq 'canvas-notebook-host-cli/install/bin/canvas-notebook' "$list_file" || return 1
  grep -Fxq 'canvas-notebook-host-cli/install/lib/common.sh' "$list_file" || return 1
  grep -Fxq 'canvas-notebook-host-cli/install/lib/systemd.sh' "$list_file" || return 1
}

cli_update_install_release() {
  local version version_value repo asset_name checksum_name base_url archive_url checksum_url
  local tmp_dir archive checksum_file expected_digest checksum_asset actual_digest package_root bundled_version
  version="$(cli_update_release_version)" || return 1
  version_value="${version#v}"
  if [[ "${CANVAS_HOST_CLI_FORCE_UPDATE:-false}" != "true" && "$version_value" == "${CANVAS_CLI_VERSION:-}" ]]; then
    return 0
  fi
  repo="${CANVAS_REPO:-canvascoding/canvas-notebook}"
  asset_name="canvas-notebook-host-cli.tar.gz"
  checksum_name="canvas-notebook-host-cli.sha256"
  base_url="https://github.com/${repo}/releases/download/${version}"
  archive_url="${CANVAS_HOST_CLI_URL:-${base_url}/${asset_name}}"
  checksum_url="${CANVAS_HOST_CLI_SHA256_URL:-${base_url}/${checksum_name}}"
  if [[ "${CANVAS_HOST_CLI_ALLOW_FILE_URL:-false}" != "true" ]]; then
    [[ "$archive_url" == "${base_url}/${asset_name}" && "$checksum_url" == "${base_url}/${checksum_name}" ]] || return 1
  fi
  [[ "$archive_url" != *"raw.githubusercontent.com"* && "$archive_url" != *"/main/"* && "$archive_url" != *"/latest/"* ]] || return 1

  tmp_dir="$(mktemp -d /tmp/canvas-notebook-host-cli.XXXXXX)"
  archive="${tmp_dir}/${asset_name}"
  checksum_file="${tmp_dir}/${checksum_name}"
  if ! curl -fsSL "$archive_url" -o "$archive" || ! curl -fsSL "$checksum_url" -o "$checksum_file"; then
    rm -rf "$tmp_dir"
    return 1
  fi
  read -r expected_digest checksum_asset < "$checksum_file" || true
  checksum_asset="${checksum_asset#\*}"
  if [[ ! "$expected_digest" =~ ^[a-f0-9]{64}$ || "$checksum_asset" != "$asset_name" ]]; then
    rm -rf "$tmp_dir"
    return 1
  fi
  actual_digest="$(cli_update_sha256_file "$archive")" || { rm -rf "$tmp_dir"; return 1; }
  if [[ "$actual_digest" != "$expected_digest" ]] || ! cli_update_validate_archive "$archive" "${tmp_dir}/entries.txt"; then
    rm -rf "$tmp_dir"
    return 1
  fi
  mkdir -p "${tmp_dir}/extract"
  if ! tar -xzf "$archive" -C "${tmp_dir}/extract"; then
    rm -rf "$tmp_dir"
    return 1
  fi
  package_root="${tmp_dir}/extract/canvas-notebook-host-cli"
  bundled_version="$(tr -d '\r\n' < "${package_root}/VERSION")"
  if [[ "$bundled_version" != "$version_value" ]]; then
    rm -rf "$tmp_dir"
    return 1
  fi
  if ! CANVAS_OPERATION_LOCK_INHERIT_TOKEN="${CANVAS_OPERATION_LOCK_NONCE:-}" \
    CANVAS_VERSION="$version" \
    CLI_UPDATE_ONLY=true CANVAS_CLI_SELF_UPDATE_REEXEC=true bash "${package_root}/install.sh"; then
    rm -rf "$tmp_dir"
    return 1
  fi
  rm -rf "$tmp_dir"
}

cli_update_reexec_if_changed() {
  local command_name="$1"
  shift || true

  if [[ "${CANVAS_CLI_SELF_UPDATE_REEXEC:-false}" == "true" ]]; then
    return 0
  fi
  if is_false "${CANVAS_CLI_SELF_UPDATE:-true}"; then
    return 0
  fi

  local bin_path before_fingerprint after_fingerprint before_version after_version
  bin_path="$(cli_update_target_bin)"
  before_fingerprint="$(cli_update_file_fingerprint "$bin_path")"
  before_version="$(cli_update_version_from_file "$bin_path")"

  info "Checking management CLI before ${command_name}..."
  if ! cli_update_install_release; then
    fail "Verified management CLI release update failed before ${command_name}."
  fi

  after_fingerprint="$(cli_update_file_fingerprint "$bin_path")"
  after_version="$(cli_update_version_from_file "$bin_path")"
  if [[ "$after_fingerprint" == "$before_fingerprint" ]]; then
    return 0
  fi

  local exec_args
  exec_args=("$command_name")
  [[ "${OUTPUT_JSON:-false}" == "true" ]] && exec_args+=(--json)
  [[ "${NO_BANNER:-false}" == "true" ]] && exec_args+=(--no-banner)
  exec_args+=("$@")

  ok "Management CLI updated ${before_version:-unknown} -> ${after_version:-unknown}"
  info "Restarting ${command_name} with updated CLI..."
  CANVAS_CLI_SELF_UPDATE_REEXEC=true exec "$bin_path" "${exec_args[@]}"
}

cmd_cli_update() {
  log_msg "cli-update started"
  info "Downloading the pinned, checksummed host CLI release..."
  info "Installing the verified CLI and systemd service..."
  if cli_update_install_release; then
    ok "Canvas Notebook management CLI updated successfully"
    log_msg "cli-update completed"
  else
    fail "CLI update failed — previous version is still in place"
  fi
  info "Running Caddy configuration health fix..."
  caddy_fix >/dev/null 2>&1 || true
}
