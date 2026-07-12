#!/usr/bin/env bash

_env_error() {
  local phase="$1" message="$2"
  if [[ "$OUTPUT_JSON" == "true" ]]; then
    jq -nc --arg phase "$phase" --arg error "$message" '{success:false, phase:$phase, error:$error}'
  else
    printf '✗ %s\n' "$message" >&2
  fi
  return 1
}

_env_run_phase() {
  local phase="$1" message="$2" output
  shift 2
  if ! output="$("$@" 2>&1)"; then
    if [[ "$OUTPUT_JSON" != "true" && -n "$output" ]]; then
      printf '%s\n' "$output" >&2
    fi
    _env_error "$phase" "$message"
    return 1
  fi
  if [[ "$OUTPUT_JSON" != "true" && -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

_env_run_postgres_reconcile() {
  local fallback_phase="$1" fallback_message="$2" output
  shift 2
  if ! output="$(_database_reconcile_postgres_auth "$@" 2>&1)"; then
    if [[ "$OUTPUT_JSON" == "true" ]] && printf '%s\n' "$output" | jq -e -s 'length == 1 and .[0].success == false' >/dev/null 2>&1; then
      printf '%s\n' "$output"
    else
      if [[ "$OUTPUT_JSON" != "true" && -n "$output" ]]; then
        printf '%s\n' "$output" >&2
      fi
      _env_error "$fallback_phase" "$fallback_message"
    fi
    return 1
  fi
  if [[ "$OUTPUT_JSON" != "true" && -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

_env_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 | awk '{print $NF}'
  else
    return 1
  fi
}

_env_file_state() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf 'missing\n'
    return
  fi
  _read_config_file "$file" | _env_sha256_stream
}

_env_wait_healthy() {
  local timeout_seconds="$1" attempt deadline remaining probe_timeout
  deadline=$(($(date +%s) + timeout_seconds))
  for ((attempt=1; attempt<=timeout_seconds; attempt++)); do
    remaining=$((deadline - $(date +%s)))
    [[ "$remaining" -ge 1 ]] || break
    probe_timeout=2
    [[ "$probe_timeout" -le "$remaining" ]] || probe_timeout="$remaining"
    if canvas_health_probe "$(health_url)" "$probe_timeout"; then
      return 0
    fi
    [[ $((deadline - $(date +%s))) -ge 1 ]] || break
    sleep 1
  done
  return 1
}

_env_render_files() {
  CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env
}

_env_show_json() {
  _read_config_file "$CONFIG_JSON_PATH" | config_json_mask_secrets
}

cmd_env() {
  local do_sync=false do_render=false do_edit=false timeout_set=false timeout_seconds="${CANVAS_ENV_SYNC_TIMEOUT:-900}"
  local arg before_config_env before_compose_env after_config_env after_compose_env files_changed=false
  local postgres_reconciled=false before_container before_started after_container after_started restarted=false
  local args=("$@") index=0

  while [[ "$index" -lt "${#args[@]}" ]]; do
    arg="${args[$index]}"
    case "$arg" in
      --sync) do_sync=true ;;
      --render) do_render=true ;;
      --edit) do_edit=true ;;
      --timeout)
        timeout_set=true
        index=$((index + 1))
        if [[ "$index" -ge "${#args[@]}" ]]; then
          _env_error arguments "Missing value for --timeout."
          return 1
        fi
        timeout_seconds="${args[$index]}"
        ;;
      --timeout=*) timeout_set=true; timeout_seconds="${arg#--timeout=}" ;;
      *)
        _env_error arguments "Unknown env option: ${arg}"
        return 1
        ;;
    esac
    index=$((index + 1))
  done

  if [[ "$do_sync" == "true" && "$do_render" == "true" ]]; then
    _env_error arguments "--render and --sync are mutually exclusive."
    return 1
  fi
  if [[ "$do_edit" == "true" && "$do_render" == "true" ]]; then
    _env_error arguments "--edit cannot be combined with --render."
    return 1
  fi
  if [[ "$do_edit" == "true" && "$OUTPUT_JSON" == "true" ]]; then
    _env_error arguments "--edit cannot be combined with --json."
    return 1
  fi
  if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || [[ "$timeout_seconds" -gt 7200 ]]; then
    _env_error arguments "--timeout must be an integer from 1 to 7200 seconds."
    return 1
  fi
  if [[ "$do_sync" != "true" && "$do_edit" != "true" && "$timeout_set" == "true" ]]; then
    _env_error arguments "--timeout requires --sync."
    return 1
  fi

  local recovery_journal="${CANVAS_POSTGRES_RECONCILE_JOURNAL:-${INSTALL_DIR}/.postgres-auth-reconcile.json}"
  if [[ -f "$recovery_journal" ]]; then
    if [[ "$do_sync" != "true" && "$do_edit" != "true" ]]; then
      _env_error recovery "An interrupted Postgres auth reconciliation is pending; env --render is blocked."
      return 1
    fi
    if ! declare -f _database_reconcile_postgres_auth >/dev/null 2>&1; then
      . "${CMD_DIR:-${INSTALL_DIR}/lib/commands}/database.sh"
    fi
    if ! _env_run_postgres_reconcile recovery "Interrupted Postgres auth reconciliation could not be completed." --timeout "$timeout_seconds"; then
      return 1
    fi
    postgres_reconciled=true
  elif [[ "$do_sync" == "true" || "$do_edit" == "true" ]] && postgres_runtime_desired && \
    [[ -f "$CONFIG_ENV_PATH" && -f "$COMPOSE_ENV_PATH" ]]; then
    if ! declare -f _database_reconcile_postgres_auth >/dev/null 2>&1; then
      . "${CMD_DIR:-${INSTALL_DIR}/lib/commands}/database.sh"
    fi
    if ! _env_run_postgres_reconcile postgres "Postgres credential reconciliation failed." --timeout "$timeout_seconds"; then
      return 1
    fi
    postgres_reconciled=true
  fi

  if [[ "$do_edit" == "true" ]]; then
    local editor
    editor="${EDITOR:-nano}"
    command -v "$editor" >/dev/null 2>&1 || editor="vi"
    if [[ -w "$CONFIG_JSON_PATH" ]]; then
      "$editor" "$CONFIG_JSON_PATH"
    else
      run_root "$editor" "$CONFIG_JSON_PATH"
    fi
    do_sync=true
  fi

  if [[ "$do_render" == "true" || "$do_sync" == "true" ]]; then
    before_config_env="$(_env_file_state "$CONFIG_ENV_PATH")"
    before_compose_env="$(_env_file_state "$COMPOSE_ENV_PATH")"
    if ! _env_run_phase render "Environment render failed." _env_render_files; then
      return 1
    fi
    after_config_env="$(_env_file_state "$CONFIG_ENV_PATH")"
    after_compose_env="$(_env_file_state "$COMPOSE_ENV_PATH")"
    if [[ "$before_config_env" != "$after_config_env" || "$before_compose_env" != "$after_compose_env" ]]; then
      files_changed=true
    fi
  fi

  if [[ "$do_render" == "true" ]]; then
    if [[ "$OUTPUT_JSON" == "true" ]]; then
      jq -nc --argjson filesChanged "$files_changed" '{success:true, rendered:true, restarted:false, filesChanged:$filesChanged}'
    else
      ok "Environment files rendered without restarting containers"
    fi
    return 0
  fi

  if [[ "$do_sync" == "true" ]]; then
    if ! _env_run_phase compose "Compose configuration failed." migrate_compose_file; then
      return 1
    fi
    if ! _env_run_phase caddy "Caddy synchronization failed." sync_caddy; then
      return 1
    fi
    if postgres_runtime_desired; then
      if [[ "$postgres_reconciled" != "true" ]]; then
        if ! _env_run_phase postgres "Postgres credential reconciliation failed." postgres_prepare_managed_runtime; then
          return 1
        fi
      fi
      postgres_reconciled=true
    fi
    before_container="$(container_id)"
    before_started="$(container_started_at "$before_container")"
    if ! _env_run_phase app "Canvas Notebook apply failed." compose up -d --no-deps "$SERVICE"; then
      return 1
    fi
    after_container="$(container_id)"
    after_started="$(container_started_at "$after_container")"
    if [[ "$before_container" != "$after_container" || "$before_started" != "$after_started" ]]; then
      restarted=true
    fi
    if ! _env_wait_healthy "$timeout_seconds"; then
      _env_error health "Canvas Notebook did not become healthy within ${timeout_seconds}s."
      return 1
    fi
    if [[ "$OUTPUT_JSON" == "true" ]]; then
      jq -nc \
        --argjson filesChanged "$files_changed" \
        --argjson restarted "$restarted" \
        --argjson postgresReconciled "$postgres_reconciled" \
        --argjson timeoutSeconds "$timeout_seconds" \
        '{success:true, rendered:true, restarted:$restarted, filesChanged:$filesChanged, postgresReconciled:$postgresReconciled, healthy:true, timeoutSeconds:$timeoutSeconds}'
    else
      ok "Canvas Notebook environment applied and healthy"
    fi
    return 0
  fi

  if [[ "$OUTPUT_JSON" == "true" ]]; then
    _env_show_json
    return
  fi

  section "Environment"
  info "Config: ${CONFIG_JSON_PATH}"
  info "Container env: ${CONFIG_ENV_PATH}"
  info "Compose env: ${COMPOSE_ENV_PATH}"
  echo
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    printf '%-30s %s\n' "KEY" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    local key val
    for key in domain image hostPort containerPort dataDir; do
      val="$(config_json_read "$key")"
      printf '%-30s %s\n' "$key" "${val:-(not set)}"
    done
    echo
    printf '%-30s %s\n' "ENV KEY" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    local env_key env_val
    while IFS= read -r env_key; do
      env_val="$(config_json_read "env.${env_key}")"
      if [[ "$env_key" == "DATABASE_URL" && -n "$env_val" ]]; then
        env_val="postgresql://***"
      elif config_json_env_key_is_secret "$env_key" && [[ -n "$env_val" ]]; then
        env_val="${env_val:0:4}***"
      fi
      printf '%-30s %s\n' "$env_key" "${env_val:-(not set)}"
    done < <(_read_config_file "$CONFIG_JSON_PATH" | jq -r '.env | keys[]')
    echo
    printf '%-30s %s\n' "SWAP" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    printf '%-30s %s\n' "swap.enabled" "$(config_json_read swap.enabled)"
    printf '%-30s %s\n' "swap.size" "$(config_json_read swap.size)"
    printf '%-30s %s\n' "swap.file" "$(config_json_read swap.file)"
    echo
    printf '%-30s %s\n' "AUTO-UPDATE" "VALUE"
    printf '%-30s %s\n' "-------------------------------" "-----------------------------------"
    printf '%-30s %s\n' "autoUpdate.enabled" "$(config_json_read autoUpdate.enabled)"
    printf '%-30s %s\n' "autoUpdate.schedule" "$(config_json_read autoUpdate.schedule)"
  else
    warn "config.json not found. Run: canvas-notebook config-migrate"
  fi
}
