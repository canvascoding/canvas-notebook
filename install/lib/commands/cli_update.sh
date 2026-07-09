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

cli_update_install_latest() {
  local tmp_installer
  tmp_installer="$(mktemp /tmp/canvas-notebook-install.XXXXXX.sh)"
  if ! curl -fsSL "$INSTALL_SCRIPT_URL" -o "$tmp_installer"; then
    rm -f "$tmp_installer"
    return 1
  fi
  chmod +x "$tmp_installer"
  if CLI_UPDATE_ONLY=true CANVAS_CLI_SELF_UPDATE_REEXEC=true bash "$tmp_installer"; then
    rm -f "$tmp_installer"
    return 0
  fi
  rm -f "$tmp_installer"
  return 1
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
  if ! cli_update_install_latest; then
    warn "Could not update management CLI before ${command_name}; continuing with CLI ${CANVAS_CLI_VERSION:-unknown}."
    return 0
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
  info "Downloading latest installer from GitHub..."
  info "Installing updated CLI and systemd service..."
  if cli_update_install_latest; then
    ok "Canvas Notebook management CLI updated successfully"
    log_msg "cli-update completed"
  else
    fail "CLI update failed — previous version is still in place"
  fi
  info "Running Caddy configuration health fix..."
  caddy_fix >/dev/null 2>&1 || true
}
