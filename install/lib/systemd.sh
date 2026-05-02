#!/usr/bin/env bash

install_manager_config() {
  local config_dir config_path install_dir_q compose_path_q data_dir_q swap_enabled_q swap_size_q swap_file_q log_dir_q
  config_dir="/etc/canvas-notebook"
  config_path="${config_dir}/manager.env"

  printf -v install_dir_q '%q' "$INSTALL_DIR"
  printf -v compose_path_q '%q' "$COMPOSE_FILE"
  printf -v data_dir_q '%q' "$DATA_DIR"
  printf -v swap_enabled_q '%q' "$CANVAS_SWAP_ENABLED"
  printf -v swap_size_q '%q' "$CANVAS_SWAP_SIZE"
  printf -v swap_file_q '%q' "$CANVAS_SWAP_FILE"
  printf -v log_dir_q '%q' "/var/log/canvas-notebook"

  section "Manager config"
  run_root mkdir -p "$config_dir" /var/log/canvas-notebook
  run_root tee "$config_path" > /dev/null <<EOF
INSTALL_DIR=${install_dir_q}
COMPOSE_FILE=${compose_path_q}
DATA_DIR=${data_dir_q}
CANVAS_SWAP_ENABLED=${swap_enabled_q}
CANVAS_SWAP_SIZE=${swap_size_q}
CANVAS_SWAP_FILE=${swap_file_q}
SERVICE=canvas-notebook
CANVAS_MANAGER_LOG_DIR=${log_dir_q}
EOF
  ok "Wrote ${config_path}"
}

install_management_cli() {
  local bin_path fallback_bin_path
  bin_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"
  fallback_bin_path="/usr/bin/canvas-notebook"

  section "Management CLI"
  if [[ -w "$(dirname "$bin_path")" ]]; then
    install -m 755 "${SUPPORT_DIR}/bin/canvas-notebook" "$bin_path"
  else
    run_root install -m 755 "${SUPPORT_DIR}/bin/canvas-notebook" "$bin_path"
  fi

  if [[ "$bin_path" != "$fallback_bin_path" ]]; then
    if [[ -w "$(dirname "$fallback_bin_path")" ]]; then
      ln -sf "$bin_path" "$fallback_bin_path" 2>/dev/null || true
    else
      run_root ln -sf "$bin_path" "$fallback_bin_path" 2>/dev/null || true
    fi
  fi

  ok "Installed management CLI: ${bin_path}"
  [[ -x "$fallback_bin_path" ]] && info "Also available as: ${fallback_bin_path}"
  info "Run: canvas-notebook help"
}

install_systemd_service() {
  local service_path cli_path tmp_service escaped_install_dir escaped_cli_path
  service_path="/etc/systemd/system/${SYSTEMD_SERVICE}"
  cli_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"
  tmp_service="$(mktemp)"

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not found — skipping host service installation."
    rm -f "$tmp_service"
    return 0
  fi

  escaped_install_dir="$(sed_replacement_escape "$INSTALL_DIR")"
  escaped_cli_path="$(sed_replacement_escape "$cli_path")"
  sed -e "s|__INSTALL_DIR__|${escaped_install_dir}|g" \
      -e "s|__CLI_PATH__|${escaped_cli_path}|g" \
      "${SUPPORT_DIR}/templates/canvas-notebook.service" > "$tmp_service"

  section "System service"
  run_root install -m 644 "$tmp_service" "$service_path"
  rm -f "$tmp_service"

  run_root systemctl daemon-reload
  if [[ "${CLI_UPDATE_ONLY:-false}" != "true" ]]; then
    run_root systemctl enable "$SYSTEMD_SERVICE" >/dev/null
    run_root systemctl start "$SYSTEMD_SERVICE"
    ok "Installed and enabled ${SYSTEMD_SERVICE}"
    info "Service logs: journalctl -u ${SYSTEMD_SERVICE}"
  else
    ok "Reloaded ${SYSTEMD_SERVICE} unit (no restart)"
  fi
}
