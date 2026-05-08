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
  pull_image_if_needed "compose" "$IMAGE_REF" "$SERVICE" "$LOG_FILE"
  info "Phase 2/3: Container"
  recreate_container
  info "Phase 3/3: Health check"
  follow_until_healthy
  cleanup_docker_artifacts
  log_msg "install completed"
}

cmd_update() {
  log_msg "update started"

  if [[ ! -f "$CONFIG_JSON_PATH" ]]; then
    info "No config.json found — running migration"
    config_json_migrate
  fi

  migrate_compose_file
  config_json_to_env

  info "Phase 1/3: Image"
  pull_image_if_needed "compose" "$IMAGE_REF" "$SERVICE" "$LOG_FILE"
  info "Phase 2/3: Container"
  recreate_container
  info "Phase 3/3: Health check"
  follow_until_healthy
  cleanup_docker_artifacts
  log_msg "update completed"
}