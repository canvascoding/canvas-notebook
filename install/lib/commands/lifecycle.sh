#!/usr/bin/env bash

cmd_start() {
  log_msg "start"
  run_compose up -d "$SERVICE"
  wait_until_healthy
}

cmd_restart() {
  log_msg "restart"
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