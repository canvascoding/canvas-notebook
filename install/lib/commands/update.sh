#!/usr/bin/env bash

if ! declare -f cli_update_reexec_if_changed >/dev/null 2>&1; then
  _cli_update_command_file="${CMD_DIR:-${INSTALL_DIR}/lib/commands}/cli_update.sh"
  if [[ -f "$_cli_update_command_file" ]]; then
    . "$_cli_update_command_file"
  fi
  unset _cli_update_command_file
fi

cmd_install() {
  log_msg "install started"

  if [[ -f "${CANVAS_POSTGRES_RECONCILE_JOURNAL:-${INSTALL_DIR}/.postgres-auth-reconcile.json}" ]]; then
    fail "An interrupted Postgres auth reconciliation is pending. Run database reconcile-postgres-auth first."
  fi

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    info "No config.json found — running migration"
    config_json_migrate
  fi

  migrate_compose_file
  CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=true config_json_to_env
  postgres_prepare_managed_runtime

  info "Phase 1/3: Image"
  pull_image_if_needed "compose" "$IMAGE_REF" "$SERVICE" "$LOG_FILE" "$COMPOSE_FILE"
  info "Phase 2/3: Container"
  recreate_container
  info "Phase 3/3: Health check"
  follow_until_healthy
  cleanup_docker_artifacts
  log_msg "install completed"
}

container_running() {
  local cid="$1"
  [[ -n "$cid" ]] && [[ "$(docker_cmd inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || true)" == "true" ]]
}

container_needs_update_recreate() {
  local cid running_image current_image

  cid="$(container_id)"
  if [[ -z "$cid" ]]; then
    info "No existing container found."
    return 0
  fi

  if ! container_running "$cid"; then
    info "Existing container is not running."
    return 0
  fi

  current_image="$(image_id "$IMAGE_REF")"
  running_image="$(container_image_id "$cid")"
  if [[ -z "$current_image" || -z "$running_image" || "$current_image" != "$running_image" ]]; then
    info "Running container image differs from the current image."
    return 0
  fi

  if ! canvas_health_probe "$(health_url)" 2; then
    warn "Running container uses the current image but is not healthy."
    return 0
  fi

  return 1
}

_update_validate_pinned_image() {
  local image_ref="$1"
  [[ "$image_ref" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$ ]]
}

_update_finalize_pinned_image() {
  local target_image="$1" previous_config_image="$2" target_image_id
  if [[ "$previous_config_image" == *@sha256:* ]]; then
    config_json_write image "$target_image"
  else
    target_image_id="$(image_id "$target_image")"
    [[ -n "$target_image_id" ]] || return 1
    docker_cmd image tag "$target_image_id" "$previous_config_image" >/dev/null 2>&1 || return 1
    config_json_write image "$previous_config_image"
  fi
  CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env
}

_update_deadline_init() {
  local raw_deadline="${CANVAS_UPDATE_DEADLINE_EPOCH_MS:-}" reserve="${CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS:-120}" now
  if ! [[ "$reserve" =~ ^[1-9][0-9]*$ ]] || [[ "$reserve" -lt 30 || "$reserve" -gt 1800 ]]; then
    _update_failure arguments false "CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS must be an integer from 30 to 1800 seconds."
    return 1
  fi
  CANVAS_UPDATE_DEADLINE_SECONDS=0
  CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS_EFFECTIVE="$reserve"
  if [[ -z "$raw_deadline" ]]; then
    return 0
  fi
  if ! [[ "$raw_deadline" =~ ^[1-9][0-9]{12,15}$ ]]; then
    _update_failure arguments false "CANVAS_UPDATE_DEADLINE_EPOCH_MS must be a future epoch-millisecond deadline."
    return 1
  fi
  CANVAS_UPDATE_DEADLINE_SECONDS=$((raw_deadline / 1000))
  now="$(date +%s)"
  if [[ "$CANVAS_UPDATE_DEADLINE_SECONDS" -le $((now + reserve)) ]]; then
    _update_failure arguments false "CANVAS_UPDATE_DEADLINE_EPOCH_MS must extend beyond the rollback reserve."
    return 1
  fi
}

_update_forward_budget() {
  local now remaining
  if [[ "${CANVAS_UPDATE_DEADLINE_SECONDS:-0}" -eq 0 ]]; then
    printf '0\n'
    return 0
  fi
  now="$(date +%s)"
  remaining=$((CANVAS_UPDATE_DEADLINE_SECONDS - now - CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS_EFFECTIVE))
  [[ "$remaining" -ge 1 ]] || return 1
  printf '%s\n' "$remaining"
}

_update_forward_deadline() {
  if [[ "${CANVAS_UPDATE_DEADLINE_SECONDS:-0}" -eq 0 ]]; then
    printf '0\n'
  else
    printf '%s\n' "$((CANVAS_UPDATE_DEADLINE_SECONDS - CANVAS_UPDATE_ROLLBACK_RESERVE_SECONDS_EFFECTIVE))"
  fi
}

_update_rollback_budget() {
  local now remaining
  if [[ "${CANVAS_UPDATE_DEADLINE_SECONDS:-0}" -eq 0 ]]; then
    printf '0\n'
    return 0
  fi
  now="$(date +%s)"
  remaining=$((CANVAS_UPDATE_DEADLINE_SECONDS - now))
  [[ "$remaining" -ge 1 ]] || return 1
  printf '%s\n' "$remaining"
}

_update_forward_health_attempts() {
  local budget attempts="$DEFAULT_HEALTH_ATTEMPTS"
  budget="$(_update_forward_budget)" || return 1
  if [[ "$budget" -gt 0 && "$attempts" -gt "$budget" ]]; then
    attempts="$budget"
  fi
  [[ "$attempts" -ge 1 ]] || return 1
  printf '%s\n' "$attempts"
}

_update_rollback_image() {
  local previous_image_id="$1" previous_config_image="$2" timeout_seconds rollback_pid started_at
  [[ -n "$previous_image_id" && -n "$previous_config_image" ]] || return 1
  if [[ "$previous_config_image" != *@sha256:* ]]; then
    docker_cmd image tag "$previous_image_id" "$previous_config_image" >/dev/null 2>&1 || return 1
  fi
  config_json_write image "$previous_config_image"
  CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env
  timeout_seconds="$(_update_rollback_budget)" || return 1
  CANVAS_IMAGE="$previous_image_id" compose up -d --force-recreate --no-deps "$SERVICE" &
  rollback_pid=$!
  started_at="$SECONDS"
  while kill -0 "$rollback_pid" 2>/dev/null; do
    if [[ "$timeout_seconds" -gt 0 && $((SECONDS - started_at)) -ge "$timeout_seconds" ]]; then
      kill "$rollback_pid" >/dev/null 2>&1 || true
      sleep 1
      kill -9 "$rollback_pid" >/dev/null 2>&1 || true
      wait "$rollback_pid" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 0.1
  done
  wait "$rollback_pid" || return 1
  timeout_seconds="$(_update_rollback_budget)" || return 1
  if [[ "$timeout_seconds" -eq 0 || "$timeout_seconds" -gt "$DEFAULT_HEALTH_ATTEMPTS" ]]; then
    timeout_seconds="$DEFAULT_HEALTH_ATTEMPTS"
  fi
  if wait_until_healthy "$timeout_seconds" "${CANVAS_UPDATE_DEADLINE_SECONDS:-0}"; then
    CANVAS_UPDATE_TRANSACTION_ROLLED_BACK=true
    return 0
  fi
  return 1
}

_update_failure() {
  local phase="$1" rolled_back="$2" message="$3"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    jq -nc --arg phase "$phase" --arg error "$message" --argjson rolledBack "$rolled_back" \
      '{success:false, phase:$phase, error:$error, rolledBack:$rolledBack}'
  else
    printf '✗ %s\n' "$message" >&2
  fi
  return 1
}

_update_print_phase_output() {
  local output="$1"
  if [[ "${OUTPUT_JSON:-false}" != "true" && -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
}

cmd_update() {
  local health_check_mode previous_container previous_image_id previous_config_image phase_output rollback_output
  local requested_image="" target_image auth_output auth_rolled_back=false arg index=0 require_pinned=false
  local applied_new_image=false recreated=false
  local auth_timeout forward_budget forward_deadline health_attempts
  local args=("$@")

  CANVAS_UPDATE_TRANSACTION_ACTIVE=false
  CANVAS_UPDATE_TRANSACTION_APPLIED=false
  CANVAS_UPDATE_TRANSACTION_COMMITTED=false
  CANVAS_UPDATE_TRANSACTION_ROLLED_BACK=false

  canvas_operation_cleanup_before_unlock() {
    if [[ "${CANVAS_UPDATE_TRANSACTION_ACTIVE:-false}" != "true" || "${CANVAS_UPDATE_TRANSACTION_COMMITTED:-false}" == "true" ]]; then
      return 0
    fi
    if [[ "${CANVAS_UPDATE_TRANSACTION_APPLIED:-false}" == "true" && "${CANVAS_UPDATE_TRANSACTION_ROLLED_BACK:-false}" != "true" ]]; then
      if ! _update_rollback_image "${CANVAS_UPDATE_TRANSACTION_PREVIOUS_IMAGE_ID:-}" "${CANVAS_UPDATE_TRANSACTION_PREVIOUS_CONFIG_IMAGE:-}" >/dev/null 2>&1; then
        printf '✗ Update cleanup could not restore the previous running image.\n' >&2
      fi
    fi
    if [[ -n "${CANVAS_UPDATE_TRANSACTION_PREVIOUS_CONFIG_IMAGE:-}" ]]; then
      config_json_write image "$CANVAS_UPDATE_TRANSACTION_PREVIOUS_CONFIG_IMAGE" >/dev/null 2>&1 || true
      CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env >/dev/null 2>&1 || true
    fi
  }

  while [[ "$index" -lt "${#args[@]}" ]]; do
    arg="${args[$index]}"
    case "$arg" in
      --image)
        index=$((index + 1))
        if [[ "$index" -ge "${#args[@]}" ]]; then
          _update_failure arguments false "Missing value for --image."
          return 1
        fi
        requested_image="${args[$index]}"
        ;;
      --image=*) requested_image="${arg#--image=}" ;;
      --require-pinned) require_pinned=true ;;
      *)
        _update_failure arguments false "Unknown update option: ${arg}"
        return 1
        ;;
    esac
    index=$((index + 1))
  done
  if [[ -n "$requested_image" ]] && ! _update_validate_pinned_image "$requested_image"; then
    _update_failure arguments false "--image must be an OCI image name pinned to a sha256 digest."
    return 1
  fi
  _update_deadline_init || return 1

  log_msg "update started"
  if declare -f cli_update_reexec_if_changed >/dev/null 2>&1; then
    cli_update_reexec_if_changed update "$@"
  fi
  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    info "No config.json found — running migration"
    config_json_migrate
  fi

  previous_config_image="$(config_json_read image)"
  previous_config_image="${previous_config_image:-$IMAGE_REF}"
  CANVAS_UPDATE_TRANSACTION_ACTIVE=true
  CANVAS_UPDATE_TRANSACTION_PREVIOUS_CONFIG_IMAGE="$previous_config_image"
  target_image="${requested_image:-$previous_config_image}"
  if { [[ "$require_pinned" == "true" ]] || config_json_managed_by_control_plane; } && ! _update_validate_pinned_image "$target_image"; then
    _update_failure arguments false "Managed and scheduled updates require an image pinned to a sha256 digest."
    return 1
  fi
  migrate_compose_file
  IMAGE_REF="$target_image"

  if postgres_runtime_desired; then
    if ! declare -f _database_reconcile_postgres_auth >/dev/null 2>&1; then
      . "${CMD_DIR:-${INSTALL_DIR}/lib/commands}/database.sh"
    fi
    auth_timeout="${CANVAS_UPDATE_POSTGRES_TIMEOUT:-900}"
    if ! [[ "$auth_timeout" =~ ^[1-9][0-9]*$ ]] || [[ "$auth_timeout" -gt 7200 ]]; then
      _update_failure arguments false "CANVAS_UPDATE_POSTGRES_TIMEOUT must be an integer from 1 to 7200 seconds."
      return 1
    fi
    forward_budget="$(_update_forward_budget)" || { _update_failure deadline false "Update deadline reached before Postgres reconciliation."; return 1; }
    if [[ "$forward_budget" -gt 0 && "$auth_timeout" -gt "$forward_budget" ]]; then
      auth_timeout="$forward_budget"
    fi
    if ! auth_output="$(_database_reconcile_postgres_auth --timeout "$auth_timeout" 2>&1)"; then
      if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
        auth_rolled_back="$(printf '%s\n' "$auth_output" | tail -1 | jq -r '.rolledBack // false' 2>/dev/null || printf false)"
      fi
      _update_failure postgres_auth "$auth_rolled_back" "Postgres credential reconciliation failed before image update."
      return 1
    fi
  else
    CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env
  fi
  previous_container="$(container_id)"
  previous_image_id="$(container_image_id "$previous_container")"
  CANVAS_UPDATE_TRANSACTION_PREVIOUS_IMAGE_ID="$previous_image_id"

  info "Phase 1/3: Image"
  forward_budget="$(_update_forward_budget)" || { _update_failure deadline false "Update deadline reached before image pull."; return 1; }
  if ! phase_output="$(CANVAS_IMAGE="$target_image" pull_image_if_needed "compose" "$IMAGE_REF" "$SERVICE" "$LOG_FILE" "$COMPOSE_FILE" "$forward_budget" 2>&1)"; then
    CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env >/dev/null 2>&1 || true
    _update_failure pull false "Image pull failed; the running container was not changed."
    return 1
  fi
  _update_print_phase_output "$phase_output"
  info "Phase 2/3: Container"
  if container_needs_update_recreate; then
    applied_new_image=true
    forward_budget="$(_update_forward_budget)" || { _update_failure deadline false "Update deadline reached before container apply."; return 1; }
    CANVAS_UPDATE_TRANSACTION_APPLIED=true
    if ! phase_output="$(CANVAS_IMAGE="$target_image" recreate_container "$forward_budget" 2>&1)"; then
      if rollback_output="$(_update_rollback_image "$previous_image_id" "$previous_config_image" 2>&1)"; then
        CANVAS_UPDATE_TRANSACTION_ROLLED_BACK=true
        _update_print_phase_output "$rollback_output"
        _update_failure apply true "Update apply failed; the previous image was restored."
      else
        _update_failure rollback_failed false "Update apply failed and the previous image could not be restored."
      fi
      return 1
    fi
    _update_print_phase_output "$phase_output"
    recreated=true
    health_check_mode="follow"
  else
    ok "Container already runs the current healthy image; skipping recreate"
    log_msg "container recreate skipped: already running current healthy image"
    health_check_mode="wait"
  fi
  info "Phase 3/3: Health check"
  if ! health_attempts="$(_update_forward_health_attempts)"; then
    if [[ "$applied_new_image" == "true" ]] && rollback_output="$(_update_rollback_image "$previous_image_id" "$previous_config_image" 2>&1)"; then
      CANVAS_UPDATE_TRANSACTION_ROLLED_BACK=true
      _update_print_phase_output "$rollback_output"
      _update_failure deadline true "Update deadline reached before health verification; the previous image was restored."
    elif [[ "$applied_new_image" == "true" ]]; then
      _update_failure rollback_failed false "Update deadline reached and the previous image could not be restored."
    else
      _update_failure deadline false "Update deadline reached before health verification."
    fi
    return 1
  fi
  forward_deadline="$(_update_forward_deadline)"
  if [[ "$health_check_mode" == "follow" ]]; then
    if ! phase_output="$(follow_until_healthy "$health_attempts" "$forward_deadline" 2>&1)"; then
      if [[ "$applied_new_image" == "true" ]] && rollback_output="$(_update_rollback_image "$previous_image_id" "$previous_config_image" 2>&1)"; then
        CANVAS_UPDATE_TRANSACTION_ROLLED_BACK=true
        _update_print_phase_output "$rollback_output"
        _update_failure health true "Updated image was unhealthy; the previous image was restored."
      elif [[ "$applied_new_image" == "true" ]]; then
        _update_failure rollback_failed false "Updated image was unhealthy and the previous image could not be restored."
      else
        _update_failure health false "Canvas Notebook did not become healthy after update."
      fi
      return 1
    fi
    _update_print_phase_output "$phase_output"
  else
    if ! phase_output="$(wait_until_healthy "$health_attempts" "$forward_deadline" 2>&1)"; then
      _update_failure health false "Canvas Notebook did not remain healthy after update."
      return 1
    fi
    _update_print_phase_output "$phase_output"
  fi
  if [[ -n "$requested_image" ]]; then
    if ! _update_forward_budget >/dev/null; then
      if [[ "$applied_new_image" == "true" ]] && rollback_output="$(_update_rollback_image "$previous_image_id" "$previous_config_image" 2>&1)"; then
        CANVAS_UPDATE_TRANSACTION_ROLLED_BACK=true
        _update_print_phase_output "$rollback_output"
        _update_failure deadline true "Update deadline reached before finalization; the previous image was restored."
      elif [[ "$applied_new_image" == "true" ]]; then
        _update_failure rollback_failed false "Update deadline reached and the previous image could not be restored."
      else
        _update_failure deadline false "Update deadline reached before pinned image finalization."
      fi
      return 1
    fi
    if ! _update_finalize_pinned_image "$target_image" "$previous_config_image"; then
      if [[ "$applied_new_image" == "true" ]] && rollback_output="$(_update_rollback_image "$previous_image_id" "$previous_config_image" 2>&1)"; then
        CANVAS_UPDATE_TRANSACTION_ROLLED_BACK=true
        _update_print_phase_output "$rollback_output"
        _update_failure finalize true "Pinned image finalization failed; the previous image was restored."
      elif [[ "$applied_new_image" == "true" ]]; then
        _update_failure rollback_failed false "Pinned image finalization failed and the previous image could not be restored."
      else
        CANVAS_ALLOW_POSTGRES_SECRET_GENERATION=false config_json_to_env >/dev/null 2>&1 || true
        _update_failure finalize false "Pinned image finalization failed; the running container was not changed."
      fi
      return 1
    fi
  fi
  CANVAS_UPDATE_TRANSACTION_COMMITTED=true
  cleanup_docker_artifacts
  log_msg "update completed"
  if [[ "${OUTPUT_JSON:-false}" == "true" ]]; then
    jq -nc --argjson recreated "$recreated" '{success:true, recreated:$recreated, healthy:true, rolledBack:false}'
  fi
}
