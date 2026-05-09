#!/usr/bin/env bash

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

status_json() {
  local cid url healthy service_active container_json install_dir_json compose_file_json data_dir_json log_file_json service_active_json

  ensure_log_file
  url="$(health_url)"
  healthy=false
  if curl -fsS "$url" >/dev/null 2>&1; then
    healthy=true
  fi

  cid="$(container_id)"
  container_json="null"
  if [[ -n "$cid" ]]; then
    container_json="$(docker_cmd inspect --format '{"id":"{{.Id}}","name":"{{.Name}}","status":"{{.State.Status}}","running":{{.State.Running}},"restarting":{{.State.Restarting}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}}}' "$cid" 2>/dev/null || printf 'null')"
  fi

  service_active="unknown"
  if command -v systemctl >/dev/null 2>&1; then
    service_active="$(systemctl is-active canvas-notebook.service 2>/dev/null || true)"
  fi

  install_dir_json="$(json_escape "$INSTALL_DIR")"
  compose_file_json="$(json_escape "$COMPOSE_FILE")"
  data_dir_json="$(json_escape "${DATA_DIR:-}")"
  log_file_json="$(json_escape "$LOG_FILE")"
  service_active_json="$(json_escape "$service_active")"

  printf '{"healthy":%s,"serviceActive":"%s","installDir":"%s","composeFile":"%s","dataDir":"%s","managerLog":"%s","container":%s}\n' \
    "$healthy" "$service_active_json" "$install_dir_json" "$compose_file_json" "$data_dir_json" "$log_file_json" "$container_json"
}

diagnose_json() {
  local status mem_total mem_available disk_total disk_available
  mem_total="$(awk '/MemTotal/ {print $2 * 1024}' /proc/meminfo 2>/dev/null || printf 0)"
  mem_available="$(awk '/MemAvailable/ {print $2 * 1024}' /proc/meminfo 2>/dev/null || printf 0)"
  disk_total="$(df -P / 2>/dev/null | awk 'NR==2 {print $2 * 1024}' || printf 0)"
  disk_available="$(df -P / 2>/dev/null | awk 'NR==2 {print $4 * 1024}' || printf 0)"
  status="$(status_json)"
  printf '{"status":%s,"vm":{"memoryTotalBytes":%s,"memoryAvailableBytes":%s,"diskTotalBytes":%s,"diskAvailableBytes":%s}}\n' \
    "$status" "${mem_total:-0}" "${mem_available:-0}" "${disk_total:-0}" "${disk_available:-0}"
}

diagnose() {
  local cid url
  ensure_log_file
  log_msg "diagnose"
  url="$(health_url)"
  cid="$(container_id)"

  printf '\n== Canvas Notebook ==\n'
  printf 'Install dir: %s\n' "$INSTALL_DIR"
  printf 'Compose file: %s\n' "$COMPOSE_FILE"
  printf 'Manager log: %s\n' "$LOG_FILE"
  printf 'Health URL: %s\n' "$url"
  if curl -fsS "$url" >/dev/null 2>&1; then
    printf 'Health: ok\n'
  else
    printf 'Health: failed\n'
  fi

  printf '\n== VM resources ==\n'
  uptime || true
  free -h || true
  df -h / "$INSTALL_DIR" 2>/dev/null || df -h / || true

  printf '\n== Docker compose ==\n'
  compose_optional ps || true

  if [[ -n "$cid" ]]; then
    printf '\n== Container state ==\n'
    docker_cmd inspect --format 'Name={{.Name}} Status={{.State.Status}} Running={{.State.Running}} Restarting={{.State.Restarting}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} Started={{.State.StartedAt}} Finished={{.State.FinishedAt}} RestartCount={{.RestartCount}}' "$cid" 2>/dev/null || true

    printf '\n== Container resource snapshot ==\n'
    docker_cmd stats --no-stream "$cid" 2>/dev/null || true
  fi

  printf '\n== Recent container logs ==\n'
  compose_optional logs --tail="${TAIL:-120}" "$SERVICE" || true

  printf '\n== Possible OOM / kernel crash evidence ==\n'
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -k -b --no-pager 2>/dev/null | grep -Ei 'out of memory|oom|killed process|segfault|panic|watchdog' | tail -80 || true
    if journalctl --list-boots >/dev/null 2>&1; then
      printf '\n== Previous boot crash evidence ==\n'
      journalctl -k -b -1 --no-pager 2>/dev/null | grep -Ei 'out of memory|oom|killed process|segfault|panic|watchdog' | tail -80 || true
    fi
  else
    dmesg 2>/dev/null | grep -Ei 'out of memory|oom|killed process|segfault|panic|watchdog' | tail -80 || true
  fi

  local caddy_issues=0 diag_domain
  diag_domain="$(configured_domain)"

  printf '\n== Caddy configuration health ==\n'
  if [[ -f "/etc/caddy/Caddyfile" ]] && is_real_domain "$diag_domain"; then
    local escaped_domain dup_count
    escaped_domain="$(printf '%s' "$diag_domain" | sed 's/[.[\*^$]/\\&/g')"
    dup_count="$(grep -c "^${escaped_domain}[[:space:]]*{" /etc/caddy/Caddyfile 2>/dev/null || printf '0')"
    if [[ "$dup_count" -gt 0 ]]; then
      warn "Duplicate site definition: '${diag_domain}' found in /etc/caddy/Caddyfile (${dup_count} occurrence(s))"
      warn "This causes 'ambiguous site definition' errors in Caddy."
      caddy_issues=$((caddy_issues + 1))
    fi

    if [[ -f "/etc/caddy/conf.d/canvas-notebook.caddy" ]] && ! grep -q 'X-Forwarded-Port' /etc/caddy/conf.d/canvas-notebook.caddy 2>/dev/null; then
      warn "Missing X-Forwarded-Port header in /etc/caddy/conf.d/canvas-notebook.caddy"
      warn "This can cause redirect loops to port 3000 instead of 443."
      caddy_issues=$((caddy_issues + 1))
    fi

    if [[ "$caddy_issues" -gt 0 ]]; then
      printf '\n'
      warn "Caddy issues detected (${caddy_issues}). Run: canvas-notebook caddy-fix"
    else
      ok "No known Caddy configuration issues detected."
    fi
  else
    info "No public domain configured or no Caddyfile found — skipping Caddy health check."
  fi
}

cmd_status() {
  if [[ "$OUTPUT_JSON" == "true" ]]; then
    status_json
  else
    compose ps
  fi
}

cmd_ps() {
  cmd_status
}

cmd_health() {
  log_msg "health"
  if curl -fsS "$(health_url)" >/dev/null 2>&1; then
    if [[ "$OUTPUT_JSON" == "true" ]]; then
      printf '{"healthy":true}\n'
    else
      curl -fsS "$(health_url)" && printf '\n'
    fi
  else
    if [[ "$OUTPUT_JSON" == "true" ]]; then
      printf '{"healthy":false}\n'
    fi
    exit 1
  fi
}

cmd_diagnose() {
  if [[ "$OUTPUT_JSON" == "true" ]]; then
    diagnose_json
  else
    diagnose
  fi
}

cmd_config() {
  ensure_log_file
  printf 'Install dir: %s\nCompose file: %s\nData dir: %s\nConfig file: %s\nContainer env: %s\nCompose env: %s\nManager log: %s\n' "$INSTALL_DIR" "$COMPOSE_FILE" "${DATA_DIR:-}" "$CONFIG_JSON_PATH" "$CONFIG_ENV_PATH" "$COMPOSE_ENV_PATH" "$LOG_FILE"
}