#!/usr/bin/env bash
[[ -n "${_SHARED_COMPOSE_LOADED:-}" ]] && return 0
_SHARED_COMPOSE_LOADED=1

compose_optional() {
  if docker info >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" --project-directory "$INSTALL_DIR" "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker compose -f "$COMPOSE_FILE" --project-directory "$INSTALL_DIR" "$@"
  else
    return 1
  fi
}

compose() {
  compose_optional "$@" || fail "Docker is not reachable. Try logging out/in for docker group changes, or run with a user that can access Docker."
}

run_compose() {
  log_msg "compose $*"
  compose "$@" 2>&1 | tee -a "$LOG_FILE"
  return "${PIPESTATUS[0]}"
}

compose_env_value() {
  local key="$1"
  sed -n -E "/^[[:space:]]*${key}:/ {
    s|^[^:]*:[[:space:]]*||
    s|[[:space:]]+#.*$||
    s|^[\"']||
    s|[\"'][[:space:]]*$||
    s|[[:space:]]*$||
    p
    q
  }" "$COMPOSE_FILE"
}

configured_base_url() {
  local url
  url="$(compose_env_value BETTER_AUTH_BASE_URL)"
  if [[ -z "$url" ]]; then
    url="$(compose_env_value BASE_URL)"
  fi
  printf '%s\n' "$url"
}

configured_domain() {
  local url
  url="$(configured_base_url)"
  printf '%s\n' "$url" | sed -E 's|^https?://||' | cut -d/ -f1 | cut -d: -f1
}

host_port() {
  compose_optional port "$SERVICE" 3000 2>/dev/null | tail -1 | awk -F: '{print $NF}' || true
}

health_url() {
  local port
  port="$(host_port)"
  port="${port:-3456}"
  printf 'http://127.0.0.1:%s/api/health\n' "$port"
}

container_id() {
  compose_optional ps -q "$SERVICE" 2>/dev/null || true
}