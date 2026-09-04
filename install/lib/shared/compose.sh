#!/usr/bin/env bash
[[ -n "${_SHARED_COMPOSE_LOADED:-}" ]] && return 0
_SHARED_COMPOSE_LOADED=1

canvas_compose_image_override_is_safe() {
  local image_ref="$1"
  [[ "${#image_ref}" -le 512 ]] || return 1
  [[ "$image_ref" =~ ^sha256:[a-f0-9]{64}$ ]] && return 0
  [[ "$image_ref" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$ ]]
}

canvas_compose_install_dir_is_safe() {
  local install_dir="$1"
  [[ -n "$install_dir" && "${#install_dir}" -le 4096 && "$install_dir" == /* && \
    "$install_dir" != *$'\n'* && "$install_dir" != *$'\r'* ]]
}

compose_optional() {
  local config_requires_root=false
  if [[ "$(id -u)" -ne 0 ]] && { [[ -f "$CONFIG_ENV_PATH" && ! -r "$CONFIG_ENV_PATH" ]] || [[ -f "$COMPOSE_ENV_PATH" && ! -r "$COMPOSE_ENV_PATH" ]]; }; then
    config_requires_root=true
  fi
  if [[ "$config_requires_root" != "true" ]] && docker info >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" --project-directory "$INSTALL_DIR" "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    canvas_compose_install_dir_is_safe "$INSTALL_DIR" || return 1
    if [[ -n "${CANVAS_IMAGE:-}" ]]; then
      canvas_compose_image_override_is_safe "$CANVAS_IMAGE" || return 1
      sudo env "CANVAS_INSTALL_DIR=$INSTALL_DIR" "CANVAS_IMAGE=$CANVAS_IMAGE" docker compose -f "$COMPOSE_FILE" --project-directory "$INSTALL_DIR" "$@"
    else
      sudo env "CANVAS_INSTALL_DIR=$INSTALL_DIR" docker compose -f "$COMPOSE_FILE" --project-directory "$INSTALL_DIR" "$@"
    fi
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
  if [[ -f "$CONFIG_JSON_PATH" ]]; then
    local val
    val="$(config_json_read "env.${key}" 2>/dev/null || true)"
    if [[ -n "$val" ]]; then
      printf '%s\n' "$val"
      return
    fi
  fi
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
  url="$(config_json_read env.BETTER_AUTH_BASE_URL 2>/dev/null || true)"
  if [[ -n "$url" ]]; then
    printf '%s\n' "$url"
    return
  fi
  url="$(config_json_read env.BASE_URL 2>/dev/null || true)"
  if [[ -n "$url" ]]; then
    printf '%s\n' "$url"
    return
  fi
  local domain
  domain="$(config_json_read domain 2>/dev/null || true)"
  if [[ -n "$domain" ]]; then
    printf 'https://%s\n' "$domain"
    return
  fi
  url="$(compose_env_value BETTER_AUTH_BASE_URL)"
  if [[ -n "$url" ]]; then
    printf '%s\n' "$url"
    return
  fi
  compose_env_value BASE_URL
}

configured_domain() {
  local url
  url="$(configured_base_url)"
  printf '%s\n' "$url" | sed -E 's|^https?://||' | cut -d/ -f1 | cut -d: -f1
}

ensure_env_file() {
  if [[ ! -f "$CONFIG_ENV_PATH" ]] || [[ ! -f "$COMPOSE_ENV_PATH" ]]; then
    config_json_to_env
  fi
}

write_managed_compose_file() {
  local dest="$1" tmp rendered updater_enabled updater_gid
  tmp="$(mktemp)"
  cat > "$tmp" <<'EOCOMPOSE'
services:
  canvas-notebook:
    container_name: canvas-notebook
    image: ${CANVAS_IMAGE:-ghcr.io/canvascoding/canvas-notebook:latest}
    ports:
      - "${HOST_PORT:-3456}:${CONTAINER_PORT:-3000}"
    env_file:
      - ${CANVAS_INSTALL_DIR:-/opt/canvas-notebook}/canvas-notebook.env
    # __CANVAS_UPDATER_GROUP__
    depends_on:
      postgres:
        condition: service_healthy
        required: false
    volumes:
      - ${DATA_DIR:-./data}:/data
      # __CANVAS_UPDATER_VOLUME__
    restart: unless-stopped

  postgres:
    profiles:
      - postgres
    container_name: canvas-notebook-postgres
    image: ${CANVAS_POSTGRES_IMAGE:-pgvector/pgvector:0.8.3-pg18}
    environment:
      POSTGRES_DB: ${CANVAS_POSTGRES_DB:-canvas_notebook}
      POSTGRES_USER: ${CANVAS_POSTGRES_USER:-canvas}
      POSTGRES_PASSWORD: ${CANVAS_POSTGRES_PASSWORD:-unused-sqlite-profile-disabled}
    volumes:
      - canvas-postgres-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  canvas-postgres-data:
    name: ${CANVAS_POSTGRES_DATA_VOLUME:-canvas-postgres-data}
EOCOMPOSE

  updater_enabled="$(config_json_read env.CANVAS_STANDALONE_UPDATER_ENABLED 2>/dev/null || true)"
  updater_gid="$(config_json_read env.CANVAS_UPDATER_GID 2>/dev/null || true)"
  rendered="$(mktemp)"
  awk -v enabled="$updater_enabled" -v gid="$updater_gid" '
    /# __CANVAS_UPDATER_GROUP__/ {
      if (enabled == "true" && gid ~ /^[0-9]+$/) {
        print "    group_add:"
        print "      - \"${CANVAS_UPDATER_GID:?CANVAS_UPDATER_GID is required for standalone updates}\""
      }
      next
    }
    /# __CANVAS_UPDATER_VOLUME__/ {
      if (enabled == "true" && gid ~ /^[0-9]+$/) {
        print "      - /run/canvas-notebook-updater.sock:/run/canvas-notebook-updater.sock"
      }
      next
    }
    { print }
  ' "$tmp" > "$rendered"
  mv "$rendered" "$tmp"

  _write_owned_file "$dest" "$tmp"
  rm -f "$tmp"
}

host_port() {
  local port
  port="$(config_json_read hostPort 2>/dev/null || true)"
  printf '%s\n' "${port:-3456}"
}

health_url() {
  local port
  port="$(host_port)"
  printf 'http://127.0.0.1:%s/api/health\n' "$port"
}

container_id() {
  compose_optional ps -q "$SERVICE" 2>/dev/null || true
}

migrate_compose_file() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    section "Compose file"
    info "Creating ${COMPOSE_FILE}..."
    write_managed_compose_file "$COMPOSE_FILE"
    ok "Created ${COMPOSE_FILE} with managed app and optional Postgres services"
    return 0
  fi

  local needs_migration=false

  if ! grep -q 'container_name:' "$COMPOSE_FILE" 2>/dev/null; then
    needs_migration=true
  fi

  if ! grep -q 'env_file:' "$COMPOSE_FILE" 2>/dev/null; then
    needs_migration=true
  fi

  if ! grep -q 'canvas-notebook-postgres' "$COMPOSE_FILE" 2>/dev/null; then
    needs_migration=true
  fi

  if [[ "$needs_migration" != "true" ]]; then
    return 0
  fi

  section "Migrating Compose file"
  info "Updating ${COMPOSE_FILE} to new format..."

  if [[ -f "$COMPOSE_FILE" ]]; then
    local backup="${COMPOSE_FILE}.bak"
    _write_owned_file "$backup" "$COMPOSE_FILE"
    ok "Backed up existing file to ${backup}"
  fi

  write_managed_compose_file "$COMPOSE_FILE"
  ok "Updated ${COMPOSE_FILE} with managed app and optional Postgres services"
}
