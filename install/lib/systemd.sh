#!/usr/bin/env bash

install_manager_config() {
  local config_json_path="${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook-config.json"

  require_jq

  section "Manager config"
  if [[ ! -f "$config_json_path" ]]; then
    _ensure_dir_writable "$(dirname "$config_json_path")"
    local m_tmp
    m_tmp="$(mktemp)"
    printf '%s\n' "$CONFIG_JSON_DEFAULTS" > "$m_tmp"
    _write_owned_file "$config_json_path" "$m_tmp"
    rm -f "$m_tmp"
  fi

  local install_dir_val data_dir_val
  install_dir_val="${INSTALL_DIR:-/opt/canvas-notebook}"
  data_dir_val="${DATA_DIR:-${HOME:-/opt}/canvas-notebook-data}"

  _config_json_raw_write "$config_json_path" "dataDir" "\"$data_dir_val\""
  _config_json_raw_write "$config_json_path" "swap.enabled" "\"${CANVAS_SWAP_ENABLED:-false}\""
  _config_json_raw_write "$config_json_path" "swap.size" "\"${CANVAS_SWAP_SIZE:-2G}\""
  _config_json_raw_write "$config_json_path" "swap.file" "\"${CANVAS_SWAP_FILE:-/swapfile}\""
  _config_json_raw_write "$config_json_path" "autoUpdate.enabled" "\"${CANVAS_AUTO_UPDATE_ENABLED:-true}\""
  _config_json_raw_write "$config_json_path" "autoUpdate.schedule" "\"${CANVAS_AUTO_UPDATE_SCHEDULE:-*-*-* 04:00:00}\""

  ok "Wrote ${config_json_path}"
}

_config_json_raw_write() {
  local file="$1" key="$2" json_value="$3" tmp
  tmp="$(mktemp)"
  jq --arg k "$key" --argjson v "$json_value" 'setpath($k | split("."); $v)' "$file" > "$tmp"
  _write_owned_file "$file" "$tmp"
  rm -f "$tmp"
}

install_management_cli() {
  local bin_path fallback_bin_path shared_dir
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

  shared_dir="${INSTALL_DIR}/lib/shared"
  _ensure_dir_writable "$shared_dir"
  for _lib in output utils config_json config logging compose caddy swap container docker ui; do
    if [[ -f "${SUPPORT_DIR}/lib/shared/${_lib}.sh" ]]; then
      _write_owned_file "${shared_dir}/${_lib}.sh" "${SUPPORT_DIR}/lib/shared/${_lib}.sh"
    fi
  done
  unset _lib

  local commands_dir="${INSTALL_DIR}/lib/commands"
  _ensure_dir_writable "$commands_dir"
  for _cmd_file in "${SUPPORT_DIR}/lib/commands/"*.sh; do
    if [[ -f "$_cmd_file" ]]; then
      _write_owned_file "${commands_dir}/$(basename "$_cmd_file")" "$_cmd_file"
    fi
  done
  unset _cmd_file

  local template_dir="${INSTALL_DIR}/templates"
  _ensure_dir_writable "$template_dir"
  for _tpl_file in "${SUPPORT_DIR}/templates/"*; do
    if [[ -f "$_tpl_file" ]]; then
      _write_owned_file "${template_dir}/$(basename "$_tpl_file")" "$_tpl_file"
    fi
  done
  unset _tpl_file

  require_jq

  ok "Installed management CLI: ${bin_path}"
  ok "Deployed shared libraries to ${shared_dir}"
  ok "Deployed templates to ${template_dir}"
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
  local template_dir="${SUPPORT_DIR:-${INSTALL_DIR:-/opt/canvas-notebook}}/templates"
  sed -e "s|__INSTALL_DIR__|${escaped_install_dir}|g" \
      -e "s|__CLI_PATH__|${escaped_cli_path}|g" \
      "${template_dir}/canvas-notebook.service" > "$tmp_service"

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

install_update_timer() {
  local timer_path service_path cli_path tmp_timer tmp_service escaped_cli_path escaped_schedule
  timer_path="/etc/systemd/system/canvas-notebook-update.timer"
  service_path="/etc/systemd/system/canvas-notebook-update.service"
  cli_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"
  local config_json_path="${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook-config.json"

  require_jq

  local update_enabled update_schedule
  if [[ -f "$config_json_path" ]]; then
    update_enabled="$(jq -r '.autoUpdate.enabled // true' "$config_json_path")"
    update_schedule="$(jq -r '.autoUpdate.schedule // "*-*-* 04:00:00"' "$config_json_path")"
  else
    update_enabled="${CANVAS_AUTO_UPDATE_ENABLED:-true}"
    update_schedule="${CANVAS_AUTO_UPDATE_SCHEDULE:-*-*-* 04:00:00}"
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not found — skipping auto-update timer installation."
    return 0
  fi

  escaped_cli_path="$(sed_replacement_escape "$cli_path")"
  escaped_schedule="$(sed_replacement_escape "$update_schedule")"

  local template_dir="${SUPPORT_DIR:-${INSTALL_DIR:-/opt/canvas-notebook}}/templates"

  tmp_timer="$(mktemp)"
  sed -e "s|__CANVAS_AUTO_UPDATE_SCHEDULE__|${escaped_schedule}|g" \
      "${template_dir}/canvas-notebook-update.timer" > "$tmp_timer"

  tmp_service="$(mktemp)"
  sed -e "s|__CLI_PATH__|${escaped_cli_path}|g" \
      "${template_dir}/canvas-notebook-update.service" > "$tmp_service"

  section "Auto-update timer"
  run_root install -m 644 "$tmp_timer" "$timer_path"
  run_root install -m 644 "$tmp_service" "$service_path"
  rm -f "$tmp_timer" "$tmp_service"

  run_root systemctl daemon-reload

  if is_false "$update_enabled"; then
    run_root systemctl disable canvas-notebook-update.timer >/dev/null 2>&1 || true
    run_root systemctl stop canvas-notebook-update.timer >/dev/null 2>&1 || true
    ok "Auto-update timer installed (disabled)"
  else
    run_root systemctl enable canvas-notebook-update.timer >/dev/null
    run_root systemctl start canvas-notebook-update.timer >/dev/null 2>&1 || true
    ok "Auto-update timer installed and enabled (schedule: ${update_schedule})"
    info "Next run: $(systemctl show canvas-notebook-update.timer --property=NextElapseUSecRealtime 2>/dev/null | cut -d= -f2- || echo 'pending')"
    info "View schedule: systemctl list-timers canvas-notebook-update.timer"
  fi
}