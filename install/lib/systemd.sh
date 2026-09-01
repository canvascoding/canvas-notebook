#!/usr/bin/env bash

install_manager_config() {
  local config_json_path="${CONFIG_JSON_PATH:-${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook-config.json}"

  require_jq

  section "Manager config"
  local data_dir_val swap_enabled_val swap_enabled_raw auto_update_enabled_val
  data_dir_val="${DATA_DIR:-${HOME:-/opt}/canvas-notebook-data}"
  swap_enabled_raw="$(printf '%s' "${CANVAS_SWAP_ENABLED:-false}" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$swap_enabled_raw" in
    true|1|yes|on) swap_enabled_val=true ;;
    false|0|no|off|disabled) swap_enabled_val=false ;;
    *) fail "CANVAS_SWAP_ENABLED must be true or false" ;;
  esac
  auto_update_enabled_val=false
  if ! is_false "${CANVAS_AUTO_UPDATE_ENABLED:-false}"; then
    auto_update_enabled_val=true
  fi

  with_canvas_swap_lock install_manager_config_unlocked "$config_json_path" "$data_dir_val" "$swap_enabled_val" "$auto_update_enabled_val" || return 1

  ok "Wrote ${config_json_path}"
}

_config_json_raw_write() {
  local file="$1" key="$2" json_value="$3" tmp
  tmp="$(mktemp)" || return 1
  if ! jq --arg k "$key" --argjson v "$json_value" 'setpath($k | split("."); $v)' "$file" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! _write_secure_config_file "$file" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp" || true
}

install_manager_config_unlocked() {
  local config_json_path="$1" data_dir_val="$2" swap_enabled_val="$3" auto_update_enabled_val="$4" m_tmp
  if [[ ! -f "$config_json_path" ]]; then
    _ensure_dir_writable "$(dirname "$config_json_path")" || return 1
    m_tmp="$(mktemp)" || return 1
    if ! printf '%s\n' "$CONFIG_JSON_DEFAULTS" > "$m_tmp" || ! _write_secure_config_file "$config_json_path" "$m_tmp"; then
      rm -f "$m_tmp"
      return 1
    fi
    rm -f "$m_tmp" || true
  fi
  _config_json_raw_write "$config_json_path" "dataDir" "\"$data_dir_val\"" || return 1
  config_json_write_swap "$swap_enabled_val" "${CANVAS_SWAP_SIZE:-2G}" "${CANVAS_SWAP_FILE:-/swapfile}" "${CANVAS_SWAP_SWAPPINESS:-10}" || return 1

  if declare -f config_json_managed_by_control_plane > /dev/null 2>&1 && config_json_managed_by_control_plane; then
    if [[ "$auto_update_enabled_val" != "false" ]]; then
      warn "Managed by Control Plane — ignoring CANVAS_AUTO_UPDATE_ENABLED=true and forcing autoUpdate.enabled=false"
    fi
    auto_update_enabled_val=false
  fi

  _config_json_raw_write "$config_json_path" "autoUpdate.enabled" "$auto_update_enabled_val" || return 1
  _config_json_raw_write "$config_json_path" "autoUpdate.schedule" "\"${CANVAS_AUTO_UPDATE_SCHEDULE:-*-*-* 04:00:00}\""
}

install_management_cli() {
  local bin_path fallback_bin_path shared_dir code_owner linux_cli_root linux_cli_installer env_name
  local -a linux_cli_env
  bin_path="${CANVAS_CLI_PATH:-/usr/local/bin/canvas-notebook}"
  fallback_bin_path="/usr/bin/canvas-notebook"
  code_owner="$(_host_code_owner)"
  linux_cli_root="${CANVAS_LINUX_CLI_ROOT:-/opt/canvas/cli}"
  linux_cli_installer="${CANVAS_LINUX_CLI_INSTALLER_PATH:-${SUPPORT_DIR}/linux-cli.sh}"

  section "Management CLI"
  [[ -f "$linux_cli_installer" && ! -L "$linux_cli_installer" ]] || fail "Linux CLI installer is missing or unsafe: ${linux_cli_installer}"

  shared_dir="${INSTALL_DIR}/lib/shared"
  _ensure_dir_writable "$shared_dir"
  for _lib in output utils config_json config logging compose caddy swap container docker postgres ui; do
    if [[ -f "${SUPPORT_DIR}/lib/shared/${_lib}.sh" ]]; then
      _write_owned_file "${shared_dir}/${_lib}.sh" "${SUPPORT_DIR}/lib/shared/${_lib}.sh"
    fi
  done
  unset _lib
  _write_owned_file "${INSTALL_DIR}/lib/systemd.sh" "${SUPPORT_DIR}/lib/systemd.sh"

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

  linux_cli_env=(
    "CANVAS_LINUX_CLI_ROOT=${linux_cli_root}"
    "CANVAS_LINUX_CLI_BIN_PATH=${bin_path}"
  )
  for env_name in \
    CANVAS_REPO \
    CANVAS_VERSION \
    CANVAS_CLI_VERSION \
    CANVAS_LINUX_CLI_ALLOW_FILE_URL \
    CANVAS_LINUX_CLI_ARCHIVE \
    CANVAS_LINUX_CLI_CHECKSUM \
    CANVAS_LINUX_CLI_BASE_URL \
    CANVAS_LINUX_CLI_URL \
    CANVAS_LINUX_CLI_SHA256_URL; do
    if [[ -n "${!env_name+x}" ]]; then
      linux_cli_env+=("${env_name}=${!env_name}")
    fi
  done
  if [[ "$code_owner" != "root:root" && -w "$(dirname "$bin_path")" && -w "$(dirname "$linux_cli_root")" ]]; then
    env "${linux_cli_env[@]}" bash "$linux_cli_installer" install
  else
    run_root env "${linux_cli_env[@]}" bash "$linux_cli_installer" install
  fi

  if [[ "$bin_path" == "/usr/local/bin/canvas-notebook" ]]; then
    run_root ln -sf "$bin_path" "$fallback_bin_path" 2>/dev/null || true
  fi

  require_jq

  ok "Installed TypeScript management CLI: ${bin_path}"
  info "Legacy support libraries remain frozen for first-cutover rollback compatibility."
  [[ "$bin_path" == "/usr/local/bin/canvas-notebook" && -x "$fallback_bin_path" ]] && info "Also available as: ${fallback_bin_path}"
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

  info "Reloading systemd daemon..."
  run_root systemctl daemon-reload
  if [[ "${CLI_UPDATE_ONLY:-false}" != "true" ]]; then
    info "Enabling ${SYSTEMD_SERVICE}..."
    run_root systemctl enable "$SYSTEMD_SERVICE" 2>&1
    info "Starting ${SYSTEMD_SERVICE}..."
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

  local update_enabled update_schedule managed_by_control_plane
  if [[ -f "$config_json_path" ]]; then
    update_enabled="$(jq -r '.autoUpdate.enabled // false' "$config_json_path")"
    update_schedule="$(jq -r '.autoUpdate.schedule // "*-*-* 04:00:00"' "$config_json_path")"
  else
    update_enabled="${CANVAS_AUTO_UPDATE_ENABLED:-false}"
    update_schedule="${CANVAS_AUTO_UPDATE_SCHEDULE:-*-*-* 04:00:00}"
  fi

  managed_by_control_plane=false
  if declare -f config_json_managed_by_control_plane >/dev/null 2>&1 && config_json_managed_by_control_plane; then
    managed_by_control_plane=true
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not found — skipping auto-update timer installation."
    return 0
  fi

  if [[ "$managed_by_control_plane" == "true" ]]; then
    warn "Managed by Control Plane — autonomous auto-update timer must stay disabled."
    update_enabled=false
    if [[ -f "$config_json_path" ]]; then
      _config_json_raw_write "$config_json_path" "autoUpdate.enabled" "false" >/dev/null 2>&1 || true
      info "Set autoUpdate.enabled=false in ${config_json_path}"
    fi
    if [[ -f "$timer_path" || -f "$service_path" ]]; then
      info "Stopping and removing legacy auto-update systemd units..."
      run_root systemctl stop canvas-notebook-update.timer >/dev/null 2>&1 || true
      run_root systemctl stop canvas-notebook-update.service >/dev/null 2>&1 || true
      run_root systemctl disable canvas-notebook-update.timer >/dev/null 2>&1 || true
      run_root systemctl disable canvas-notebook-update.service >/dev/null 2>&1 || true
      run_root rm -f "$timer_path" "$service_path"
      run_root systemctl daemon-reload
      run_root systemctl reset-failed canvas-notebook-update.timer canvas-notebook-update.service >/dev/null 2>&1 || true
      ok "Removed legacy auto-update systemd units (managed mode)"
    fi
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

  info "Reloading systemd daemon..."
  run_root systemctl daemon-reload

  if is_false "$update_enabled"; then
    run_root systemctl stop canvas-notebook-update.timer >/dev/null 2>&1 || true
    run_root systemctl stop canvas-notebook-update.service >/dev/null 2>&1 || true
    run_root systemctl disable canvas-notebook-update.timer >/dev/null 2>&1 || true
    run_root systemctl disable canvas-notebook-update.service >/dev/null 2>&1 || true
    run_root systemctl reset-failed canvas-notebook-update.timer canvas-notebook-update.service >/dev/null 2>&1 || true
    ok "Auto-update timer installed (disabled)"
  else
    run_root systemctl stop canvas-notebook-update.timer >/dev/null 2>&1 || true
    info "Enabling auto-update timer..."
    run_root systemctl enable canvas-notebook-update.timer 2>&1
    info "Starting auto-update timer..."
    if ! run_root systemctl start canvas-notebook-update.timer 2>&1; then
      warn "Auto-update timer enabled but could not be started immediately"
      warn "It will activate on the next scheduled run or after a reboot."
    fi
    ok "Auto-update timer installed and enabled (schedule: ${update_schedule})"
    info "Next run: $(systemctl show canvas-notebook-update.timer --property=NextElapseUSecRealtime 2>/dev/null | cut -d= -f2- || echo 'pending')"
    info "View schedule: systemctl list-timers canvas-notebook-update.timer"
  fi
}
