#!/usr/bin/env bash

cmd_install() {
  log_msg "install started"

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    info "No config.json found — running migration"
    config_json_migrate
  fi

  migrate_compose_file
  config_json_to_env

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

  if ! curl -fsS "$(health_url)" >/dev/null 2>&1; then
    warn "Running container uses the current image but is not healthy."
    return 0
  fi

  return 1
}

cmd_update() {
  local health_check_mode

  log_msg "update started"

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    info "No config.json found — running migration"
    config_json_migrate
  fi

  migrate_compose_file
  config_json_to_env

  info "Phase 1/3: Image"
  pull_image_if_needed "compose" "$IMAGE_REF" "$SERVICE" "$LOG_FILE" "$COMPOSE_FILE"
  info "Phase 2/3: Container"
  if container_needs_update_recreate; then
    recreate_container
    health_check_mode="follow"
  else
    ok "Container already runs the current healthy image; skipping recreate"
    log_msg "container recreate skipped: already running current healthy image"
    health_check_mode="wait"
  fi
  info "Phase 3/3: Health check"
  if [[ "$health_check_mode" == "follow" ]]; then
    follow_until_healthy
  else
    wait_until_healthy
  fi
  cleanup_docker_artifacts
  log_msg "update completed"
}
