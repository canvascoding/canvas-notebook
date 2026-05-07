#!/usr/bin/env bash

cmd_env() {
  local editor
  editor="${EDITOR:-nano}"
  command -v "$editor" >/dev/null 2>&1 || editor="vi"
  "$editor" "$COMPOSE_FILE"
  sync_caddy_from_compose
  run_compose up -d --force-recreate "$SERVICE"
  follow_until_healthy
}