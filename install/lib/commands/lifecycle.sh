#!/usr/bin/env bash

cmd_start() {
  log_msg "start"
  migrate_compose_file
  config_json_to_env
  ensure_env_file
  run_compose up -d "$SERVICE"
  wait_until_healthy
}

cmd_restart() {
  log_msg "restart"
  migrate_compose_file
  config_json_to_env
  ensure_env_file
  run_compose restart "$SERVICE"
  wait_until_healthy
}

cmd_stop() {
  log_msg "stop"
  run_compose stop "$SERVICE"
}

cmd_down() {
  log_msg "down"
  run_compose down
}